import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function toolchain() {
  return JSON.parse(readFileSync(join(ROOT, 'toolchain.json'), 'utf8'));
}

/**
 * Runs a command with output streamed to the terminal.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, allowFailure?: boolean }} [options]
 * @returns {{ ok: boolean, status: number }}
 */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...options.env },
  });

  if (result.error !== undefined) {
    if (options.allowFailure === true) {
      return { ok: false, status: 127 };
    }
    throw result.error;
  }

  const status = result.status ?? 1;
  return { ok: status === 0, status };
}

/**
 * Runs a command with output suppressed, for probes whose result is the exit
 * status rather than the output.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {boolean} true when the command exited zero
 */
export function runQuiet(command, args) {
  return spawnSync(command, args, { cwd: ROOT, stdio: 'ignore' }).status === 0;
}

/**
 * Probes for a binary without a shell. Going through one to run `command -v`
 * concatenates rather than escapes its argument, which is the pattern Node
 * deprecated in DEP0190.
 *
 * Exit status is ignored on purpose: a tool that exists but rejects
 * `--version` is still installed. Only ENOENT means missing.
 *
 * @param {string} command
 */
export function hasCommand(command) {
  const probe = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return probe.error === undefined || probe.error.code !== 'ENOENT';
}

export function heading(text) {
  const bar = '─'.repeat(Math.max(0, 72 - text.length - 1));
  console.log(`\n[1m▸ ${text}[0m ${bar}`);
}
