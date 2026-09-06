"""Discord-native session UI. Durable ownership lives in the private Node host."""
import asyncio
from collections import deque
from types import SimpleNamespace

import discord


class SafeView(discord.ui.View):
    async def on_error(self, interaction, error, item):
        text = str(error) if isinstance(error, (PermissionError, RuntimeError)) else 'Discord 권한 또는 연결을 확인하세요. 다시 시도할 수 있습니다.'
        sender = interaction.followup.send if interaction.response.is_done() else interaction.response.send_message
        await sender(discord.utils.escape_mentions(text[:1500]), ephemeral=True, allowed_mentions=discord.AllowedMentions.none())


class Panel(SafeView):
    def __init__(self, manager):
        super().__init__(timeout=None)
        self.manager = manager

    @discord.ui.button(label='티켓 열기', style=discord.ButtonStyle.primary, custom_id='mrrobot:thread:create:v1')
    async def create(self, interaction, button):
        await self.manager.bridge.authorize_ticket(interaction)
        await interaction.response.send_modal(TicketModal(self.manager))

    @discord.ui.button(label='내 티켓 목록', custom_id='mrrobot:thread:list:v1')
    async def sessions(self, interaction, button):
        await self.manager.show_list(interaction)


class TicketModal(discord.ui.Modal, title='새 개인 티켓 요청'):
    subject = discord.ui.TextInput(label='티켓 제목 / 작업 목적', placeholder='예: 프로젝트 문서 정리', max_length=60)

    def __init__(self, manager):
        super().__init__()
        self.manager = manager

    async def on_submit(self, interaction):
        try:
            await self.manager.create(interaction, self.subject.value.strip())
        except Exception as error:
            text = str(error) if isinstance(error, (PermissionError, RuntimeError)) else '티켓 생성 실패. 봇의 비공개 스레드 권한과 연결을 확인하세요.'
            sender = interaction.followup.send if interaction.response.is_done() else interaction.response.send_message
            await sender(discord.utils.escape_mentions(text[:1500]), ephemeral=True)


class Controls(SafeView):
    def __init__(self, manager):
        super().__init__(timeout=None)
        self.manager = manager

    async def interaction_check(self, interaction):
        await self.manager.bridge.authorize(interaction)
        self.manager.owned(interaction)
        return True

    @discord.ui.button(label='작업 중지', custom_id='mrrobot:thread:stop:v1')
    async def stop_work(self, interaction, button):
        await self.manager.bridge.execute(interaction, 'stop')

    @discord.ui.button(label='현재 설정', custom_id='mrrobot:thread:settings:v1')
    async def settings(self, interaction, button):
        await interaction.response.defer(ephemeral=True)
        state = await self.manager.bridge.request(interaction, 'status')
        await interaction.followup.send(state['message'], view=Settings(self.manager, state), ephemeral=True)

    @discord.ui.button(label='모델 선택', style=discord.ButtonStyle.primary, custom_id='mrrobot:thread:model:v1', row=0)
    async def model(self, interaction, button):
        await self.manager.show_models(interaction)

    @discord.ui.select(placeholder='PC 접근 권한 · 서버 관리자 전용', custom_id='mrrobot:thread:access:v1', row=1, options=[discord.SelectOption(label=label, value=value) for value, label in [('read-only', '읽기 전용'), ('ask', '변경 전 확인'), ('workspace', '작업 폴더 허용'), ('full', '전체 PC 허용 · 확인 없이 실행')]])
    async def access(self, interaction, select):
        await choose_access(self.manager, interaction, select.values[0])

    @discord.ui.button(label='보관', custom_id='mrrobot:thread:archive:v1')
    async def archive(self, interaction, button):
        await self.manager.change(interaction, 'archive')

    @discord.ui.button(label='삭제', style=discord.ButtonStyle.danger, custom_id='mrrobot:thread:delete:v1')
    async def delete(self, interaction, button):
        await interaction.response.send_message('이 스레드와 Discord 메시지를 영구 삭제할까요? 복구할 수 없습니다. PC에 저장된 대화 기록은 남습니다.', ephemeral=True, view=Confirm(self.manager, interaction, 'delete'))


class Confirm(SafeView):
    def __init__(self, manager, interaction, action):
        super().__init__(timeout=60)
        self.manager, self.user_id, self.channel_id, self.action = manager, interaction.user.id, interaction.channel_id, action
        self.used = False

    async def interaction_check(self, interaction):
        return not self.used and interaction.user.id == self.user_id and interaction.channel_id == self.channel_id

    @discord.ui.button(label='확인', style=discord.ButtonStyle.danger)
    async def confirm(self, interaction, button):
        self.used = True
        if self.action == 'full':
            await self.manager.bridge.execute(interaction, 'access', mode='full', confirmFull=True)
        else:
            await self.manager.change(interaction, 'delete')
        self.stop()

    @discord.ui.button(label='취소')
    async def cancel(self, interaction, button):
        self.used = True
        await interaction.response.edit_message(content='취소했습니다.', view=None)
        self.stop()


async def choose_access(manager, interaction, mode):
    await manager.bridge.authorize(interaction)
    manager.owned(interaction)
    if mode == 'full':
        await interaction.response.send_message('이 대화에서 전체 PC 접근과 확인 없는 변경 실행을 허용합니다. 동의하나요?', ephemeral=True, view=Confirm(manager, interaction, 'full'))
    else:
        await manager.bridge.execute(interaction, 'access', mode=mode)


class ModelPicker(SafeView):
    """Paged selectors use opaque indexes, not truncated model IDs as values."""
    def __init__(self, manager, owner_id, providers, preference):
        super().__init__(timeout=300)
        self.manager, self.owner_id = manager, owner_id
        self.providers = [p for p in providers if isinstance(p, dict) and p.get('providerId')][:200]
        self.preference = preference
        self.provider_page = 0
        self.model_page = 0
        self.current_provider = next((p for p in self.providers if p['providerId'] == preference.get('providerId')), self.providers[0] if self.providers else None)
        if self.current_provider:
            self.provider_page = self.providers.index(self.current_provider) // 25
        self.models = []
        self.warning = ''

    async def interaction_check(self, interaction):
        if interaction.user.id != self.owner_id:
            return False
        await self.manager.bridge.authorize(interaction)
        self.manager.owned(interaction)
        return True

    async def load(self, interaction):
        self.warning = ''
        if self.current_provider:
            try:
                found = await self.manager.bridge.request(interaction, 'models', providerId=self.current_provider['providerId'])
                if not isinstance(found, list):
                    raise RuntimeError('Invalid model catalog')
            except PermissionError:
                raise
            except Exception:
                found = []
                self.warning = '\n모델 발견 실패: 등록 모델만 표시합니다. PC에서 공급자 연결을 확인하세요.'
            configured = self.current_provider.get('model')
            selected = self.preference.get('model') if self.preference.get('providerId') == self.current_provider['providerId'] else None
            # Never reinsert a stale selected/configured model above the live cap.
            candidates = found if self.current_provider.get('modelCeiling', 'unlimited') != 'unlimited' else [selected, configured, *found]
            self.models = list(dict.fromkeys(m for m in candidates if isinstance(m, str) and 0 < len(m) <= 200))[:1000]
        self.model_page = 0
        self.render()

    def caption(self):
        current = self.preference.get('model') or '기본 모델'
        ceiling = self.current_provider.get('modelCeiling', 'unlimited') if self.current_provider else 'unlimited'
        return discord.utils.escape_mentions(f"모델 선택 · 현재 {current} · 상한 {ceiling}\n공급자 → 모델을 고르면 이 티켓에 저장됩니다. 추론도 아래에서 선택하세요.{self.warning}")[:1800]

    def render(self):
        self.clear_items()
        if not self.providers:
            return
        providers = discord.ui.Select(placeholder=f'공급자 · {self.provider_page + 1}/{(len(self.providers) + 24) // 25}', row=0, options=[discord.SelectOption(label=str(p.get('name') or 'Provider')[:100], value=str(i), default=p == self.current_provider) for i, p in list(enumerate(self.providers))[self.provider_page * 25:(self.provider_page + 1) * 25]])
        async def provider_changed(interaction):
            await interaction.response.defer()
            self.current_provider = self.providers[int(providers.values[0])]
            await self.load(interaction)
            await interaction.edit_original_response(content=self.caption(), view=self)
        providers.callback = provider_changed
        self.add_item(providers)
        if self.models:
            provider_snapshot = dict(self.current_provider)
            models_snapshot = list(self.models)
            models = discord.ui.Select(placeholder=f'모델 · {self.model_page + 1}/{(len(self.models) + 24) // 25}', row=1, options=[discord.SelectOption(label=model[:100], value=str(i), default=self.preference.get('providerId') == self.current_provider['providerId'] and model == self.preference.get('model')) for i, model in list(enumerate(self.models))[self.model_page * 25:(self.model_page + 1) * 25]])
            async def model_changed(interaction):
                await interaction.response.defer()
                effort = self.preference.get('effort', 'auto')
                if effort not in provider_snapshot.get('supportedReasoning', ['auto']):
                    effort = 'auto'
                preference = dict(providerId=provider_snapshot['providerId'], model=models_snapshot[int(models.values[0])], effort=effort)
                await self.manager.bridge.request(interaction, 'settings', **preference)
                self.preference = preference
                self.render()
                await interaction.edit_original_response(content='저장했습니다.\n' + self.caption(), view=self)
            models.callback = model_changed
            self.add_item(models)
        # The current Discord host accepts these four effort levels.
        efforts = [v for v in ['auto', 'low', 'medium', 'high'] if v == 'auto' or v in self.current_provider.get('supportedReasoning', [])]
        reasoning = discord.ui.Select(placeholder='추론 강도', row=2, options=[discord.SelectOption(label=v, value=v, default=v == self.preference.get('effort', 'auto')) for v in efforts])
        async def effort_changed(interaction):
            await interaction.response.defer()
            if self.preference.get('providerId') != self.current_provider['providerId'] or not self.preference.get('model'):
                raise RuntimeError('먼저 위에서 사용할 모델을 선택하세요.')
            preference = {**self.preference, 'effort': reasoning.values[0]}
            await self.manager.bridge.request(interaction, 'settings', **preference)
            self.preference = preference
            self.render()
            await interaction.edit_original_response(content='저장했습니다.\n' + self.caption(), view=self)
        reasoning.callback = effort_changed
        self.add_item(reasoning)
        for label, kind, delta, enabled in [('공급자 이전', 'provider', -1, self.provider_page > 0), ('공급자 다음', 'provider', 1, (self.provider_page + 1) * 25 < len(self.providers)), ('모델 이전', 'model', -1, self.model_page > 0), ('모델 다음', 'model', 1, (self.model_page + 1) * 25 < len(self.models))]:
            button = discord.ui.Button(label=label, row=3, disabled=not enabled)
            async def page(interaction, kind=kind, delta=delta):
                if kind == 'provider':
                    self.provider_page = max(0, min((len(self.providers) - 1) // 25, self.provider_page + delta))
                else:
                    self.model_page = max(0, min((len(self.models) - 1) // 25, self.model_page + delta))
                self.render()
                await interaction.response.edit_message(content=self.caption(), view=self)
            button.callback = page
            self.add_item(button)

class Settings(SafeView):
    def __init__(self, manager, state):
        super().__init__(timeout=180)
        self.manager, self.state = manager, state

    @discord.ui.select(placeholder='PC 접근 권한', options=[discord.SelectOption(label=label, value=value) for value, label in [('read-only', '읽기 전용'), ('ask', '변경 전 확인'), ('workspace', '작업 폴더 허용'), ('full', '전체 PC 허용 · 확인 없이 실행')]])
    async def access(self, interaction, select):
        await choose_access(self.manager, interaction, select.values[0])

    @discord.ui.button(label='모델·추론 변경')
    async def model(self, interaction, button):
        await self.manager.show_models(interaction)

    @discord.ui.button(label='사용 가능한 모델 목록')
    async def models(self, interaction, button):
        await self.manager.bridge.execute(interaction, 'models')


class SessionList(SafeView):
    def __init__(self, manager, sessions):
        super().__init__(timeout=180)
        self.manager = manager
        select = discord.ui.Select(placeholder='열거나 보관 해제할 대화', options=[discord.SelectOption(label=(('보관 · ' if s['archived'] else '') + s['name'])[:100], value=s['id']) for s in sessions[:20]])
        select.callback = self.open_session
        self.add_item(select)
        self.select = select

    async def open_session(self, interaction):
        await self.manager.reopen(interaction, self.select.values[0])


class MessageContext:
    """Reuse the checked bridge RPC path without a 15-minute interaction token."""
    def __init__(self, message, manager=None):
        self.guild, self.guild_id = message.guild, message.guild.id
        self.channel, self.channel_id = message.channel, message.channel.id
        self.user = message.author
        self.manager = manager
        self.response = SimpleNamespace(defer=self.defer)
        self.followup = SimpleNamespace(send=self.send)

    async def defer(self, **kwargs):
        pass

    async def send(self, content=None, **kwargs):
        kwargs.pop('ephemeral', None)
        if self.manager and 'view' not in kwargs:
            return await self.manager.send_controls(self.channel, content, **kwargs)
        return await self.channel.send(content, **kwargs)

    def is_expired(self):
        return False


class ThreadManager:
    def __init__(self, bridge, state):
        self.bridge = bridge
        self.state = state or {'bindings': {}, 'sessions': {}}
        self.lock = asyncio.Lock()
        self.mutating = set()
        self.queue = deque()
        self.worker = None
        self.cancel_epochs = {}
        self.latest_controls = {}
        self.controls_lock = asyncio.Lock()

    def install(self):
        self.bridge.client.add_view(Panel(self))
        self.bridge.client.add_view(Controls(self))

    def update_state(self, state):
        self.state = state
        for channel_id in list(self.latest_controls):
            if str(channel_id) not in state['sessions']:
                _, view = self.latest_controls.pop(channel_id)
                view.stop()
                self.cancel_epochs.pop(channel_id, None)

    async def send_controls(self, channel, content, **kwargs):
        async with self.controls_lock:
            view = Controls(self)
            try:
                message = await channel.send(content, view=view, allowed_mentions=discord.AllowedMentions.none(), **{k: v for k, v in kwargs.items() if k != 'allowed_mentions'})
            except Exception:
                view.stop()
                raise
            previous = self.latest_controls.get(channel.id)
            self.latest_controls[channel.id] = (message, view)
            if previous:
                previous[1].stop()
                try:
                    await previous[0].edit(view=None)
                except discord.HTTPException:
                    pass
            return message

    async def show_controls(self, interaction):
        await interaction.response.defer(ephemeral=True)
        await self.bridge.authorize(interaction)
        self.owned(interaction)
        state = await self.bridge.request(interaction, 'status')
        await self.send_controls(interaction.channel, state['message'])
        await interaction.followup.send('제어 메뉴를 맨 아래로 가져왔습니다.', ephemeral=True)

    async def show_models(self, interaction):
        await interaction.response.defer(ephemeral=True)
        await self.bridge.authorize(interaction)
        self.owned(interaction)
        state = await self.bridge.request(interaction, 'status')
        providers = await self.bridge.request(interaction, 'models')
        view = ModelPicker(self, interaction.user.id, providers, state.get('preference', {}))
        await view.load(interaction)
        await interaction.followup.send(view.caption() if providers else '등록된 공급자가 없습니다. PC 앱에서 먼저 연결하세요.', view=view, ephemeral=True)

    def panel_content(self):
        content = '## Mr.Robot · 개인 티켓 작업실\n[티켓 열기]를 눌러 제목을 입력하면 개인 비공개 스레드가 만들어집니다. 그 안에서 일반 채팅으로 작업을 요청하세요.\n서버 관리자만 사용할 수 있으며 티켓 생성자의 메시지만 실행합니다. 티켓별 모델·권한·대화가 분리됩니다.\n서버의 스레드 관리 권한자는 비공개 티켓도 볼 수 있습니다.'
        if not self.bridge.client.intents.message_content:
            content += '\n⚠ Developer Portal → Bot → Message Content Intent를 켜고 PC 플러그인을 재연결하세요. 그 전에는 /robot ask를 사용하세요.'
        return content

    async def publish_panel(self, channel):
        panel = None
        panel_id = self.state.get('panels', {}).get(str(channel.id))
        if panel_id:
            try:
                panel = await channel.fetch_message(int(panel_id))
                await panel.edit(content=self.panel_content(), view=Panel(self))
            except discord.NotFound:
                panel = None
        if panel is None:
            panel = await channel.send(self.panel_content(), view=Panel(self), allowed_mentions=discord.AllowedMentions.none())
        pinned = True
        try:
            await panel.pin(reason='Mr.Robot ticket panel')
        except discord.Forbidden:
            pinned = False
        return panel, pinned

    async def provision(self, guild_id, channel_name):
        # Invoked only by the PC-admin plugin command over its private pipe.
        if guild_id not in self.bridge.allowed_guilds:
            raise PermissionError('등록된 서버만 설정할 수 있습니다.')
        async with self.lock:
            guild = self.bridge.client.get_guild(guild_id)
            if not guild:
                raise RuntimeError('서버 연결을 확인하세요.')
            channels = await guild.fetch_channels()
            matches = [c for c in channels if c.name == channel_name]
            if len(matches) > 1 or (matches and not isinstance(matches[0], discord.TextChannel)):
                raise RuntimeError('같은 이름의 채널이 중복되거나 텍스트 채널이 아닙니다.')
            bound = self.state['bindings'].get(str(guild_id))
            if bound and (not matches or str(matches[0].id) != bound):
                raise RuntimeError('다른 채널이 이미 연결되어 있습니다. 기존 채널에서 /robot unbind 후 다시 시도하세요.')
            channel = matches[0] if matches else await guild.create_text_channel(channel_name, topic='Mr.Robot 개인 티켓 · 버튼을 눌러 요청하세요', overwrites={guild.default_role: discord.PermissionOverwrite(view_channel=False), guild.me: discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True, create_private_threads=True, send_messages_in_threads=True, manage_threads=True)}, reason='PC administrator requested Mr.Robot ticket workspace')
            panel, pinned = await self.publish_panel(channel)
            return {'guildId': str(guild_id), 'channelId': str(channel.id), 'panelId': str(panel.id), 'pinned': pinned}

    def owned(self, context):
        s = self.state['sessions'].get(str(context.channel_id))
        if not s or s['ownerId'] != str(context.user.id) or s['guildId'] != str(context.guild_id):
            raise PermissionError('본인이 만든 개인 스레드에서만 사용할 수 있습니다.')
        return s

    def check_context(self, context):
        if isinstance(context.channel, discord.Thread) or str(context.channel_id) in self.state['sessions']:
            self.owned(context)

    async def bind(self, interaction):
        await interaction.response.defer(ephemeral=True)
        await self.bridge.authorize(interaction)
        if not isinstance(interaction.channel, discord.TextChannel):
            raise RuntimeError('일반 텍스트 채널에서 /robot bind를 실행하세요.')
        async with self.lock:
            channel = interaction.channel
            perms = channel.permissions_for(interaction.guild.me)
            if not all(getattr(perms, p, False) for p in ('view_channel', 'send_messages', 'create_private_threads', 'send_messages_in_threads', 'manage_threads', 'read_message_history')):
                raise RuntimeError('봇에 채널 보기·메시지 보내기·기록 보기·비공개 스레드 생성·스레드 메시지·스레드 관리 권한이 필요합니다.')
            await self.bridge.request(interaction, 'thread.bind')
            panel, pinned = await self.publish_panel(channel)
            await self.bridge.request(interaction, 'thread.panel', panelId=str(panel.id))
            note = '' if pinned else ' (고정 권한이 없어 패널만 게시했습니다.)'
            await interaction.followup.send('개인 작업실 패널을 연결했습니다.' + note, ephemeral=True)

    async def unbind(self, interaction):
        await interaction.response.defer(ephemeral=True)
        async with self.lock:
            result = await self.bridge.request(interaction, 'thread.unbind')
            # Queued messages revalidate the binding before execution.
            panel_id = self.state.get('panels', {}).get(str(interaction.channel_id))
            if panel_id:
                try:
                    panel = await interaction.channel.fetch_message(int(panel_id))
                    await panel.edit(content='Mr.Robot 연결 해제됨. /robot bind로 다시 연결하세요.', view=None)
                except discord.NotFound:
                    pass
            await interaction.followup.send(result['message'], ephemeral=True)

    async def create(self, interaction, subject='새 작업'):
        await interaction.response.defer(ephemeral=True)
        await self.bridge.authorize_ticket(interaction)
        async with self.lock:
            if self.state['bindings'].get(str(interaction.guild_id)) != str(interaction.channel_id):
                raise RuntimeError('연결된 부모 채널의 패널에서 생성하세요. /robot bind로 연결할 수 있습니다.')
            sessions = await self.bridge.request(interaction, 'thread.list')
            if len(sessions) >= 20:
                raise RuntimeError('내 대화가 20개입니다. 불필요한 대화를 삭제하세요.')
            name = f'티켓 · {interaction.user.display_name} · {subject or "새 작업"}'[:100]
            thread = await interaction.channel.create_thread(name=name, type=discord.ChannelType.private_thread, invitable=False, auto_archive_duration=1440, reason='User requested Mr.Robot session')
            registered = False
            try:
                await thread.add_user(interaction.user)
                await self.bridge.request(interaction, 'thread.register', threadId=str(thread.id), name=name)
                registered = True
                await self.send_controls(thread, '여기에 작업을 입력하세요. 제어 메뉴는 새 응답 아래로 따라옵니다.\n작업 중 추가 메시지는 순서대로 대기합니다. /robot controls로 메뉴를 다시 꺼낼 수 있습니다. 파일 첨부는 아직 지원하지 않습니다.')
            except Exception:
                if not registered:
                    await thread.delete(reason='Roll back incomplete Mr.Robot session')
                raise
            await interaction.followup.send(f'내 대화가 준비됐습니다: {thread.jump_url}', ephemeral=True)

    async def show_list(self, interaction):
        await interaction.response.defer(ephemeral=True)
        sessions = await self.bridge.request(interaction, 'thread.list')
        if not sessions:
            await interaction.followup.send('아직 내 대화가 없습니다. 부모 채널의 [내 대화 만들기]를 누르세요.', ephemeral=True)
            return
        await interaction.followup.send('내 대화를 선택하면 열거나 보관을 해제합니다.', view=SessionList(self, sessions), ephemeral=True)

    async def reopen(self, interaction, thread_id):
        await interaction.response.defer(ephemeral=True)
        await self.bridge.authorize(interaction)
        async with self.lock:
            s = self.state['sessions'].get(thread_id)
            if not s or s['ownerId'] != str(interaction.user.id) or s['guildId'] != str(interaction.guild_id):
                raise PermissionError('본인 대화만 열 수 있습니다.')
            if self.state['bindings'].get(s['guildId']) != s['parentId']:
                raise RuntimeError('원래 부모 채널에서 /robot bind로 다시 연결하세요.')
            target = SimpleNamespace(guild=interaction.guild, guild_id=interaction.guild_id, channel_id=int(thread_id), user=interaction.user, channel=None)
            try:
                thread = await self.bridge.client.fetch_channel(int(thread_id))
            except discord.NotFound:
                await self.bridge.request(target, 'thread.forget')
                await interaction.followup.send('Discord에서 이미 삭제된 스레드를 목록에서 정리했습니다. PC 대화 기록은 남아 있습니다.', ephemeral=True)
                return
            if not isinstance(thread, discord.Thread) or str(thread.parent_id) != s['parentId']:
                raise PermissionError('등록된 스레드와 일치하지 않습니다.')
            target.channel = thread
            await thread.edit(archived=False, locked=False)
            await self.bridge.request(target, 'thread.reopen')
            await self.send_controls(thread, '대화를 다시 열었습니다. 아래에서 모델·권한을 선택하거나 작업을 입력하세요.')
            await interaction.followup.send(thread.jump_url, ephemeral=True)

    async def change(self, interaction, action):
        await interaction.response.defer(ephemeral=True)
        await self.bridge.authorize(interaction)
        async with self.lock:
            self.owned(interaction)
            self.mutating.add(interaction.channel_id)
            try:
                await self.bridge.request(interaction, 'thread.get', requireIdle=True)
                await self.cancel_queued(interaction.channel_id)
                if action == 'delete':
                    await interaction.followup.send('확인한 스레드를 삭제합니다. PC 대화 기록은 유지됩니다.', ephemeral=True)
                    await interaction.channel.delete(reason='Session owner confirmed deletion')
                    await self.bridge.request(interaction, 'thread.forget')
                else:
                    await interaction.followup.send('보관합니다. 부모 채널의 [내 대화 목록]에서 다시 열 수 있습니다.', ephemeral=True)
                    await interaction.channel.edit(archived=True, locked=True)
                    await self.bridge.request(interaction, 'thread.archive')
            finally:
                self.mutating.discard(interaction.channel_id)

    async def cancel_queued(self, channel_id):
        if str(channel_id) in self.state['sessions']:
            self.cancel_epochs[channel_id] = self.cancel_epochs.get(channel_id, 0) + 1
        removed = [item for item in self.queue if item[0].channel_id == channel_id]
        self.queue = deque(item for item in self.queue if item[0].channel_id != channel_id)
        for _, _, status in removed:
            if status is None:
                continue
            try:
                await status.edit(content='대기 작업 취소됨')
            except discord.HTTPException:
                pass

    async def on_message(self, message):
        if message.author.bot or message.webhook_id or not message.guild or message.type not in (discord.MessageType.default, discord.MessageType.reply):
            return
        s = self.state['sessions'].get(str(message.channel.id))
        if not s or s['ownerId'] != str(message.author.id) or s['guildId'] != str(message.guild.id):
            return
        if s['archived'] or self.state['bindings'].get(s['guildId']) != s['parentId'] or message.channel.id in self.mutating:
            return
        context = MessageContext(message, self)
        context.cancel_epoch = self.cancel_epochs.get(context.channel_id, 0)
        try:
            await self.bridge.authorize(context)
        except Exception:
            return  # Do not leak session details to a revoked member.
        if not self.bridge.client.intents.message_content:
            await context.send('일반 채팅 권한이 꺼져 있습니다. Message Content Intent를 켜고 플러그인을 다시 연결하세요. /robot ask는 사용 가능합니다.')
            return
        if message.attachments:
            await context.send('이 연결은 아직 첨부 파일을 읽지 않습니다. 파일 내용 없이 명령을 실행하지 않았습니다. 텍스트로 요청하거나 PC 앱에서 파일을 첨부하세요.')
            return
        if not message.content.strip() or len(message.content) > 6000:
            await context.send('명령을 1~6000자로 입력하세요.')
            return
        if len(self.queue) >= 16 or sum(item[0].channel_id == context.channel_id for item in self.queue) >= 4:
            await context.send('대기열이 가득 찼습니다. 진행 중인 작업 완료 후 다시 보내세요.')
            return
        # Reserve the queue slot before network awaits so concurrent messages cannot overfill it.
        self.queue.append((context, message.content, None))
        try:
            status = await context.send('접수됨 · 순서대로 실행합니다.')
        except Exception:
            self.queue.remove((context, message.content, None))
            return
        for i, item in enumerate(self.queue):
            if item[0] is context:
                self.queue[i] = (context, message.content, status)
                break
        else:
            await status.edit(content='대기 작업 취소됨')
            return
        if not self.worker or self.worker.done():
            self.worker = asyncio.create_task(self.drain())

    async def drain(self):
        while self.queue:
            if self.bridge.active:
                await asyncio.sleep(0.5)
                continue
            if self.queue[0][2] is None:
                await asyncio.sleep(0.1)
                continue
            context, text, status = self.queue.popleft()
            try:
                s = self.owned(context)
                if s['archived'] or self.state['bindings'].get(s['guildId']) != s['parentId']:
                    await status.edit(content='연결 해제 또는 보관으로 취소됨')
                    continue
                await self.bridge.authorize(context)
                await status.edit(content='작업 중 · 최근 메시지 아래의 [작업 중지] 버튼을 누르세요.')
                async with context.channel.typing():
                    await self.bridge.execute(context, 'ask', text=text)
                await status.edit(content='처리 종료 · 결과 또는 오류 안내를 확인하세요.')
            except Exception:
                try:
                    await status.edit(content='작업 전달 실패 · 연결 및 권한을 확인하세요.')
                except discord.HTTPException:
                    pass

    async def disconnected(self):
        for channel_id in {item[0].channel_id for item in self.queue}:
            await self.cancel_queued(channel_id)
