import os
import sys
import time

root = sys.argv[1]


def mark(name, value):
    # Written then renamed: the test polls for the file and reads it at once,
    # so it must never see the file before its content.
    tmp = os.path.join(root, name + '.tmp')
    with open(tmp, 'w') as marker:
        marker.write(value)
    os.rename(tmp, os.path.join(root, name))


mark('ready', str(os.getpid()))
while not os.path.exists(os.path.join(root, 'move')):
    time.sleep(0.02)
os.setsid()
mark('moved', str(os.getpgrp()))
while True:
    time.sleep(1)
