"""Mr.Robot adapter for the existing local Vesper bot. No secrets in this file.

Run only via the Discord Agent plugin; the existing GUI/news/KTX bot stays intact.
The PC credential never leaves the Node host. Discord identity comes from Gateway.
"""
import asyncio
import io
import json
import os
import runpy
import sys
import threading
import uuid

import discord
from discord import app_commands

PREFIX = '__MR_ROBOT_DISCORD__'
_output_lock = threading.Lock()
_bridge = None
_reader_started = False


def emit(value):
    with _output_lock:
        print(PREFIX + json.dumps(value, ensure_ascii=True), flush=True)


class Approval(discord.ui.View):
    def __init__(self, bridge, channel_id, request_id):
        super().__init__(timeout=110)
        self.bridge = bridge
        self.channel_id = channel_id
        self.request_id = request_id
        self.used = False

    async def interaction_check(self, interaction):
        return interaction.user.id == self.bridge.owner and interaction.channel_id == self.channel_id

    async def settle(self, interaction, approve):
        if self.used:
            await interaction.response.send_message('이미 처리된 승인입니다.', ephemeral=True)
            return
        self.used = True
        await interaction.response.defer(ephemeral=True)
        try:
            result = await self.bridge.request(interaction, 'approve', requestId=self.request_id, approve=approve)
            text = ('승인했습니다.' if approve else '거절했습니다.') if result.get('ok') else '승인 요청이 만료되었습니다.'
        except Exception:
            text = '승인 요청이 만료되었거나 PC 연결이 끊겼습니다.'
        await interaction.edit_original_response(content=text, view=None)
        self.stop()

    @discord.ui.button(label='이 작업 승인', style=discord.ButtonStyle.success)
    async def accept(self, interaction, button):
        await self.settle(interaction, True)

    @discord.ui.button(label='거절', style=discord.ButtonStyle.danger)
    async def reject(self, interaction, button):
        await self.settle(interaction, False)


class Bridge:
    def __init__(self, client):
        self.client = client
        self.owner = 0
        self.pending = {}
        self.active = {}
        self.loop = asyncio.get_running_loop()
        self.tree = app_commands.CommandTree(client)
        self.reader_started = False

    async def setup(self):
        global _bridge, _reader_started
        application = await self.client.application_info()
        # Team apps have one explicit team owner; membership alone is not authority.
        self.owner = application.team.owner_id if application.team else application.owner.id
        group = app_commands.Group(name='robot', description='내 PC의 Mr.Robot 에이전트')

        @group.command(name='ask', description='PC 에이전트에게 작업 요청 (소유자 전용)')
        @app_commands.describe(message='작업 내용', provider='models에서 확인한 공급자 ID', model='모델 ID', effort='추론 강도')
        @app_commands.choices(effort=[app_commands.Choice(name=v, value=v) for v in ('auto', 'low', 'medium', 'high')])
        async def ask(interaction: discord.Interaction, message: str, provider: str = '', model: str = '', effort: str = 'auto'):
            await self.execute(interaction, 'ask', text=message, providerId=provider, model=model, effort=effort)

        @group.command(name='stop', description='이 채널에서 요청한 작업 중지')
        async def stop(interaction: discord.Interaction):
            await self.execute(interaction, 'stop')

        @group.command(name='new', description='이 채널에서 새 대화 시작')
        async def new(interaction: discord.Interaction):
            await self.execute(interaction, 'new')

        @group.command(name='status', description='PC 연결과 작업 상태')
        async def status(interaction: discord.Interaction):
            await self.execute(interaction, 'status')

        @group.command(name='models', description='사용 가능한 공급자와 모델 ID')
        async def models(interaction: discord.Interaction):
            await self.execute(interaction, 'models')

        self.tree.add_command(group)
        # Merge the one owned root command through upsert. Never bulk-sync and
        # delete unrelated commands already registered by the existing bot.
        payload = group.to_dict(self.tree)
        await self.client.http.upsert_global_command(self.client.application_id, payload)
        _bridge = self
        if not _reader_started:
            threading.Thread(target=self.read_stdin, daemon=True, name='MrRobotBridgeInput').start()
            _reader_started = True

    def read_stdin(self):
        while True:
            line = sys.stdin.readline(1_100_000)
            target = _bridge
            if not line:
                if target and not target.loop.is_closed():
                    asyncio.run_coroutine_threadsafe(target.client.close(), target.loop)
                return
            try:
                payload = json.loads(line)
            except (ValueError, TypeError):
                continue
            if target and not target.loop.is_closed():
                target.loop.call_soon_threadsafe(target.receive, payload)

    def receive(self, value):
        future = self.pending.get(value.get('id'))
        if future and not future.done():
            if 'error' in value:
                future.set_exception(RuntimeError(str(value['error'])[:1000]))
            else:
                future.set_result(value.get('result'))
        elif value.get('event') == 'approval':
            interaction = self.active.get(str(value.get('channelId')))
            if interaction:
                task = self.loop.create_task(self.show_approval(interaction, value.get('data', {})))
                task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)

    async def show_approval(self, interaction, data):
        request_id = data.get('requestId')
        if not request_id:
            return
        summary = str(data.get('summary') or data.get('description') or data.get('tool') or 'PC 변경 작업')[:1400]
        await interaction.followup.send(
            'PC 작업 승인 필요\n' + discord.utils.escape_mentions(summary),
            ephemeral=True, allowed_mentions=discord.AllowedMentions.none(),
            view=Approval(self, interaction.channel_id, request_id))

    async def request(self, interaction, action, **params):
        if interaction.user.id != self.owner:
            raise PermissionError('봇 소유자만 사용할 수 있습니다.')
        if len(self.pending) >= 8:
            raise RuntimeError('요청이 많습니다. 잠시 후 다시 시도하세요.')
        request_id = uuid.uuid4().hex
        future = self.loop.create_future()
        self.pending[request_id] = future
        emit(dict(id=request_id, userId=str(interaction.user.id), channelId=str(interaction.channel_id), action=action, **params))
        try:
            return await asyncio.wait_for(future, 620 if action == 'ask' else 25)
        finally:
            self.pending.pop(request_id, None)

    async def execute(self, interaction, action, **params):
        if interaction.user.id != self.owner:
            await interaction.response.send_message('이 명령은 봇 소유자 전용입니다.', ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        channel = str(interaction.channel_id)
        if action == 'ask' and channel in self.active:
            await interaction.followup.send('처리 중입니다. /robot stop으로 중지할 수 있습니다.', ephemeral=True)
            return
        if action == 'ask':
            self.active[channel] = interaction
        try:
            result = await self.request(interaction, action, **params)
            text = result.get('text') or result.get('message') if isinstance(result, dict) else None
            text = text or json.dumps(result, ensure_ascii=False, indent=2)
            text = str(text)
            if len(text) > 1800:
                file = discord.File(io.BytesIO(text[:150_000].encode('utf-8')), filename='MrRobot-result.txt')
                await interaction.followup.send('작업 결과입니다.', file=file, ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
            else:
                await interaction.followup.send(discord.utils.escape_mentions(text) or '완료했습니다.', ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
        except Exception as error:
            # No raw Discord HTTP/token diagnostics returned to a channel.
            text = str(error) if isinstance(error, (RuntimeError, PermissionError)) else '연결 또는 응답 오류입니다. PC의 플러그인 상태를 확인하세요.'
            await interaction.followup.send(discord.utils.escape_mentions(text[:1500]), ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
        finally:
            if action == 'ask':
                self.active.pop(channel, None)


def main():
    settings = json.loads(sys.stdin.readline(16000))
    root = os.path.abspath(settings['botDirectory'])
    os.chdir(root)
    sys.path.insert(0, root)
    from bot.client import SecurityBotClient
    original_setup = SecurityBotClient.setup_hook
    original_ready = SecurityBotClient.on_ready
    original_disconnect = SecurityBotClient.on_disconnect if hasattr(SecurityBotClient, 'on_disconnect') else None

    async def setup(client):
        try:
            bridge = Bridge(client)
            client._mr_robot_bridge = bridge
            await bridge.setup()
            await original_setup(client)
        except Exception:
            emit({'event': 'error'})
            raise

    async def ready(client):
        await original_ready(client)
        bridge = client._mr_robot_bridge
        emit({'event': 'ready', 'owner': str(bridge.owner)})

    async def disconnected(client):
        emit({'event': 'disconnected'})
        if original_disconnect:
            await original_disconnect(client)

    SecurityBotClient.setup_hook = setup
    SecurityBotClient.on_ready = ready
    SecurityBotClient.on_disconnect = disconnected
    # Original single-instance lock, tray, news and KTX GUI are preserved.
    runpy.run_path(os.path.join(root, 'main.py'), run_name='__main__')


if __name__ == '__main__':
    main()
