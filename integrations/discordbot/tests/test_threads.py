import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import discord
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from thread_sessions import ThreadManager, MessageContext, Panel, Controls, Confirm, TicketModal
from bridge import Bridge


class ThreadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bridge = NS(authorize=AsyncMock(), execute=AsyncMock(), request=AsyncMock(), active={}, client=NS(intents=NS(message_content=True)))
        self.manager = ThreadManager(self.bridge, {'bindings': {'1': '2'}, 'sessions': {'4': {'guildId': '1', 'parentId': '2', 'ownerId': '3', 'name': 'mine', 'archived': False}}})
        self.status = NS(edit=AsyncMock())
        self.channel = NS(id=4, send=AsyncMock(return_value=self.status))
        self.message = NS(author=NS(id=3, bot=False), webhook_id=None, guild=NS(id=1), channel=self.channel, type=discord.MessageType.default, content='test task', attachments=[])

    async def asyncTearDown(self):
        if self.manager.worker:
            self.manager.worker.cancel()
            await asyncio.gather(self.manager.worker, return_exceptions=True)

    async def test_persistent_controls(self):
        self.assertTrue(Panel(self.manager).is_persistent())
        self.assertTrue(Controls(self.manager).is_persistent())

    async def test_other_admin_bot_webhook_and_unknown_channel_ignored(self):
        for field, value in [('author', NS(id=9, bot=False)), ('author', NS(id=3, bot=True)), ('webhook_id', 55), ('channel', NS(id=9))]:
            message = NS(**vars(self.message))
            setattr(message, field, value)
            await self.manager.on_message(message)
        self.bridge.authorize.assert_not_awaited()
        self.bridge.execute.assert_not_awaited()

    async def test_revoked_owner_is_not_executed(self):
        self.bridge.authorize.side_effect = PermissionError()
        await self.manager.on_message(self.message)
        self.channel.send.assert_not_awaited()
        self.assertFalse(self.manager.queue)

    async def test_archived_unbound_and_mutating_do_not_execute(self):
        self.manager.state['sessions']['4']['archived'] = True
        await self.manager.on_message(self.message)
        self.manager.state['sessions']['4']['archived'] = False
        self.manager.state['bindings'] = {}
        await self.manager.on_message(self.message)
        self.manager.state['bindings'] = {'1': '2'}
        self.manager.mutating.add(4)
        await self.manager.on_message(self.message)
        self.bridge.authorize.assert_not_awaited()

    async def test_content_permission_and_attachments_fail_explicitly(self):
        self.bridge.client.intents.message_content = False
        await self.manager.on_message(self.message)
        self.assertIn('Intent', self.channel.send.call_args.args[0])
        self.bridge.client.intents.message_content = True
        self.message.attachments = [NS()]
        await self.manager.on_message(self.message)
        self.assertIn('첨부', self.channel.send.call_args.args[0])
        self.assertFalse(self.manager.queue)

    async def test_queue_bounded_and_cancel_clears_pending(self):
        self.bridge.active = {'busy': True}
        for _ in range(5):
            await self.manager.on_message(self.message)
        self.assertEqual(len(self.manager.queue), 4)
        self.assertIn('가득', self.channel.send.call_args.args[0])
        await self.manager.cancel_queued(4)
        self.assertFalse(self.manager.queue)
        self.bridge.execute.assert_not_awaited()

    async def test_owned_scope_and_confirmation(self):
        context = MessageContext(self.message)
        self.assertEqual(self.manager.owned(context)['ownerId'], '3')
        context.user = NS(id=8)
        with self.assertRaises(PermissionError):
            self.manager.owned(context)
        context.user = NS(id=3)
        confirm = Confirm(self.manager, context, 'delete')
        self.assertTrue(await confirm.interaction_check(context))
        context.channel_id = 9
        self.assertFalse(await confirm.interaction_check(context))
        context.channel_id = 4
        confirm.used = True
        self.assertFalse(await confirm.interaction_check(context))

    async def test_message_result_does_not_use_ephemeral_token(self):
        context = MessageContext(self.message)
        await context.send('done', ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
        self.assertNotIn('ephemeral', self.channel.send.call_args.kwargs)
        self.assertFalse(context.is_expired())

    async def test_open_ticket_requires_explicit_modal_request(self):
        context = NS(guild_id=1, channel_id=2, user=NS(id=3), response=NS(send_modal=AsyncMock()))
        self.manager.create = AsyncMock()
        panel = Panel(self.manager)
        await panel.create.callback(context)
        self.assertIsInstance(context.response.send_modal.call_args.args[0], TicketModal)
        self.manager.create.assert_not_awaited()

    async def test_ticket_create_private_and_registers_owner(self):
        thread = NS(id=7, add_user=AsyncMock(), send=AsyncMock(), delete=AsyncMock(), jump_url='https://discord.com/channels/1/7')
        parent = NS(create_thread=AsyncMock(return_value=thread))
        context = NS(guild_id=1, channel_id=2, user=NS(id=3, display_name='Tester'), channel=parent, response=NS(defer=AsyncMock()), followup=NS(send=AsyncMock()))
        self.bridge.request.return_value = []
        await self.manager.create(context, 'Docs')
        self.assertEqual(parent.create_thread.call_args.kwargs['type'], discord.ChannelType.private_thread)
        self.assertFalse(parent.create_thread.call_args.kwargs['invitable'])
        thread.add_user.assert_awaited_once_with(context.user)
        self.assertEqual(self.bridge.request.call_args.args[1], 'thread.register')
        self.assertIn('Docs', self.bridge.request.call_args.kwargs['name'])
        thread.delete.assert_not_awaited()

    async def test_busy_delete_does_not_delete_thread(self):
        context = NS(guild_id=1, channel_id=4, user=NS(id=3), channel=NS(delete=AsyncMock()), response=NS(defer=AsyncMock()), followup=NS(send=AsyncMock()))
        self.bridge.request.side_effect = RuntimeError('실행 중')
        with self.assertRaises(RuntimeError):
            await self.manager.change(context, 'delete')
        context.channel.delete.assert_not_awaited()
        self.assertNotIn(4, self.manager.mutating)

    async def test_plain_message_reaches_checked_agent_path(self):
        @asynccontextmanager
        async def typing():
            yield
        self.channel.typing = typing
        await self.manager.on_message(self.message)
        await self.manager.worker
        self.bridge.execute.assert_awaited_once()
        self.assertEqual(self.bridge.execute.call_args.args[1], 'ask')
        self.assertEqual(self.bridge.execute.call_args.kwargs['text'], 'test task')
        self.assertEqual(self.bridge.execute.call_args.args[0].user.id, 3)
        self.assertFalse(self.manager.queue)

    async def test_stop_during_authorization_prevents_late_execution(self):
        context = MessageContext(self.message)
        context.cancel_epoch = 0
        self.manager.cancel_epochs[4] = 1
        bridge = Bridge.__new__(Bridge)
        bridge.authorize = AsyncMock()
        bridge.threads = self.manager
        with self.assertRaisesRegex(RuntimeError, '중지'):
            await bridge.request(context, 'ask', text='must not start')

    async def test_pc_provision_is_admin_visible_and_does_not_create_ticket(self):
        role, member = object(), object()
        channel = NS(id=2)
        guild = NS(fetch_channels=AsyncMock(return_value=[]), create_text_channel=AsyncMock(return_value=channel), default_role=role, me=member)
        self.bridge.allowed_guilds = {1}
        self.bridge.client.get_guild = lambda _: guild
        self.manager.state['bindings'] = {}
        self.manager.publish_panel = AsyncMock(return_value=(NS(id=8), True))
        result = await self.manager.provision(1, 'ai_talk')
        self.assertEqual(guild.create_text_channel.call_args.args[0], 'ai_talk')
        overwrites = guild.create_text_channel.call_args.kwargs['overwrites']
        self.assertFalse(overwrites[role].view_channel)
        self.assertTrue(overwrites[member].view_channel)
        self.assertEqual(result['panelId'], '8')
        self.bridge.request.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
