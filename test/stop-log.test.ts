import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unexplainedStop } from '../src/host/stop-log.js';

const folder = mkdtempSync(join(tmpdir(), 'sema-stop-log-'));
const module = pathToFileURL(join(process.cwd(), 'src', 'host', 'stop-log.ts')).href;
// Runs a small program that keeps the record, as start.ts does, in a process of its own.
function run(name: string, body: string) {
  const file = join(folder, `${name}.log`), script = join(folder, `${name}.ts`);
  writeFileSync(script, `import { recordStops } from ${JSON.stringify(module)};\nconst say = recordStops(${JSON.stringify(file)}, '9.9.9');\n${body}\n`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr, stops: readFileSync(file, 'utf8') };
}

try {
  // No record yet: nothing to report.
  assert.equal(unexplainedStop(join(folder, 'none.log')), undefined);

  // Nothing left to do: it ends by itself and says so.
  const drained = run('drained', '');
  assert.equal(drained.status, 0);
  assert.match(drained.stops, /SEMA Core v9\.9\.9 started, process \d+\n/);
  assert.match(drained.stops, /Stopped, exit code 0 \(nothing was keeping it running\)\n$/);

  // A reason given: it is written, before the line that says it stopped.
  const asked = run('asked', "say('received SIGINT');");
  assert.match(asked.stops, /Stopping: received SIGINT\n.*Stopped, exit code 0\n$/);

  // An uncaught error: the record has it, and Node still prints it and exits with its usual code.
  const thrown = run('thrown', "setTimeout(() => { throw new Error('the reason it broke'); }, 10);");
  assert.equal(thrown.status, 1);
  assert.match(thrown.stderr, /the reason it broke/);
  assert.match(thrown.stops, /Stopping: uncaughtException: Error: the reason it broke/);
  assert.match(thrown.stops, /Stopped, exit code 1\n$/);

  // A promise nobody handled: the same.
  const rejected = run('rejected', "void Promise.reject(new Error('nobody caught this'));");
  assert.equal(rejected.status, 1);
  assert.match(rejected.stops, /Stopping: unhandledRejection: Error: nobody caught this/);
  assert.match(rejected.stops, /Stopped, exit code 1\n$/);

  // The quirk met on Windows: process.exit() right after requests may crash, but the stop is already written.
  const exited = run('exited', "import { createServer } from 'node:http';\nconst server = createServer((_q, r) => r.end('ok'));\nserver.listen(0, '127.0.0.1', async () => { const { port } = server.address() as { port: number }; await Promise.all(Array.from({ length: 30 }, () => fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()))); say('asked to exit'); process.exit(0); });");
  assert.match(exited.stops, /Stopping: asked to exit\n.*Stopped, exit code 0\n$/);

  // Ended from outside: nothing could be written then, so the next start says so.
  const killed = join(folder, 'killed.log');
  writeFileSync(killed, '2026-10-26T03:40:01.000Z SEMA Core v0.11.1 started, process 1234\n');
  assert.match(unexplainedStop(killed)!, /process 1234\) ended without saying why; last seen alive /);
  const next = run('killed', '');
  assert.match(next.stops, /ended without saying why/);
  assert.equal(unexplainedStop(join(folder, 'killed.log')), undefined, 'told once, not at every start');
} finally {
  rmSync(folder, { recursive: true, force: true });
}
console.log('Stop log test passed.');
