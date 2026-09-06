"""Optional compatibility adapter. Only this mode imports the old bot source."""
import os
import runpy
import sys

from standalone import account_lease, legacy_guard, read_connection


def run(settings, bridge_type, emit):
    root = os.path.abspath(settings['botDirectory'])
    connection = read_connection(root)
    with account_lease(connection['bot_token']):
        # Check before importing/initializing GUI. The original main takes over its slot.
        with legacy_guard():
            pass
        os.chdir(root)
        sys.path.insert(0, root)
        from bot.client import SecurityBotClient
        original_setup = SecurityBotClient.setup_hook
        original_ready = SecurityBotClient.on_ready
        original_disconnect = getattr(SecurityBotClient, 'on_disconnect', None)
        original_message = getattr(SecurityBotClient, 'on_message', None)

        async def setup(client):
            client._mr_robot_thread_state = settings.get('threadState')
            client._mr_robot_bridge = bridge_type(client)
            await client._mr_robot_bridge.setup()
            await original_setup(client)

        async def ready(client):
            await original_ready(client)
            bridge = client._mr_robot_bridge
            bridge.refresh_allowed_guilds()
            emit({'event': 'ready', 'owner': str(bridge.owner), 'guilds': [str(g) for g in bridge.allowed_guilds]})

        async def disconnected(client):
            emit({'event': 'disconnected'})
            if hasattr(client, '_mr_robot_bridge'):
                await client._mr_robot_bridge.threads.disconnected()
            if original_disconnect:
                await original_disconnect(client)

        async def message(client, value):
            await client._mr_robot_bridge.threads.on_message(value)
            if original_message:
                await original_message(client, value)

        replacements = {'setup_hook': setup, 'on_ready': ready, 'on_disconnect': disconnected, 'on_message': message}
        originals = {name: SecurityBotClient.__dict__.get(name) for name in replacements}
        try:
            for name, fn in replacements.items():
                setattr(SecurityBotClient, name, fn)
            runpy.run_path(os.path.join(root, 'main.py'), run_name='__main__')
        finally:
            for name, fn in originals.items():
                if fn is None:
                    delattr(SecurityBotClient, name)
                else:
                    setattr(SecurityBotClient, name, fn)
