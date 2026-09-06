"""Bounded, process-local excerpts. Never shared across a user/ticket boundary."""
from collections import OrderedDict
import asyncio
from copy import deepcopy
import json
import time


class ExcerptCache:
    def __init__(self, max_bytes=4 * 1024 * 1024, ttl=300, clock=time.monotonic):
        self.entries = OrderedDict()
        self.size = 0
        self.max_bytes, self.ttl, self.clock = max_bytes, ttl, clock
        self.timer = None

    def sweep(self):
        self.timer = None
        self.prune()
        self.schedule()

    def schedule(self):
        if self.timer is not None or not self.entries:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        delay = max(.01, min(v[0] for v in self.entries.values()) - self.clock())
        self.timer = loop.call_later(delay, self.sweep)

    def prune(self):
        for key, (expiry, size, _) in list(self.entries.items()):
            if expiry <= self.clock():
                self.entries.pop(key)
                self.size -= size

    def get(self, key):
        self.prune()
        entry = self.entries.get(key)
        if entry is None:
            return None
        self.entries.move_to_end(key)
        return deepcopy(entry[2])

    def put(self, key, value):
        self.prune()
        size = len(json.dumps(value, ensure_ascii=False).encode('utf-8'))
        if size > self.max_bytes:
            return
        old = self.entries.pop(key, None)
        if old:
            self.size -= old[1]
        while self.entries and (self.size + size > self.max_bytes or len(self.entries) >= 32):
            _, (_, removed, _) = self.entries.popitem(last=False)
            self.size -= removed
        self.entries[key] = (self.clock() + self.ttl, size, deepcopy(value))
        self.size += size
        self.schedule()


excerpts = ExcerptCache()
