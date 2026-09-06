import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock

import discord
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from thread_sessions import Controls, Confirm, ModelPicker, ThreadManager


class ControlsTests(unittest.IsolatedAsyncioTestCase):
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
        self.assertIn('모델 선택', [getattr(c, 'label', '') for c in current.children])
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
        self.assertEqual(len(selectors[1].options[1].label), 100)
        selectors[1]._values = ['1']
        await selectors[1].callback(self.context)
        self.assertEqual(self.bridge.request.call_args.kwargs['model'], long_id)
        self.assertEqual(self.bridge.request.call_args.args[1], 'settings')
        next_model = next(c for c in picker.children if getattr(c, 'label', '') == '모델 다음')
        await next_model.callback(self.context)
        self.assertEqual(picker.model_page, 1)
        self.assertEqual(next(c for c in picker.children if isinstance(c, discord.ui.Select) and c.row == 1).options[0].value, '25')
        picker.stop()

    async def test_model_discovery_failure_keeps_configured_model(self):
        self.bridge.request.side_effect = RuntimeError('offline')
        picker = ModelPicker(self.manager, 3, [{'providerId': 'p', 'name': 'Offline', 'model': 'configured'}], {})
        await picker.load(self.context)
        self.assertEqual(picker.models, ['configured'])
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
        self.assertIn('상한 sol', picker.caption())
        picker.stop()

    async def test_limited_discovery_failure_does_not_fall_back_above_cap(self):
        self.bridge.request.side_effect = RuntimeError('offline')
        picker = ModelPicker(self.manager, 3, [{'providerId': 'p', 'name': 'Codex', 'model': 'gpt-6-astra', 'modelCeiling': 'sol'}], {})
        await picker.load(self.context)
        self.assertEqual(picker.models, [])
        picker.stop()

    async def test_confirmation_retains_cancel_button(self):
        view = Confirm(self.manager, self.context, 'full')
        self.assertEqual([c.label for c in view.children], ['확인', '취소'])
        view.stop()
