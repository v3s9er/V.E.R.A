import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, mock_open, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge import Bridge, allowed_guilds_from_store


class AllowedGuildTests(unittest.TestCase):
    def setUp(self):
        self.guilds = [NS(id=111111111111111111, name='original'), NS(id=222222222222222222, name='additional'), NS(id=333333333333333333, name='unapproved')]

    def resolve(self, content):
        with patch('builtins.open', mock_open(read_data=content)):
            return allowed_guilds_from_store(self.guilds, 'original', 'fixture.json')

    def test_explicit_multiple_servers_override_legacy_single_name(self):
        self.assertEqual(self.resolve('{"allowedGuildIds":["111111111111111111","222222222222222222","444444444444444444"]}'), {111111111111111111, 222222222222222222})

    def test_empty_corrupt_and_invalid_allowlist_fail_closed(self):
        for content in ['{"allowedGuildIds":[]}', '{broken', '{"allowedGuildIds":"all"}', '[]', '{"allowedGuildIds":["everyone",222222222222222222]}']:
            self.assertEqual(self.resolve(content), set())

    def test_missing_store_retains_one_server_bootstrap(self):
        with patch('builtins.open', side_effect=FileNotFoundError):
            self.assertEqual(allowed_guilds_from_store(self.guilds, 'original', 'fixture.json'), {111111111111111111})

    def test_unreadable_store_does_not_fall_back(self):
        with patch('builtins.open', side_effect=PermissionError):
            self.assertEqual(allowed_guilds_from_store(self.guilds, 'original', 'fixture.json'), set())

    def test_removed_server_is_not_kept_in_cached_allowlist(self):
        self.assertIn(222222222222222222, self.resolve('{"allowedGuildIds":["222222222222222222"]}'))
        self.assertNotIn(222222222222222222, self.resolve('{"allowedGuildIds":["111111111111111111"]}'))


class AuthorizationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.role = NS(id=9, name='admin', permissions=NS(administrator=True))
        self.guild = NS(id=2, owner_id=77, fetch_member=AsyncMock(return_value=NS(id=3, _roles=[9])), fetch_roles=AsyncMock(return_value=[self.role]))
        self.bridge = Bridge.__new__(Bridge)
        self.bridge.allowed_guilds = {2}
        self.bridge.owner = 88
        self.bridge.client = NS(fetch_guild=AsyncMock(return_value=self.guild))
        self.interaction = NS(guild_id=2, guild=self.guild, user=NS(id=3), channel_id=4)

    async def test_server_admin_need_not_be_bot_owner(self):
        await self.bridge.authorize(self.interaction)

    async def test_ticket_needs_exact_live_allow_ai_role_even_for_admin(self):
        with self.assertRaisesRegex(PermissionError, 'allow_ai'):
            await self.bridge.authorize_ticket(self.interaction)
        role = NS(id=10, name='allow_ai', permissions=NS(administrator=False))
        self.guild.fetch_roles.return_value.append(role)
        self.guild.fetch_member.return_value._roles.append(10)
        await self.bridge.authorize_ticket(self.interaction)
        for name in ['Allow_AI', 'allow_ai_fake', 'renamed']:
            role.name = name
            with self.assertRaisesRegex(PermissionError, 'allow_ai'):
                await self.bridge.authorize_ticket(self.interaction)
        role.name = 'allow_ai'
        self.guild.fetch_member.return_value._roles.remove(10)
        with self.assertRaisesRegex(PermissionError, 'allow_ai'):
            await self.bridge.authorize_ticket(self.interaction)

    async def test_ticket_register_rechecks_role_and_does_not_emit_on_denial(self):
        with patch('bridge.emit') as emit:
            with self.assertRaisesRegex(PermissionError, 'allow_ai'):
                await self.bridge.request(self.interaction, 'thread.register', threadId='444444444444444444')
            emit.assert_not_called()

    async def test_request_cannot_forge_authority(self):
        for field in ['allowAi', 'guildAdmin', 'guildId', 'userId']:
            with patch('bridge.emit') as emit:
                with self.assertRaises(PermissionError):
                    await self.bridge.request(self.interaction, 'thread.register', **{field: True})
                emit.assert_not_called()

    async def test_ticket_role_does_not_grant_pc_admin(self):
        self.role.name = 'allow_ai'
        self.role.permissions.administrator = False
        with self.assertRaises(PermissionError):
            await self.bridge.authorize_ticket(self.interaction)

    async def test_role_revocation_is_live(self):
        await self.bridge.authorize(self.interaction)
        self.role.permissions.administrator = False
        with self.assertRaises(PermissionError):
            await self.bridge.authorize(self.interaction)

    async def test_bot_owner_has_no_bypass(self):
        self.bridge.owner = 3
        self.role.permissions.administrator = False
        with self.assertRaises(PermissionError):
            await self.bridge.authorize(self.interaction)

    async def test_permission_and_model_limit_requests_recheck_live_admin_before_emitting(self):
        self.role.permissions.administrator = False
        for action in ['access', 'model-limit']:
            with patch('bridge.emit') as emit:
                with self.assertRaises(PermissionError):
                    await self.bridge.request(self.interaction, action, mode='full', confirmFull=True, targetUserId='333333333333333333', ceiling='unlimited')
                emit.assert_not_called()

    async def test_model_limit_rejects_bot_target(self):
        self.guild.fetch_member.return_value = NS(id=3, _roles=[9], bot=True)
        with patch('bridge.emit') as emit:
            with self.assertRaises(PermissionError):
                await self.bridge.request(self.interaction, 'model-limit', targetUserId='333333333333333333', ceiling='sol')
            emit.assert_not_called()

    async def test_dm_and_other_server_denied(self):
        for guild_id in (None, 99):
            self.interaction.guild_id = guild_id
            with self.assertRaises(PermissionError):
                await self.bridge.authorize(self.interaction)
        self.bridge.client.fetch_guild.assert_not_called()

    async def test_scopes_include_server_channel_and_actor(self):
        self.assertEqual(self.bridge.scope_key(self.interaction), '2:4:3')


if __name__ == '__main__':
    unittest.main()
