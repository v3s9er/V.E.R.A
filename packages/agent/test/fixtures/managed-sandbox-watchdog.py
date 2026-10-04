"""Execute only host watchdog constants against synthetic /proc, files and time."""
import builtins
import io
import json
import math
import sys
import types

sources = json.load(sys.stdin)


class World:
    def __init__(self, deadline=None, users=()):
        self.now = 0.0
        self.files = {} if deadline is None else {'/guard/deadline': str(deadline)}
        self.users = list(users)

    def open(self, path, mode='r'):
        if path.startswith('/proc/') and path.endswith('/status'):
            index = int(path.split('/')[2]) - 1
            return io.StringIO('Uid:\t%d\t%d\t%d\t%d\n' % ((self.users[index],) * 4))
        assert path in ('/guard/deadline', '/guard/deadline.tmp')
        if mode == 'r':
            if path not in self.files:
                raise FileNotFoundError(path)
            return io.StringIO(self.files[path])
        assert mode == 'w'
        world = self

        class Write(io.StringIO):
            def close(self):
                world.files[path] = self.getvalue()
                super().close()

        return Write()

    def sleep(self, seconds):
        assert seconds == 0.05
        self.now += seconds
        assert self.now < 902, 'watchdog did not terminate'

    def unlink(self, path):
        if path not in self.files:
            raise FileNotFoundError(path)
        del self.files[path]

    def replace(self, before, after):
        self.files[after] = self.files.pop(before)

    def run(self, source, args=()):
        def exit_(code=0):
            raise SystemExit(code)
        modules = {
            'math': math,
            'time': types.SimpleNamespace(monotonic=lambda: self.now, sleep=self.sleep),
            'sys': types.SimpleNamespace(argv=['host-control', *args], exit=exit_),
            'os': types.SimpleNamespace(listdir=lambda path: [str(i + 1) for i in range(len(self.users))] if path == '/proc' else [], replace=self.replace, unlink=self.unlink),
        }
        safe = dict(vars(builtins))
        safe['open'] = self.open
        safe['__import__'] = lambda name, *a, **kw: modules[name]
        safe['print'] = lambda *a, **kw: None
        exec(compile(source, '<host-watchdog-fixture>', 'exec'), {'__builtins__': safe})


for deadline, lower, upper in ((1, 1, 1.06), (None, 900, 900.06), (9999, 900, 900.06), ('NaN', 0, 0), ('invalid', 0, 0)):
    world = World(deadline)
    world.run(sources['watchdog'])
    assert lower <= world.now <= upper, (deadline, world.now)

world = World(users=[65533])
world.run(sources['control'], ['arm', '3'])
assert float(world.files['/guard/deadline']) == 3
world.run(sources['control'], ['finish', '3'])
assert '/guard/deadline' not in world.files

world = World(deadline=2, users=[65533, 65534])
world.run(sources['control'], ['finish', '120'])
assert world.files['/guard/deadline'] == '2', 'background deadline must stay armed'
try:
    world.run(sources['control'], ['arm', '120'])
    raise AssertionError('background work was allowed to extend its deadline')
except SystemExit as error:
    assert error.code == 75
assert world.files['/guard/deadline'] == '2'
print('watchdog: deadline, absolute lifetime, corrupt fail-closed, idle disarm, background no-extension passed')
