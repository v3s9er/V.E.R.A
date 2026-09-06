import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from attachment_cache import ExcerptCache
from presentation import message_chunks
from thread_sessions import ThreadManager


class CacheTests(unittest.TestCase):
    def test_identity_ttl_bound_and_copy(self):
        now = [0]
        cache = ExcerptCache(max_bytes=160, ttl=5, clock=lambda: now[0])
        cache.put(('user1', 'ticket1', 'hash'), {'text': 'private'})
        self.assertIsNone(cache.get(('user2', 'ticket1', 'hash')))
        value = cache.get(('user1', 'ticket1', 'hash'))
        value['text'] = 'tampered'
        self.assertEqual(cache.get(('user1', 'ticket1', 'hash'))['text'], 'private')
        for i in range(100):
            cache.put(i, {'text': 'x' * 20})
        self.assertLessEqual(cache.size, 160)
        now[0] = 6
        cache.prune()
        self.assertEqual(cache.size, 0)

    def test_chunks_preserve_every_character_and_utf16_limit(self):
        original = ('한글 문단 😀\n\n' * 1000) + '```\nlong code\n```'
        chunks = message_chunks(original)
        self.assertEqual(''.join(chunks), original)
        self.assertTrue(all(len(c.encode('utf-16-le')) // 2 <= 1750 for c in chunks))


class SchedulingTests(unittest.IsolatedAsyncioTestCase):
    async def test_parallel_fairness_same_user_serial_and_full_exclusive(self):
        for full in [False, True]:
            bridge = NS(active={}, gateway_ready=True, request=AsyncMock(return_value={'access': 'full' if full else 'isolated', 'canStart': True}))
            manager = ThreadManager(bridge, {'bindings': {}, 'sessions': {}})
            active, peak, order = set(), [0], []
            async def run(context, text, status):
                self.assertNotIn(context.user.id, active)
                active.add(context.user.id)
                order.append(context.user.id)
                peak[0] = max(peak[0], len(active))
                await asyncio.sleep(.08)
                active.remove(context.user.id)
            manager.run_item = run
            for user in [1, 1, 2, 3]:
                manager.queue.append((NS(guild_id=1, user=NS(id=user), channel_id=user), 'task', NS(edit=AsyncMock())))
            await asyncio.wait_for(manager.drain(), 6)
            self.assertEqual(peak[0], 1 if full else 2)
            self.assertNotEqual(order[1], 1, 'a second user runs before first user gets another slot')
            self.assertFalse(manager.running)

    async def test_disconnect_keeps_unstarted_queue(self):
        bridge = NS(active={}, gateway_ready=False, request=AsyncMock(return_value={'access': 'isolated', 'canStart': True}))
        manager = ThreadManager(bridge, {'bindings': {}, 'sessions': {}})
        manager.run_item = AsyncMock()
        manager.queue.append((NS(guild_id=1, user=NS(id=1), channel_id=1), 'task', NS(edit=AsyncMock())))
        task = asyncio.create_task(manager.drain())
        await asyncio.sleep(.1)
        manager.run_item.assert_not_awaited()
        self.assertEqual(len(manager.queue), 1)
        bridge.gateway_ready = True
        await asyncio.wait_for(task, 2)
        manager.run_item.assert_awaited_once()
