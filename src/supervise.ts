/**
 * Runs one kit for makersmcp: node supervise.js <kit script> [arguments].
 *
 * makersmcp starts this script in a process group of its own, and the kit runs in that
 * group with the Chrome and ffmpeg it starts. makersmcp holds this process's stdin and
 * never writes to it. When makersmcp is gone, however it ended (its client closed it, a
 * signal, or SIGKILL), the pipe closes and the whole group is stopped, so no kit and no
 * browser outlives it. Otherwise this process waits for the kit and ends the way the
 * kit ended, with its exit code or its signal.
 */
import { spawn, spawnSync } from 'node:child_process';

const GRACE_MS = 1000;
const POSIX = process.platform !== 'win32';

const [script, ...args] = process.argv.slice(2);
const kit = spawn(process.execPath, [script ?? '', ...args], {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
});

function stopGroup(signal: NodeJS.Signals): void {
  try {
    if (POSIX) process.kill(-process.pid, signal);
    else if (kit.pid) spawnSync('taskkill', ['/pid', String(kit.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // Nothing left to stop.
  }
}

// A cancel signals the whole group, the kit included. This process passes the signal
// on, in case it came to it alone, and then waits to end the way the kit does.
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
for (const signal of SIGNALS) {
  process.on(signal, () => {
    kit.kill(signal);
  });
}

let orphaned = false;
const lost = () => {
  if (orphaned) return;
  orphaned = true;
  stopGroup('SIGTERM');
  setTimeout(() => {
    stopGroup('SIGKILL');
    process.exit(1);
  }, GRACE_MS);
};
process.stdin.on('end', lost);
process.stdin.on('close', lost);
process.stdin.on('error', lost);
process.stdin.resume();

kit.on('error', error => {
  process.stderr.write(`makersmcp could not start the kit: ${error.message}\n`);
  process.exit(1);
});

kit.on('exit', (code, signal) => {
  // With makersmcp gone, the timer stops whatever is left and ends this process.
  if (orphaned) return;
  // Anything the kit left running in its group, like a browser it did not close.
  // The copy of the signal this process gets goes to its listener above.
  if (POSIX) stopGroup('SIGTERM');
  if (!signal) process.exit(code ?? 1);
  // Ended by a signal: once that copy has arrived, end by the kit's signal too.
  setTimeout(() => {
    for (const name of SIGNALS) process.removeAllListeners(name);
    process.kill(process.pid, signal!);
    // Only reached when that signal does not end a process.
    setTimeout(() => process.exit(1), 100);
  }, 50);
});
