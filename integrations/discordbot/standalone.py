"""Self-contained Discord runtime. Reads credentials, never imports bot source."""
import hashlib
import json
import os
import socket
import tempfile
import threading
from contextlib import contextmanager

import discord


class RuntimeFailure(Exception):
    """Only a fixed error code may cross the private bridge."""


def read_connection(directory):
    try:
        with open(os.path.join(directory, 'config.json'), encoding='utf-8-sig') as stream:
            content = stream.read(1_048_577)
        if len(content) > 1_048_576:
            raise ValueError()
        data = json.loads(content)
        token = data.get('bot_token') if isinstance(data, dict) else None
        if not isinstance(token, str) or not token.strip() or len(token) > 512 or any(c.isspace() for c in token.strip()):
            raise ValueError()
        name = data.get('server_name', '')
        # Nothing else from the security bot's configuration enters this runtime.
        return {'bot_token': token.strip(), 'server_name': name if isinstance(name, str) else ''}
    except (OSError, ValueError, TypeError):
        raise RuntimeFailure('config') from None


@contextmanager
def account_lease(token, directory=None):
    # Account portion, not the secret portion; also survives token rotation.
    key = hashlib.sha256(token.split('.')[0].encode()).hexdigest()
    root = directory or os.path.join(tempfile.gettempdir(), 'mr-robot-discord-locks')
    os.makedirs(root, mode=0o700, exist_ok=True)
    stream = open(os.path.join(root, key + '.lock'), 'a+b')
    acquired = False
    try:
        if os.fstat(stream.fileno()).st_size == 0:
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except OSError:
            raise RuntimeFailure('duplicate') from None
        yield
    finally:
        if acquired:
            if os.name == 'nt':
                import msvcrt
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_UN)
        stream.close()  # OS also releases the lease on forced process termination.


@contextmanager
def legacy_guard(port=47823):
    """Reserve the existing bot's single-instance slot; no credential/RPC listener."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        listener.bind(('127.0.0.1', port))
        listener.listen(2)
        listener.settimeout(0.25)
    except OSError:
        listener.close()
        raise RuntimeFailure('duplicate') from None
    done = threading.Event()

    def drain():
        while not done.is_set():
            try:
                connection, _ = listener.accept()
                connection.close()  # Original bot's SHOW probe: no data consumed/executed.
            except socket.timeout:
                continue
            except OSError:
                return

    worker = threading.Thread(target=drain, daemon=True, name='DiscordSingleInstance')
    worker.start()
    try:
        yield
    finally:
        done.set()
        listener.close()
        worker.join(timeout=1)


def make_client(connection, thread_state, bridge_type, emit):
    class AgentClient(discord.Client):
        def __init__(self):
            intents = discord.Intents.none()
            intents.guilds = True
            intents.guild_messages = True
            super().__init__(intents=intents, allowed_mentions=discord.AllowedMentions.none(), max_messages=100)
            self.config = {'server_name': connection['server_name']}
            self._mr_robot_thread_state = thread_state

        async def setup_hook(self):
            self._mr_robot_bridge = bridge_type(self)
            await self._mr_robot_bridge.setup()

        async def on_ready(self):
            bridge = self._mr_robot_bridge
            bridge.refresh_allowed_guilds()
            emit({'event': 'ready', 'owner': str(bridge.owner), 'guilds': [str(g) for g in bridge.allowed_guilds]})

        async def on_disconnect(self):
            emit({'event': 'disconnected'})
            if hasattr(self, '_mr_robot_bridge'):
                await self._mr_robot_bridge.threads.disconnected()

        async def on_message(self, message):
            await self._mr_robot_bridge.threads.on_message(message)

    return AgentClient()


def run(settings, bridge_type, emit):
    connection = read_connection(settings['botDirectory'])
    with account_lease(connection['bot_token']), legacy_guard():
        client = make_client(connection, settings.get('threadState'), bridge_type, emit)
        client.run(connection['bot_token'], log_handler=None)
