/**
 * Streamed, timestamped output for runs that take half an hour.
 *
 * Attempt 3 was a twenty-five minute black box that printed its transaction
 * hashes at the end. When it reverted, the hashes were in the terminal and the
 * timings were not, and reconstructing when each stage happened meant reading
 * block timestamps back off two explorers.
 *
 * Three rules, all of them learned the hard way:
 *
 *   - every line carries a wall-clock timestamp and an elapsed offset;
 *   - every line goes to the terminal *and* to the artifact as it is written,
 *     not at the end, so a killed run keeps everything it had reached;
 *   - a transaction hash is printed at broadcast, never at completion. A hash
 *     you cannot see until the call returns is useless during the wait, which
 *     is exactly when you want it.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const RESET = '[0m';
const DIM = '[2m';
const BOLD = '[1m';
const RED = '[31m';
const GREEN = '[32m';
const YELLOW = '[33m';

export function createLog(artifactPath) {
  const started = Date.now();
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, '');

  const emit = (colour, marker, message) => {
    const now = new Date();
    const elapsed = ((now.getTime() - started) / 1000).toFixed(1).padStart(7);
    const stamp = now.toISOString().slice(11, 23);
    process.stdout.write(
      `${DIM}${stamp} ${elapsed}s${RESET} ${colour}${marker}${RESET} ${message}\n`,
    );
    appendFileSync(artifactPath, `${now.toISOString()} +${elapsed.trim()}s ${marker} ${message}\n`);
  };

  return {
    artifactPath,
    startedAt: new Date(started).toISOString(),
    elapsedSeconds: () => Math.round((Date.now() - started) / 1000),
    stage: (message) => emit(BOLD, '──', `${BOLD}${message}${RESET}`),
    step: (message) => emit(DIM, ' ·', message),
    ok: (message) => emit(GREEN, ' ✓', message),
    warn: (message) => emit(YELLOW, ' !', message),
    fail: (message) => emit(RED, ' ✗', message),
    /** A hash the moment it exists, before anything is waited on. */
    broadcast: (label, hash, explorer) =>
      emit(
        YELLOW,
        '->',
        `${label} broadcast ${hash}${explorer === undefined ? '' : ` ${explorer}`}`,
      ),
  };
}

/**
 * Node buffers stdout when it is a pipe rather than a TTY, which is how a run
 * teed to a file shows nothing for twenty minutes and then everything at once.
 */
export function unbufferStdout() {
  if (process.stdout._handle !== undefined && process.stdout._handle.setBlocking !== undefined) {
    process.stdout._handle.setBlocking(true);
  }
}
