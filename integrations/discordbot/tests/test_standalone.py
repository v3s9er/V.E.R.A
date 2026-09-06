import asyncio
import io
import json
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from standalone import RuntimeFailure, account_lease, legacy_guard, make_client, read_connection, run
import bridge


class ConnectionTests(unittest.TestCase):
    def test_only_connection_fields_are_read_and_source_is_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'config.json'
            payload = json.dumps({'bot_token': 'fixture.account.token', 'server_name': 'test', 'news': {'private': 'not-needed'}})
            path.write_text(payload, encoding='utf-8-sig')
            self.assertEqual(read_connection(folder), {'bot_token': 'fixture.account.token', 'server_name': 'test'})
            self.assertEqual(path.read_text(encoding='utf-8-sig'), payload)
            self.assertFalse((Path(folder) / 'bot').exists())

    def test_bad_credentials_are_redacted(self):
        for payload in ['[]', '{bad', '{"bot_token":""}', '{"bot_token":123}', '{"bot_token":"secret invalid"}']:
            with patch('builtins.open', unittest.mock.mock_open(read_data=payload)):
                with self.assertRaisesRegex(RuntimeFailure, '^config$'):
                    read_connection('unused')

    def test_shared_account_lease_and_release_after_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            with account_lease('same-account.secret-a', folder):
                with self.assertRaisesRegex(RuntimeFailure, '^duplicate$'):
                    with account_lease('same-account.secret-b', folder):
                        self.fail('same account connected twice')
                with account_lease('other-account.secret', folder):
                    pass
            with account_lease('same-account.new-secret', folder):
                pass

    def test_legacy_running_is_rejected_and_standalone_blocks_legacy_probe(self):
        with socket.socket() as reserved:
            reserved.bind(('127.0.0.1', 0))
            port = reserved.getsockname()[1]
            reserved.listen(1)
            with self.assertRaisesRegex(RuntimeFailure, '^duplicate$'):
                with legacy_guard(port):
                    self.fail('legacy process not rejected')
        with legacy_guard(port):
            with socket.create_connection(('127.0.0.1', port), timeout=1) as probe:
                self.assertEqual(probe.recv(16), b'')
        with legacy_guard(port):
            pass  # lock is released, no permanently stale marker.

    def test_dispatch_defaults_to_standalone_without_importing_legacy(self):
        with patch.object(sys, 'stdin', io.StringIO('{"botDirectory":"fixture"}\n')), patch('standalone.run') as execute:
            with patch.dict(sys.modules, {'legacy_adapter': None, 'bot': None, 'bot.client': None}):
                bridge.main()
            self.assertEqual(execute.call_count, 1)

    def test_startup_error_does_not_publish_exception_details(self):
        with patch.object(sys, 'stdin', io.StringIO('{"botDirectory":"fixture"}\n')), patch('standalone.run', side_effect=ValueError('sensitive-fixture')), patch.object(bridge, 'emit') as emit:
            with self.assertRaises(SystemExit):
                bridge.main()
            emit.assert_called_once_with({'event': 'error', 'code': 'startup'})


class ClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_client_lifecycle_and_tickets_use_agent_bridge_only(self):
        threads = NS(disconnected=AsyncMock(), on_message=AsyncMock())
        linked = NS(setup=AsyncMock(), refresh_allowed_guilds=Mock(), owner=123, allowed_guilds={456}, threads=threads)
        factory = Mock(return_value=linked)
        emit = Mock()
        client = make_client({'bot_token': 'never-store-me', 'server_name': 'test'}, {'sessions': {}}, factory, emit)
        self.assertNotIn('bot_token', client.config)
        self.assertFalse(client.intents.members)
        self.assertFalse(client.intents.presences)
        await client.setup_hook()
        factory.assert_called_once_with(client)
        await client.on_ready()
        emit.assert_called_with({'event': 'ready', 'owner': '123', 'guilds': ['456']})
        message = object()
        await client.on_message(message)
        threads.on_message.assert_awaited_once_with(message)
        await client.on_disconnect()
        threads.disconnected.assert_awaited_once()
        self.assertFalse(linked.gateway_ready)
        await client.on_resumed()
        self.assertTrue(linked.gateway_ready)
        self.assertEqual(sum(call.args[0].get('event') == 'ready' for call in emit.call_args_list), 2)
        for _ in range(3):
            await client.on_disconnect()
            await client.on_resumed()
            self.assertTrue(linked.gateway_ready)
        await client.close()

    async def test_config_only_run_without_any_security_source(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'config.json').write_text('{"bot_token":"fake-account.test"}', encoding='utf-8')
            client = Mock()
            with patch('standalone.legacy_guard'), patch('standalone.make_client', return_value=client), patch.dict(sys.modules, {'bot': None, 'bot.client': None, 'legacy_adapter': None}):
                run({'botDirectory': folder}, Mock(), Mock())
            client.run.assert_called_once_with('fake-account.test', log_handler=None)


if __name__ == '__main__':
    unittest.main()
