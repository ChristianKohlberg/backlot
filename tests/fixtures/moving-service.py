import os
import sys
import time

root = sys.argv[1]
with open(os.path.join(root, 'ready'), 'w') as marker:
    marker.write(str(os.getpid()))
while not os.path.exists(os.path.join(root, 'move')):
    time.sleep(0.02)
os.setsid()
with open(os.path.join(root, 'moved'), 'w') as marker:
    marker.write(str(os.getpgrp()))
while True:
    time.sleep(1)
