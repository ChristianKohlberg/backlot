/**
 * `runly db with`'s watchdog (0.19): it runs the command, and takes it down
 * when the CLI that started it dies.
 *
 * The CLI drops the database copy after the command exits. If the CLI itself
 * is killed (SIGKILL, OOM, a `kill` of its process group that missed a command
 * in a group of its own — `setsid runly db with …`), the daemon drops the copy
 * once it notices, and the command used to keep working against a database
 * that no longer exists. Node cannot set PR_SET_PDEATHSIG, so the tie is a
 * pipe: the CLI holds the write end of fd 3, the kernel closes it when the CLI
 * dies however it dies, and this process sees EOF.
 *
 * argv: <shell|argv> <group|nogroup> <command…>. `group`: this process leads
 * the command's process group (no terminal), and the whole group goes. At a
 * terminal the command stays in the caller's job and only it is signalled.
 *
 * The command's exit code (or the signal that ended it) is this process's, so
 * the CLI passes it through unchanged.
 */
import { spawn } from 'node:child_process';
import { Socket } from 'node:net';

const [mode, grouping, ...parts] = process.argv.slice(2);
const group = grouping === 'group';
const command = parts[0];
if (command === undefined) {
  console.error('runly db with: watchdog started without a command');
  process.exit(64);
}

const child = mode === 'shell'
  ? spawn(command, { stdio: 'inherit', shell: true })
  : spawn(command, parts.slice(1), { stdio: 'inherit' });

const signalCommand = (sig: NodeJS.Signals): void => {
  try {
    if (group) process.kill(-process.pid, sig);
    else child.kill(sig);
  } catch {
    /* already gone */
  }
};

// A signal the CLI passes on: in a group of our own the whole group (the
// command included) already received it; at a terminal only this process did.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    if (!group) child.kill(sig);
  });
}

let cliGone = false;
const onCliGone = (): void => {
  if (cliGone) return;
  cliGone = true;
  signalCommand('SIGTERM');
  // A command that ignores SIGTERM goes anyway: nothing may go on working
  // against a copy that is about to be dropped.
  setTimeout(() => signalCommand('SIGKILL'), 3000).unref();
};
// A stream handle, not an fs read: a blocking read on fd 3 would sit in the
// threadpool and keep process.exit() from returning.
const pipe = new Socket({ fd: 3, readable: true, writable: false });
pipe.on('data', () => undefined);
pipe.on('end', onCliGone);
pipe.on('close', onCliGone);
pipe.on('error', onCliGone);

child.on('error', (err) => {
  console.error(`runly db with: could not start '${command}': ${err.message}`);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  if (signal) {
    // Die of the same signal, so the CLI reports 128+n like a shell would.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
