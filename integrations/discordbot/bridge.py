"""Mr.Robot Discord plugin protocol. No secrets in this file.

Run only via the Discord Agent plugin. Standalone needs connection config only.
The PC credential never leaves the Node host. Discord identity comes from Gateway.
"""
import asyncio
import base64
import io
import json
import os
import sys
import threading
import uuid
from types import SimpleNamespace

import discord
from discord import app_commands
from thread_sessions import ThreadManager, MessageContext
from presentation import result_text, wants_files, message_chunks
from attachments import read_attachments

PREFIX = '__MR_ROBOT_DISCORD__'
_output_lock = threading.Lock()
_bridge = None
_reader_started = False


def allowed_guilds_from_store(guilds, configured_name, state_path):
    """Share the host's local allowlist; membership/invitation alone is not consent."""
    joined = {guild.id for guild in guilds}
    try:
        with open(state_path, encoding='utf-8-sig') as stream:
            state = json.load(stream)
        if not isinstance(state, dict):
            return set()
        if 'allowedGuildIds' in state:
            ids = state['allowedGuildIds']
            if not isinstance(ids, list):
                return set()
            return joined.intersection(int(value) for value in ids if isinstance(value, str) and value.isascii() and value.isdigit() and 15 <= len(value) <= 22)
    except FileNotFoundError:
        pass  # Legacy first-run bootstrap; the Node host separately pins the guild.
    except (OSError, ValueError, TypeError):
        return set()  # Corrupt/unreadable configuration must never widen access.
    candidates = [guild for guild in guilds if guild.name == configured_name] if configured_name else list(guilds)
    if not candidates and len(guilds) == 1:
        candidates = list(guilds)
    return {candidates[0].id} if len(candidates) == 1 else set()


def emit(value):
    with _output_lock:
        print(PREFIX + json.dumps(value, ensure_ascii=True), flush=True)


class Approval(discord.ui.View):
    def __init__(self, bridge, channel_id, request_id, user_id):
        super().__init__(timeout=110)
        self.bridge = bridge
        self.channel_id = channel_id
        self.request_id = request_id
        self.user_id = user_id
        self.used = False

    async def interaction_check(self, interaction):
        return interaction.user.id == self.user_id and interaction.channel_id == self.channel_id

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

    @discord.ui.button(label='작업 중지', style=discord.ButtonStyle.secondary)
    async def stop_work(self, interaction, button):
        await self.bridge.execute(interaction, 'stop')


class Bridge:
    def __init__(self, client):
        self.client = client
        self.owner = 0
        self.pending = {}
        self.active = {}
        self.progress_tasks = {}
        self.loop = asyncio.get_running_loop()
        self.tree = app_commands.CommandTree(client)
        self.reader_started = False
        self.allowed_guilds = set()
        self.authorization_path = os.path.join(os.environ.get('MR_ROBOT_HOME', os.path.join(os.path.expanduser('~'), '.mr-robot')), 'plugins', 'discord-agent.json')
        self.threads = ThreadManager(self, getattr(client, '_mr_robot_thread_state', None))

    @staticmethod
    def scope_key(interaction):
        return f'{interaction.guild_id}:{interaction.channel_id}:{interaction.user.id}'

    async def authorize(self, interaction, admin_only=False):
        if hasattr(self, 'authorization_path'):
            self.refresh_allowed_guilds()
        if interaction.guild_id not in self.allowed_guilds or not interaction.guild:
            raise PermissionError('등록된 Discord 서버에서만 사용할 수 있습니다. DM은 지원하지 않습니다.')
        if hasattr(self, 'threads'):
            self.threads.check_context(interaction)
        # Fetch current role assignments AND role permission bits, not cached
        # channel permissions. A renamed role or Manage Server is not Administrator.
        guild = await self.client.fetch_guild(interaction.guild_id)
        member = await guild.fetch_member(interaction.user.id)
        roles = await guild.fetch_roles()
        role_ids = set(member._roles)
        admin = member.id == guild.owner_id or any(role.permissions.administrator for role in roles if role.id in role_ids or role.id == guild.id)
        allowed = any(role.name == 'allow_ai' and role.id in role_ids for role in roles)
        if admin_only and not admin:
            raise PermissionError('Discord 서버의 관리자(Administrator) 권한이 필요합니다.')
        if not admin and not allowed:
            raise PermissionError('이용하려면 allow_ai 역할이 필요합니다.')
        return {'admin': admin, 'allowed': allowed}

    async def authorize_ticket(self, interaction):
        authority = await self.authorize(interaction)
        if not authority['allowed']:
            raise PermissionError('티켓을 열려면 서버 관리자가 allow_ai 역할을 먼저 부여해야 합니다.')

    def refresh_allowed_guilds(self):
        self.allowed_guilds = allowed_guilds_from_store(self.client.guilds, self.client.config.get('server_name', ''), self.authorization_path)

    async def setup(self):
        global _bridge, _reader_started
        application = await self.client.application_info()
        # setup_hook runs before IDENTIFY. Request privileged content only when
        # the app's developer has enabled it; slash commands remain usable otherwise.
        self.client._connection._intents.message_content = bool(application.flags.gateway_message_content or application.flags.gateway_message_content_limited)
        self.threads.install()
        # Team apps have one explicit team owner; membership alone is not authority.
        self.owner = application.team.owner_id if application.team else application.owner.id
        group = app_commands.Group(name='robot', description='Mr.Robot 개인 티켓 에이전트', guild_only=True)

        @group.command(name='ask', description='개인 티켓에서 AI 작업 요청 (allow_ai 필요)')
        @app_commands.describe(message='작업 내용', provider='models에서 확인한 공급자 ID', model='모델 ID', effort='추론 강도')
        @app_commands.choices(effort=[app_commands.Choice(name=v, value=v) for v in ('auto', 'low', 'medium', 'high')])
        async def ask(interaction: discord.Interaction, message: str, provider: str = '', model: str = '', effort: str = '', file: discord.Attachment = None):
            await self.execute(interaction, 'ask', text=message, providerId=provider, model=model, effort=effort, _attachments=[file] if file else [])

        @group.command(name='stop', description='이 채널에서 요청한 작업 중지')
        async def stop(interaction: discord.Interaction):
            await self.execute(interaction, 'stop')

        @group.command(name='steer', description='현재 작업을 버리지 않고 추가 지시 전달')
        async def steer(interaction: discord.Interaction, message: str):
            await self.execute(interaction, 'steer', text=message)

        @group.command(name='new', description='이 채널에서 새 대화 시작')
        async def new(interaction: discord.Interaction):
            await self.execute(interaction, 'new')

        @group.command(name='status', description='PC 연결과 작업 상태')
        async def status(interaction: discord.Interaction):
            await self.execute(interaction, 'status')

        @group.command(name='models', description='사용 가능한 공급자와 모델 ID')
        async def models(interaction: discord.Interaction):
            await self.execute(interaction, 'models')

        @group.command(name='access', description='서버 관리자 전용: 본인 대화의 PC 접근 권한 설정')
        @app_commands.checks.has_permissions(administrator=True)
        @app_commands.choices(mode=[app_commands.Choice(name=name, value=value) for value, name in [('read-only', '읽기 전용'), ('ask', '변경 전 확인'), ('workspace', '작업 폴더 허용'), ('full', '전체 PC 허용 · 확인 없이 실행')]])
        @app_commands.describe(confirm_full='전체 PC 접근과 확인 없는 변경 실행에 동의하면 True')
        async def access(interaction: discord.Interaction, mode: str, confirm_full: bool = False):
            await self.execute(interaction, 'access', mode=mode, confirmFull=confirm_full)

        @group.command(name='user-access', description='관리자: 사용자별 PC 접근 권한 설정')
        @app_commands.checks.has_permissions(administrator=True)
        @app_commands.choices(mode=[app_commands.Choice(name=label, value=value) for value, label in [('show', '현재 권한 조회'), ('default', '기본값 복원'), ('blocked', 'AI 이용 차단'), ('search', '인터넷 검색만'), ('isolated', '격리 작업 · PC 파일 접근 불가'), ('full', '전체 PC 접근 위임 · 주의')]])
        async def user_access(interaction: discord.Interaction, user: discord.Member, mode: str, confirm_full: bool = False):
            await self.execute(interaction, 'user-access', targetUserId=str(user.id), mode=mode, confirmFull=confirm_full)

        @group.command(name='model-limit', description='서버 관리자 전용: 사용자별 모델 상한 설정·조회')
        @app_commands.checks.has_permissions(administrator=True)
        @app_commands.describe(user='제한할 서버 사용자', ceiling='상위 모델 차단 · 서버 내 모든 티켓에 적용')
        @app_commands.choices(ceiling=[app_commands.Choice(name=label, value=value) for value, label in [('show', '현재 상한 조회'), ('spark', 'spark 이하'), ('mini', 'mini 이하'), ('luna', 'luna 이하'), ('terra', 'terra 이하'), ('sol', 'sol 이하'), ('astra', 'astra 이하'), ('unlimited', '제한 해제 · 모든 공급자')]])
        async def model_limit(interaction: discord.Interaction, user: discord.Member, ceiling: str):
            await self.execute(interaction, 'model-limit', targetUserId=str(user.id), ceiling=ceiling)

        @group.command(name='result', description='긴 작업의 마지막 결과 다시 받기')
        async def result(interaction: discord.Interaction):
            await self.execute(interaction, 'result')

        @group.command(name='approval', description='대기 중인 본인 작업의 승인 버튼 받기')
        async def approval(interaction: discord.Interaction):
            await self.execute(interaction, 'approval')

        @group.command(name='bind', description='이 채널을 개인 스레드 작업실로 연결·패널 고정')
        async def bind(interaction: discord.Interaction):
            await self.threads.bind(interaction)

        @group.command(name='unbind', description='이 채널 작업실 연결 해제 (대화는 유지)')
        async def unbind(interaction: discord.Interaction):
            await self.threads.unbind(interaction)

        @group.command(name='sessions', description='내 개인 스레드 목록·보관 해제')
        async def sessions(interaction: discord.Interaction):
            await self.threads.show_list(interaction)

        @group.command(name='controls', description='이 티켓의 중지·권한·모델 메뉴를 맨 아래로 가져오기')
        async def controls(interaction: discord.Interaction):
            await self.threads.show_controls(interaction)

        @group.command(name='model', description='이 티켓의 공급자·모델·추론 드롭다운 열기')
        async def model_picker(interaction: discord.Interaction):
            await self.threads.show_models(interaction)

        @self.tree.error
        async def on_command_error(interaction, error):
            original = getattr(error, 'original', error)
            text = str(original) if isinstance(original, (PermissionError, RuntimeError)) else 'Discord 권한 또는 연결을 확인하세요. 다시 시도할 수 있습니다.'
            sender = interaction.followup.send if interaction.response.is_done() else interaction.response.send_message
            await sender(discord.utils.escape_mentions(text[:1500]), ephemeral=True, allowed_mentions=discord.AllowedMentions.none())

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
        if value.get('event') == 'thread.state':
            self.threads.update_state(value['data'])
            return
        if value.get('event') == 'workspace.setup':
            async def provision():
                try:
                    result = await self.threads.provision(int(value['guildId']), value['channelName'])
                    emit(dict(event='workspace.ready', **result))
                except Exception as error:
                    text = str(error) if isinstance(error, (PermissionError, RuntimeError)) else '티켓 채널 설정 실패. 봇의 채널·스레드 관리 권한을 확인하세요.'
                    emit(dict(event='workspace.error', message=text))
            task = self.loop.create_task(provision())
            task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
            return
        future = self.pending.get(value.get('id'))
        if future and not future.done():
            if 'error' in value:
                future.set_exception(RuntimeError(str(value['error'])[:1000]))
            else:
                future.set_result(value.get('result'))
        elif value.get('event') == 'progress':
            key = str(value.get('scopeKey'))
            destination = self.active.get(key)
            tasks = getattr(self, 'progress_tasks', {})
            if not destination or getattr(destination, 'progress_finished', False) or key in tasks:
                return
            async def update_progress():
                try:
                    await self.authorize(destination)
                    if self.active.get(key) is not destination or getattr(destination, 'progress_finished', False):
                        return
                    message = getattr(destination, 'result_message', None)
                    if message:
                        preview = discord.utils.escape_mentions(str(value.get('text', '작업 중'))[:1400])
                        await message.edit(content=f'작업 중 · {int(value.get("elapsed", 0))}초\n{preview}', allowed_mentions=discord.AllowedMentions.none())
                except Exception:
                    pass
                finally:
                    tasks.pop(key, None)
            tasks[key] = self.loop.create_task(update_progress())
        elif value.get('event') == 'approval':
            interaction = self.active.get(str(value.get('scopeKey')))
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
            view=Approval(self, interaction.channel_id, request_id, interaction.user.id))

    async def request(self, interaction, action, **params):
        authority = await self.authorize(interaction, admin_only=action in {'access', 'user-access', 'model-limit', 'thread.bind', 'thread.unbind', 'thread.panel', 'approve'})
        if {'id', 'userId', 'channelId', 'guildId', 'guildAdmin', 'allowAi', 'isThread', 'action'} & params.keys():
            raise PermissionError('인증 필드는 요청에서 변경할 수 없습니다.')
        ticket_authorized = authority['allowed']
        if action == 'thread.register':
            await self.authorize_ticket(interaction)
            ticket_authorized = True
        if action in {'model-limit', 'user-access'}:
            # Resolve live membership, not an arbitrary ID submitted by a client.
            target = await interaction.guild.fetch_member(int(params.get('targetUserId', '0')))
            if target.bot:
                raise PermissionError('봇 계정에는 사용자 모델 정책을 설정할 수 없습니다.')
        if action == 'ask' and hasattr(interaction, 'cancel_epoch') and interaction.cancel_epoch != self.threads.cancel_epochs.get(interaction.channel_id, 0):
            raise RuntimeError('사용자가 실행 전에 중지한 요청입니다.')
        if len(self.pending) >= 8:
            raise RuntimeError('요청이 많습니다. 잠시 후 다시 시도하세요.')
        request_id = uuid.uuid4().hex
        future = self.loop.create_future()
        self.pending[request_id] = future
        emit(dict(id=request_id, userId=str(interaction.user.id), channelId=str(interaction.channel_id), guildId=str(interaction.guild_id), guildAdmin=authority['admin'], allowAi=ticket_authorized, isThread=isinstance(interaction.channel, discord.Thread), action=action, **params))
        try:
            return await future if action == 'ask' else await asyncio.wait_for(future, 25)
        finally:
            self.pending.pop(request_id, None)

    async def execute(self, interaction, action, **params):
        if action == 'stop':
            await self.authorize(interaction)
            await self.threads.cancel_queued(interaction.channel_id)
        await interaction.response.defer(ephemeral=action not in ('ask', 'result'), thinking=True)
        destination = interaction
        channel = self.scope_key(interaction)
        if action == 'ask' and channel in self.active:
            await interaction.followup.send('처리 중입니다. /robot stop으로 중지할 수 있습니다.', ephemeral=True)
            return
        if action == 'ask':
            self.active[channel] = interaction
        watch = None
        permission_revoked = False
        try:
            starting_authority = await self.authorize(interaction)
            incoming = params.pop('_attachments', None)
            if incoming is None:
                incoming = getattr(interaction, 'attachments', [])
            if action in ('ask', 'result') and not isinstance(interaction, MessageContext):
                manager = self.threads if str(interaction.channel_id) in self.threads.state['sessions'] else None
                destination = MessageContext(SimpleNamespace(guild=interaction.guild, channel=interaction.channel, author=interaction.user), manager)
                receipt = await interaction.edit_original_response(content='작업 중… 결과는 이 메시지에 표시됩니다.')
                # A bot-token Message remains editable after interaction expiry.
                destination.result_message = await interaction.channel.fetch_message(receipt.id)
                if action == 'ask':
                    self.active[channel] = destination
            if action == 'ask' and interaction.channel_id in self.threads.mutating:
                raise RuntimeError('스레드 관리 작업 중입니다. 잠시 후 다시 보내세요.')
            if action == 'ask':
                async def watch_permissions():
                    nonlocal permission_revoked
                    while True:
                        await asyncio.sleep(5)
                        try:
                            if await self.authorize(interaction) != starting_authority:
                                raise PermissionError('작업 중 역할이 변경되었습니다.')
                        except Exception:
                            permission_revoked = True
                            emit(dict(event='revoked', scopeKey=channel))
                            return
                watch = self.loop.create_task(watch_permissions())
                if incoming:
                    await self.request(interaction, 'status')  # Host policy/ownership before downloading.
                    receipt = getattr(destination, 'result_message', None)
                    if receipt:
                        await receipt.edit(content=f'첨부 {len(incoming)}개 읽는 중 · 파일 내용을 분석하고 있습니다.')
                    attachment_epoch = getattr(self.threads, 'cancel_epochs', {}).get(interaction.channel_id, 0)
                    async def check_cancel():
                        if permission_revoked or attachment_epoch != getattr(self.threads, 'cancel_epochs', {}).get(interaction.channel_id, 0):
                            raise RuntimeError('첨부 분석 작업이 중지되었습니다.')
                    params['attachments'] = await read_attachments(incoming, interaction.channel_id, check_cancel, scope=f'{interaction.guild_id}:{interaction.user.id}:{interaction.channel_id}')
                    if await self.authorize(interaction) != starting_authority:
                        raise PermissionError('첨부 분석 중 역할이 변경되어 전달을 중단했습니다.')
                    if receipt:
                        await receipt.edit(content='첨부 분석 완료 · 내용을 모델에 전달해 작업 중입니다.')
            result = await self.request(interaction, action, **params)
            if action == 'ask':
                destination.progress_finished = True
            task = getattr(self, 'progress_tasks', {}).pop(channel, None)
            if task:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            if await self.authorize(interaction) != starting_authority:
                raise PermissionError('작업 중 역할이 변경되어 결과 전송을 중단했습니다. 새 권한으로 다시 요청하세요.')
            if action == 'approval' and isinstance(result, dict) and result.get('requestId'):
                await self.show_approval(interaction, result)
                return
            text = result_text(result, action)
            sender = destination.followup.send
            chunks = message_chunks(discord.utils.escape_mentions(text))
            for number, chunk in enumerate(chunks[:4]):
                label = f'[{number+1}/{min(len(chunks), 4)}] ' if len(chunks) > 1 else ''
                await sender(label + chunk, ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
            if len(chunks) > 4 or (action in ('ask', 'result') and len(text) > 6000):
                file = discord.File(io.BytesIO(text.encode('utf-8')), filename='MrRobot-result.txt')
                try:
                    await sender('위에는 미리보기입니다. 생략 없는 전체 답변은 이 TXT 파일에서 확인하세요.', file=file, ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
                finally:
                    file.close()
            if action == 'ask' and isinstance(result, dict) and result.get('ok') is not False and (result.get('artifactOnly') is True or wants_files(params.get('text', ''))):
                await self.send_files(interaction, destination, result.get('files', []))
        except Exception as error:
            # No raw Discord HTTP/token diagnostics returned to a channel.
            text = str(error) if isinstance(error, (RuntimeError, PermissionError)) else '연결 또는 응답 오류입니다. PC의 플러그인 상태를 확인하세요.'
            if isinstance(destination, MessageContext) or not interaction.is_expired():
                await destination.followup.send(discord.utils.escape_mentions('⚠️ ' + text[:1500]), ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
        finally:
            if action == 'ask':
                destination.progress_finished = True
            task = getattr(self, 'progress_tasks', {}).pop(channel, None)
            if task:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            if watch:
                watch.cancel()
                await asyncio.gather(watch, return_exceptions=True)
            if action == 'ask':
                self.active.pop(channel, None)

    async def send_files(self, interaction, destination, files):
        for reference in files[:3]:
            try:
                async with asyncio.timeout(120):
                    limit = min(int(interaction.guild.filesize_limit), 25 * 1024 * 1024)
                    content = bytearray()
                    version = None
                    while True:
                        part = await self.request(interaction, 'file.read', path=reference['path'], offset=len(content), limit=limit, version=version)
                        chunk = base64.b64decode(part['data'], validate=True)
                        if part['offset'] != len(content) or part['size'] > limit or len(chunk) > 128 * 1024 or version and version != part['version']:
                            raise RuntimeError('파일 전송 무결성 검증에 실패했습니다.')
                        content.extend(chunk)
                        if len(content) > part['size'] or not chunk and not part['done']:
                            raise RuntimeError('파일 조각 크기가 올바르지 않습니다.')
                        version = part['version']
                        if part['done']:
                            if len(content) != part['size']:
                                raise RuntimeError('파일 전송이 완료되지 않았습니다.')
                            break
                    await self.authorize(interaction)
                    await self.request(interaction, 'file.read', path=reference['path'], offset=len(content), limit=limit, version=version)
                    file = discord.File(io.BytesIO(content), filename=part['name'])
                    try:
                        await destination.followup.send('PC 파일을 첨부했습니다. 이 첨부파일은 Discord에 저장됩니다.', file=file, ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
                    finally:
                        file.close()
            except Exception as error:
                detail = str(error) if isinstance(error, (RuntimeError, PermissionError)) else '파일 크기·봇의 파일 첨부 권한·연결을 확인하고 다시 요청하세요.'
                await destination.followup.send(discord.utils.escape_mentions('⚠️ 파일 첨부 실패: ' + detail[:1200]), ephemeral=True, allowed_mentions=discord.AllowedMentions.none())


def main():
    from standalone import RuntimeFailure
    try:
        settings = json.loads(sys.stdin.readline(128000))
        mode = settings.get('mode', 'standalone')
        if mode == 'standalone':
            from standalone import run
        elif mode == 'legacy':
            from legacy_adapter import run
        else:
            raise RuntimeFailure('mode')
        run(settings, Bridge, emit)
    except RuntimeFailure as error:
        emit({'event': 'error', 'code': str(error)})
        raise SystemExit(1) from None
    except Exception:
        # Never expose config contents, Discord token or arbitrary tracebacks.
        emit({'event': 'error', 'code': 'startup'})
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
