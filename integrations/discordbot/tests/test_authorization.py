import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge import Bridge


class AuthorizationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.role = NS(id=9, permissions=NS(administrator=True))
        self.guild = NS(id=2, owner_id=77, fetch_member=AsyncMock(return_value=NS(id=3, _roles=[9])), fetch_roles=AsyncMock(return_value=[self.role]))
        self.bridge = Bridge.__new__(Bridge)
        self.bridge.allowed_guilds = {2}
        self.bridge.owner = 88
        self.bridge.client = NS(fetch_guild=AsyncMock(return_value=self.guild))
        self.interaction = NS(guild_id=2, guild=self.guild, user=NS(id=3), channel_id=4)

    async def test_server_admin_need_not_be_bot_owner(self):
        await self.bridge.authorize(self.interaction)

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
