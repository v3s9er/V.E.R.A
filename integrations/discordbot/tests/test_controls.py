import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, Mock
import asyncio

import discord
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from thread_sessions import Controls, Confirm, ModelPicker, ThreadManager, model_reasoning_efforts


class ControlsTests(unittest.IsolatedAsyncioTestCase):
    async def test_legacy_controls_only_touch_bot_views_in_matching_open_tickets(self):
        bridge = NS(allowed_guilds={1}, client=NS(user=NS(id=99), fetch_channel=AsyncMock()))
        state = {'bindings': {'1': '2'}, 'sessions': {
            '4': {'ownerId': '3', 'guildId': '1', 'parentId': '2'},
            '5': {'ownerId': '3', 'guildId': '1', 'parentId': '2', 'archived': True},
            '6': {'ownerId': '3', 'guildId': '2', 'parentId': '2'},
            '7': {'ownerId': '3', 'guildId': '1', 'parentId': '2'}}}
        manager = ThreadManager(bridge, state)
        component = NS(children=[NS(custom_id='mrrobot:thread:model:v1')])
        own = NS(author=NS(id=99), components=[component], edit=AsyncMock())
        foreign = NS(author=NS(id=3), components=[component], edit=AsyncMock())
        plain = NS(author=NS(id=99), components=[], edit=AsyncMock())
        async def history():
            for message in (own, foreign, plain):
                yield message
        channel = Mock(spec=discord.Thread, archived=False, locked=False, guild=NS(id=1), parent_id=2)
        channel.history = Mock(side_effect=lambda **kw: history())
        wrong_parent = Mock(spec=discord.Thread, archived=False, locked=False, guild=NS(id=1), parent_id=8)
        bridge.client.fetch_channel.side_effect = [channel, wrong_parent]
        await manager.refresh_legacy_controls()
        self.assertEqual([call.args[0] for call in bridge.client.fetch_channel.call_args_list], [4, 7])
        channel.history.assert_called_once_with(limit=100)
        own.edit.assert_awaited_once()
        self.assertEqual(set(own.edit.call_args.kwargs), {'view'})
        view = own.edit.call_args.kwargs['view']
        self.assertFalse(any(getattr(c, 'custom_id', '') == 'mrrobot:thread:model:v1' for c in view.children))
        view.stop()
        foreign.edit.assert_not_awaited()
        plain.edit.assert_not_awaited()
        self.assertEqual(manager.refreshed_controls, {'4'})

    async def test_disconnect_cancels_background_control_refresh(self):
        manager = ThreadManager(NS(), {'bindings': {}, 'sessions': {}})
        manager.refresh_legacy_controls = AsyncMock(side_effect=lambda: None)
        async def waiting():
            await asyncio.Event().wait()
        manager.refresh_legacy_controls.side_effect = waiting
        manager.schedule_control_refresh()
        await asyncio.sleep(0)
        task = manager.controls_refresh
        await manager.disconnected()
        self.assertTrue(task.cancelled())

    async def asyncSetUp(self):
        self.bridge = NS(authorize=AsyncMock(), request=AsyncMock(), client=NS())
        self.manager = ThreadManager(self.bridge, {'bindings': {'1': '2'}, 'sessions': {'4': {'ownerId': '3', 'guildId': '1'}}})
        self.context = NS(user=NS(id=3), guild_id=1, channel_id=4, response=NS(defer=AsyncMock(), edit_message=AsyncMock()), edit_original_response=AsyncMock())

    async def test_recent_response_moves_controls_and_disposes_old_view(self):
        first, second = NS(edit=AsyncMock()), NS(edit=AsyncMock())
        channel = NS(id=4, send=AsyncMock(side_effect=[first, second]))
        await self.manager.send_controls(channel, 'working')
        old = self.manager.latest_controls[4][1]
        await self.manager.send_controls(channel, 'finished')
        first.edit.assert_awaited_once_with(view=None)
        self.assertTrue(old.is_finished())
        current = self.manager.latest_controls[4][1]
        self.assertTrue(current.is_persistent())
        self.assertNotIn('모델 선택', [getattr(c, 'label', '') for c in current.children])
        self.assertFalse(any(getattr(c, 'custom_id', '') == 'mrrobot:thread:model:v1' for c in current.children))
        self.assertTrue(any(isinstance(c, discord.ui.Select) for c in current.children))
        self.manager.update_state({'bindings': {}, 'sessions': {}})
        self.assertTrue(current.is_finished())
        self.assertFalse(self.manager.latest_controls)

    async def test_model_paging_and_full_id_selection_are_saved(self):
        providers = [{'providerId': str(i), 'name': f'Provider {i}', 'model': 'default', 'supportedReasoning': ['auto', 'high']} for i in range(30)]
        long_id = 'model-' + 'a' * 130
        self.bridge.request.return_value = [long_id, *[f'm{i}' for i in range(60)]]
        picker = ModelPicker(self.manager, 3, providers, {})
        await picker.load(self.context)
        selectors = [c for c in picker.children if isinstance(c, discord.ui.Select)]
        self.assertEqual(len(selectors), 3)
        self.assertTrue(all(len(s.options) <= 25 for s in selectors))
        self.assertEqual(len(selectors[1].options[0].label), 100)
        selectors[1]._values = ['0']
        await selectors[1].callback(self.context)
        self.assertEqual(self.bridge.request.call_args.args[1], 'models', 'draft selection must not save')
        self.bridge.request.return_value = {'message': 'saved'}
        await next(c for c in picker.children if getattr(c, 'label', '') == '저장').callback(self.context)
        self.assertEqual(self.bridge.request.call_args.kwargs['model'], long_id)
        self.assertEqual(self.bridge.request.call_args.args[1], 'model-policy')
        self.assertEqual(self.bridge.request.call_args.kwargs['targetUserId'], '3')
        next_model = next(c for c in picker.children if getattr(c, 'label', '') == '모델 다음')
        await next_model.callback(self.context)
        self.assertEqual(picker.model_page, 1)
        self.assertEqual(next(c for c in picker.children if isinstance(c, discord.ui.Select) and c.row == 1).options[0].value, '25')
        picker.stop()

    async def test_model_discovery_failure_never_guesses_configured_model(self):
        self.bridge.request.side_effect = RuntimeError('offline')
        picker = ModelPicker(self.manager, 3, [{'providerId': 'p', 'name': 'Offline', 'model': 'configured'}], {})
        await picker.load(self.context)
        self.assertEqual(picker.models, [])
        self.assertTrue(next(c for c in picker.children if getattr(c, 'label', '') == '저장').disabled)
        self.assertIn('실패', picker.caption())
        picker.stop()

    async def test_other_actor_cannot_operate_picker(self):
        picker = ModelPicker(self.manager, 3, [], {})
        self.context.user.id = 5
        self.assertFalse(await picker.interaction_check(self.context))
        self.bridge.authorize.assert_not_awaited()
        picker.stop()

    async def test_limited_picker_does_not_reinsert_stale_high_model(self):
        self.bridge.request.return_value = ['gpt-5.6-sol', 'gpt-5.6-terra']
        picker = ModelPicker(self.manager, 3, [{'providerId': 'p', 'name': 'Codex', 'model': '', 'modelCeiling': 'sol'}], {'providerId': 'p', 'model': 'gpt-6-astra'})
        await picker.load(self.context)
        self.assertEqual(picker.models, ['gpt-5.6-sol', 'gpt-5.6-terra'])
        self.assertNotIn('상한', picker.caption())
        self.assertIn('관리자 전용', picker.caption())
        picker.stop()

    async def test_limited_discovery_failure_does_not_fall_back_above_cap(self):
        self.bridge.request.side_effect = RuntimeError('offline')
        picker = ModelPicker(self.manager, 3, [{'providerId': 'p', 'name': 'Codex', 'model': 'gpt-6-astra', 'modelCeiling': 'sol'}], {})
        await picker.load(self.context)
        self.assertEqual(picker.models, [])
        picker.stop()

    async def test_explicit_sol_grant_selects_gpt6_sol_without_pc_access_request(self):
        self.bridge.request.return_value = {'models': ['gpt-6-sol', 'gpt-5.6-sol'], 'modelCeiling': 'sol', 'modelPolicyEnforced': True}
        picker = ModelPicker(self.manager, 3, [{'providerId': 'p', 'name': 'Codex', 'type': 'codex-cli', 'modelCeiling': 'default', 'modelPolicyEnforced': True}], {})
        await picker.load(self.context)
        self.assertIn('관리자 전용', picker.caption())
        selector = next(c for c in picker.children if isinstance(c, discord.ui.Select) and c.row == 1)
        selector._values = ['0']
        await selector.callback(self.context)
        self.bridge.request.return_value = {'message': 'saved'}
        await next(c for c in picker.children if getattr(c, 'label', '') == '저장').callback(self.context)
        self.assertEqual(self.bridge.request.call_args.args[1], 'model-policy')
        self.assertEqual(self.bridge.request.call_args.kwargs, {'mode': 'set', 'targetUserId': '3', 'providerId': 'p', 'model': 'gpt-6-sol', 'effort': 'auto'})
        picker.stop()

    async def test_explicit_astra_grant_and_revocation_refresh_live_catalog(self):
        provider = {'providerId': 'p', 'name': 'Codex', 'model': 'gpt-6-astra', 'modelCeiling': 'astra', 'modelPolicyEnforced': True}
        self.bridge.request.return_value = {'models': ['gpt-6-astra', 'gpt-6-sol'], 'modelCeiling': 'astra', 'modelPolicyEnforced': True}
        picker = ModelPicker(self.manager, 3, [provider], {'providerId': 'p', 'model': 'gpt-6-astra'})
        await picker.load(self.context)
        self.assertEqual(picker.models, ['gpt-6-astra', 'gpt-6-sol'])
        self.bridge.request.side_effect = [[{**provider, 'model': '', 'modelCeiling': 'default'}], {'models': ['gpt-5.6-sol'], 'modelCeiling': 'default', 'modelPolicyEnforced': True}]
        refresh = next(c for c in picker.children if getattr(c, 'label', '') == '모델 새로고침')
        await refresh.callback(self.context)
        self.assertEqual(picker.models, ['gpt-5.6-sol'])
        self.assertTrue(next(c for c in picker.children if getattr(c, 'label', '') == '저장').disabled)
        picker.stop()

    async def test_host_enforced_catalog_never_reinserts_unlimited_stale_model(self):
        provider = {'providerId': 'p', 'name': 'Codex', 'model': 'gpt-6-astra', 'modelCeiling': 'unlimited', 'modelPolicyEnforced': True}
        self.bridge.request.side_effect = RuntimeError('offline')
        picker = ModelPicker(self.manager, 3, [provider], {'providerId': 'p', 'model': 'gpt-6-sol'})
        await picker.load(self.context)
        self.assertEqual(picker.models, [])
        picker.stop()

    async def test_confirmation_retains_cancel_button(self):
        view = Confirm(self.manager, self.context, 'full')
        self.assertEqual([c.label for c in view.children], ['확인', '취소'])
        view.stop()

    async def test_reasoning_uses_selected_model_capabilities_and_resets_unsupported_effort(self):
        provider = {'providerId': 'p', 'name': 'Codex', 'type': 'codex-cli', 'model': 'model-a', 'supportedReasoning': ['auto', 'ultra']}
        capabilities = {'model-a': {'supportedReasoningEfforts': ['low', 'ultra']}, 'model-b': {'supportedReasoningEfforts': ['low', 'max']}}
        self.bridge.request.return_value = {'models': ['model-a', 'model-b'], 'modelCapabilities': capabilities}
        picker = ModelPicker(self.manager, 3, [provider], {'providerId': 'p', 'model': 'model-a', 'effort': 'ultra'})
        await picker.load(self.context)
        reasoning = next(c for c in picker.children if isinstance(c, discord.ui.Select) and c.row == 2)
        self.assertEqual([option.value for option in reasoning.options], ['auto', 'low', 'ultra'])
        models = next(c for c in picker.children if isinstance(c, discord.ui.Select) and c.row == 1)
        models._values = ['1']
        await models.callback(self.context)
        self.assertEqual(picker.preference['effort'], 'auto')
        reasoning = next(c for c in picker.children if isinstance(c, discord.ui.Select) and c.row == 2)
        self.assertEqual([option.value for option in reasoning.options], ['auto', 'low', 'max'])
        self.assertEqual(model_reasoning_efforts(provider, 'unknown', capabilities), ['auto'])
        self.assertEqual(model_reasoning_efforts(provider, 'model-a', {}), ['auto'])
        picker.stop()

    async def test_assigned_target_is_not_actor_and_demotion_blocks_old_picker(self):
        picker = ModelPicker(self.manager, 3, [{'providerId': 'p', 'model': 'm'}], {}, target_user_id=7, guild_id=1)
        self.bridge.request.return_value = ['m']
        await picker.load(self.context)
        self.assertTrue(await picker.interaction_check(self.context))
        self.bridge.authorize.assert_awaited_with(self.context, admin_only=True)
        selector = next(c for c in picker.children if isinstance(c, discord.ui.Select) and c.row == 1)
        selector._values = ['0']
        await selector.callback(self.context)
        self.bridge.request.return_value = {'message': 'saved'}
        await next(c for c in picker.children if getattr(c, 'label', '') == '저장').callback(self.context)
        self.assertEqual(self.bridge.request.call_args.kwargs['targetUserId'], '7')
        self.bridge.authorize.side_effect = PermissionError('not admin')
        with self.assertRaises(PermissionError):
            await picker.interaction_check(self.context)
        self.context.guild_id = 2
        self.assertFalse(await picker.interaction_check(self.context))
        picker.stop()

    async def test_ordinary_status_has_no_settings_view(self):
        self.bridge.request.return_value = {'canManageModels': False, 'message': '요청 가능'}
        self.context.followup = NS(send=AsyncMock())
        view = Controls(self.manager)
        button = next(c for c in view.children if getattr(c, 'custom_id', '') == 'mrrobot:thread:settings:v1')
        await button.callback(self.context)
        self.assertIsNone(self.context.followup.send.call_args.kwargs['view'])
        view.stop()
