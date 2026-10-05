import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch
import discord

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge import Bridge


class AdminCommands(unittest.IsolatedAsyncioTestCase):
    async def test_public_schema_has_no_model_knobs_and_admin_root_is_hidden_by_default(self):
        client = discord.Client(intents=discord.Intents.none())
        client.application_info = AsyncMock(return_value=NS(flags=NS(gateway_message_content=False, gateway_message_content_limited=False), team=None, owner=NS(id=1)))
        client.http.upsert_global_command = AsyncMock()
        bridge = Bridge(client)
        with patch('bridge._reader_started', True):
            await bridge.setup()
        payloads = {call.args[1]['name']: call.args[1] for call in client.http.upsert_global_command.call_args_list}
        self.assertEqual(set(payloads), {'robot', 'robot-admin'})
        public = payloads['robot']['options']
        self.assertFalse({'model', 'models', 'model-limit'} & {command['name'] for command in public})
        ask = next(command for command in public if command['name'] == 'ask')
        self.assertEqual({option['name'] for option in ask['options']}, {'message', 'file'})
        self.assertEqual(int(payloads['robot-admin']['default_member_permissions']), discord.Permissions(administrator=True).value)
        self.assertIn('model', {command['name'] for command in payloads['robot-admin']['options']})
        await client.close()
