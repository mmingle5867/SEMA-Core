import { appendFileSync, mkdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * What the file says about the run before this one, when that run never said why it stopped. Its last line is then
 * still the line it wrote when it started, and the file's time is the last time it was seen alive.
 */
export function unexplainedStop(file: string): string | undefined {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return undefined; }
  const last = text.trimEnd().split('\n').at(-1) ?? '';
  if (!/ started, process \d+$/.test(last)) return undefined;
  return `The run before this one (${last}) ended without saying why; last seen alive ${statSync(file).mtime.toISOString()}. It was ended from outside (Stop-Process, taskkill, Task Manager), or Windows or the machine stopped. A crash inside Node also prints to the error log.`;
}

/**
 * Keeps a record of why this Core stopped. A file of its own, because a restart overwrites the output logs, and read
 * at the next start, because a process ended from outside gets no chance to say anything. Writes are synchronous so
 * the line is on disk before anything can crash; the file holds a line per start and stop, so it stays small.
 * Returns the function that says why a stop has begun.
 */
export function recordStops(file: string, version: string) {
  let reasonGiven = false;
  const write = (line: string) => {
    const text = `${new Date().toISOString()} ${line}`;
    console.log(text);
    try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, `${text}\n`); } catch (error) { console.error(`Could not write ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const earlier = unexplainedStop(file);
  if (earlier) write(earlier);
  write(`SEMA Core v${version} started, process ${process.pid}`);
  // The monitor only watches: Node still prints the error to the error log and exits as it always has.
  process.on('uncaughtExceptionMonitor', (error, origin) => { reasonGiven = true; write(`Stopping: ${origin}: ${error instanceof Error ? error.stack : String(error)}`); });
  process.on('exit', (code) => write(`Stopped, exit code ${code}${reasonGiven ? '' : ' (nothing was keeping it running)'}`));
  setInterval(() => { try { const now = new Date(); utimesSync(file, now, now); } catch { /* the next one may work */ } }, 15_000).unref();
  return (why: string) => { reasonGiven = true; write(`Stopping: ${why}`); };
}
