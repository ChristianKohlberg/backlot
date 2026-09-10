import ctypes
import json
import os
import sys
import time

if sys.platform == 'linux':
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'could not become child subreaper')

read_fd, write_fd = os.pipe()
leader = os.fork()
if leader == 0:
    os.close(read_fd)
    os.setsid()
    child = os.fork()
    if child == 0:
        os.close(write_fd)
        with open(os.devnull, 'r+b') as null:
            for fd in (0, 1, 2):
                os.dup2(null.fileno(), fd)
        env = {**os.environ, **json.loads(sys.argv[2])}
        os.execve(sys.argv[1], [sys.argv[1], '-e', 'setInterval(() => {}, 1000)'], env)
    os.write(write_fd, str(child).encode())
    os._exit(0)

os.close(write_fd)
with os.fdopen(read_fd) as pipe:
    child = int(pipe.read())
os.waitpid(leader, 0)
print(json.dumps({'leader': leader, 'child': child}), flush=True)
if sys.platform == 'linux':
    os.waitpid(child, 0)
else:
    while True:
        try:
            os.kill(child, 0)
        except ProcessLookupError:
            break
        time.sleep(0.02)
