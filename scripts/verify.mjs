#!/usr/bin/env node
/**
 * The repository gate.
 *
 * `pnpm verify` runs every check the PRD 15.5 CI list requires, in the order
 * CLAUDE.md prescribes: format, lint, typecheck, tests, contract tests,
 * invariants, security scans, end-to-end. CI calls the same script, so a green
 * local run and a green pipeline mean the same thing.
 *
 * Every step is blocking. A tool that is missing fails the step with install
 * instructions rather than skipping it, because a silent skip reads as a pass.
 */
import { performance } from 'node:perf_hooks';

import { hasCommand, heading, ROOT, run, runQuiet, toolchain } from './lib/run.mjs';

const manifest = toolchain();
const args = new Set(process.argv.slice(2));
const only = process.argv
  .slice(2)
  .find((a) => a.startsWith('--only='))
  ?.slice('--only='.length);

/**
 * Container-based scanners are pinned by digest so a local run and a CI run
 * analyse identical bytes.
 * @param {string} key
 */
function digestRef(key) {
  const image = manifest.containerImages[key];
  const [repo] = image.reference.split(':');
  return `${repo}@${image.digest}`;
}

const MOUNT = [`--volume`, `${ROOT}:/repo`, '--workdir', '/repo'];

/**
 * A bind mount that Docker cannot read produces an empty directory inside the
 * container rather than an error, so a scanner analyses nothing and still exits
 * zero. That is the exact shape of a silent pass, and on macOS it happens
 * whenever the repository sits outside Docker Desktop's shared paths.
 *
 * Every container-based step probes the mount first and fails loudly instead.
 *
 * @param {string} imageKey
 * @returns {{ok:boolean,status:number} | null} a failure result, or null when the mount is good
 */
function mountUnreadable(imageKey) {
  const visible = runQuiet('docker', [
    'run',
    '--rm',
    ...MOUNT,
    '--entrypoint',
    '/bin/sh',
    digestRef(imageKey),
    '-c',
    'test -f /repo/toolchain.json',
  ]);
  if (visible) return null;

  console.error(`docker cannot read the repository at ${ROOT}.`);
  console.error('The scan would report zero findings because it would see an empty directory.');
  console.error('Add this path to Docker Desktop → Settings → Resources → File sharing,');
  console.error(`or install the scanner natively so the step runs without a container.`);
  return { ok: false, status: 1 };
}

/**
 * @param {string} imageKey
 * @param {string[]} scannerArgs
 */
function dockerScan(imageKey, scannerArgs) {
  const unreadable = mountUnreadable(imageKey);
  if (unreadable !== null) return unreadable;

  return run('docker', ['run', '--rm', ...MOUNT, digestRef(imageKey), ...scannerArgs], {
    allowFailure: true,
  });
}

/** @type {{id:string,title:string,exec:() => {ok:boolean,status:number}}[]} */
const STEPS = [
  {
    id: 'toolchain',
    title: 'toolchain pins match this machine',
    exec: () => run('node', ['scripts/verify-toolchain.mjs'], { allowFailure: true }),
  },
  {
    id: 'format',
    title: 'formatting (prettier + forge fmt)',
    exec: () => {
      const prettier = run('pnpm', ['exec', 'prettier', '--check', '.'], { allowFailure: true });
      const forge = run('forge', ['fmt', '--check'], { allowFailure: true });
      return { ok: prettier.ok && forge.ok, status: prettier.ok && forge.ok ? 0 : 1 };
    },
  },
  {
    id: 'web-bundle',
    // Before typecheck, because it writes two of the modules typecheck reads.
    // `apps/web/build.mjs` emits `client-manifest.ts` and `image-manifest.ts`
    // into `src` — they carry content hashes, so they are generated rather than
    // committed — and on a clean checkout they do not exist yet. This is the
    // second half of what CI was failing on: a working tree that had built once
    // had them on disk, and a fresh clone did not.
    title: 'the Worker and browser bundles build',
    exec: () => {
      // esbuild resolves the workspace packages to their emitted `dist`, so
      // those have to exist before it runs. Building them by reference here
      // rather than relying on a full typecheck breaks the loop: the full
      // typecheck needs the manifests this step writes, and this step needs the
      // packages that typecheck would otherwise be the one to emit.
      const deps = run(
        'pnpm',
        ['exec', 'tsc', '--build', 'packages/domain', 'packages/cleanverse'],
        { allowFailure: true },
      );
      if (!deps.ok) return deps;
      return run('node', ['apps/web/build.mjs'], { allowFailure: true });
    },
  },
  {
    id: 'typecheck',
    // Before lint, and the order is load-bearing rather than tidy. The ESLint
    // config is type-aware, and the type information for a workspace package
    // comes from the declarations `tsc --build` emits. On a clean checkout those
    // do not exist yet, so every cross-package import resolves to `error` and
    // lint reports several hundred no-unsafe-* violations that say nothing about
    // the code. This is what CI has been failing on: locally the artefacts were
    // already on disk from a previous build, so lint saw real types and passed.
    title: 'tsc --build (strict, all workspaces)',
    exec: () => run('pnpm', ['exec', 'tsc', '--build', '--force'], { allowFailure: true }),
  },
  {
    id: 'lint',
    title: 'eslint (type-aware)',
    exec: () => run('pnpm', ['exec', 'eslint', '.', '--max-warnings', '0'], { allowFailure: true }),
  },
  {
    id: 'unit',
    title: 'vitest unit and repository-hygiene suite',
    exec: () => run('pnpm', ['exec', 'vitest', 'run'], { allowFailure: true }),
  },
  {
    id: 'contracts-build',
    title: 'forge build with warnings as errors',
    exec: () => run('forge', ['build', '--deny', 'warnings'], { allowFailure: true }),
  },
  {
    id: 'traces',
    title: 'differential corpus matches the reference model',
    exec: () =>
      run('node', ['scripts/generate-settlement-traces.mjs', '--check'], { allowFailure: true }),
  },
  {
    id: 'contracts-test',
    title: 'forge test',
    exec: () => run('forge', ['test'], { allowFailure: true }),
  },
  {
    id: 'contracts-gas',
    title: 'forge gas snapshot unchanged',
    exec: () => run('forge', ['snapshot', '--check'], { allowFailure: true }),
  },
  {
    id: 'contracts-layout',
    title: 'storage layout snapshot unchanged',
    exec: () => run('node', ['scripts/storage-layout.mjs', '--check'], { allowFailure: true }),
  },
  {
    id: 'slither',
    title: `slither ${manifest.staticAnalysis.slither}`,
    exec: () => {
      if (!hasCommand('slither')) {
        console.error(
          `slither not found. Install with: pipx install slither-analyzer==${manifest.staticAnalysis.slither}`,
        );
        return { ok: false, status: 127 };
      }
      return run('slither', ['.', '--config-file', 'slither.config.json'], { allowFailure: true });
    },
  },
  {
    id: 'secrets',
    title: `gitleaks ${manifest.staticAnalysis.gitleaks} (worktree and history)`,
    exec: () => {
      if (!hasCommand('gitleaks')) {
        console.error(
          `gitleaks not found. Install with: brew install gitleaks@${manifest.staticAnalysis.gitleaks}`,
        );
        return { ok: false, status: 127 };
      }
      const dir = run('gitleaks', ['dir', '.', '--no-banner', '--redact'], { allowFailure: true });
      const history = run('gitleaks', ['git', '.', '--no-banner', '--redact'], {
        allowFailure: true,
      });
      const ok = dir.ok && history.ok;
      return { ok, status: ok ? 0 : 1 };
    },
  },
  {
    id: 'deps-audit',
    title: 'dependency advisory audit',
    exec: () => run('pnpm', ['audit', '--audit-level', 'moderate'], { allowFailure: true }),
  },
  {
    id: 'container-scan',
    title: `trivy ${manifest.staticAnalysis.trivy} config scan`,
    exec: () =>
      hasCommand('trivy')
        ? run('trivy', ['config', '.', '--exit-code', '1'], { allowFailure: true })
        : dockerScan('trivy', ['config', '/repo', '--exit-code', '1']),
  },
  {
    id: 'iac-scan',
    // Checkov has no docker-compose framework, so `dockerfile` covers nothing
    // today and `terraform` covers a providerless root module. `github_actions`
    // is the framework with real surface right now: it checks the workflows for
    // unpinned actions, script injection, and excessive permissions.
    title: `checkov ${manifest.staticAnalysis.checkov} (terraform, github actions, dockerfile)`,
    exec: () => {
      const args = [
        '--framework',
        'terraform',
        '--framework',
        'github_actions',
        '--framework',
        'dockerfile',
        '--skip-path',
        'node_modules',
        '--skip-path',
        'contracts/lib',
        '--skip-path',
        'out',
        '--skip-path',
        'cache',
        '--compact',
        '--quiet',
      ];
      return hasCommand('checkov')
        ? run('checkov', ['--directory', '.', ...args], { allowFailure: true })
        : dockerScan('checkov', ['--directory', '/repo', ...args]);
    },
  },
  {
    id: 'manifests',
    title: 'deployment manifests conform to the PRD 17.3 schema',
    exec: () => run('node', ['scripts/check-deployment-manifests.mjs'], { allowFailure: true }),
  },
  {
    id: 'onchain',
    // "The contracts are verified" is the easiest claim in a submission to make
    // and the easiest to stop being true, because it lives on someone else's
    // server. Asked here, from the public endpoint, every run.
    title: 'canonical contracts are deployed, match the manifest, and are publicly verified',
    exec: () =>
      run('node', ['scripts/check-onchain-verification.mjs', '--check'], { allowFailure: true }),
  },
  {
    id: 'hero-image',
    // The shipped hero variants must still be what the committed source and the
    // committed crop produce. An artwork swapped without regenerating them is a
    // page serving one picture and a repository describing another.
    title: 'hero image variants match the source and crop they were generated from',
    exec: () => run('node', ['scripts/build-hero-image.mjs', '--check'], { allowFailure: true }),
  },
  {
    id: 'onchain-index',
    // Every transaction this project claims to have sent, resolved against the
    // chain that mined it. A link that no longer resolves is a claim that has
    // quietly stopped being checkable, and this is where that surfaces.
    title: 'every indexed transaction still resolves on the chain that mined it',
    exec: () => run('node', ['scripts/build-onchain-index.mjs', '--check'], { allowFailure: true }),
  },
  {
    id: 'e2e',
    /**
     * The browser suite drives a running console; the harness project drives
     * nothing and needs no browser.
     *
     * `apps/web/qa` asserts against a live surface at `WEB_BASE_URL` — real
     * pages, real Cleanverse answers, real chain reads — which is what makes it
     * worth having and also what makes it unrunnable on a CI runner with no
     * database credentials and no deployed worker of its own. Starting one here
     * would need the production secrets in a public repository.
     *
     * So the base URL is probed. If a console answers, everything runs. If none
     * does, the harness project runs and the step says plainly which half was
     * skipped rather than reporting a pass that covered less than it looks like.
     */
    title: 'playwright end-to-end suite',
    exec: async () => {
      const base = process.env['WEB_BASE_URL'] ?? 'http://localhost:8787';
      let reachable = false;
      try {
        const response = await fetch(`${base}/health`, {
          signal: AbortSignal.timeout(4000),
        });
        reachable = response.ok;
      } catch {
        reachable = false;
      }

      if (reachable) return run('pnpm', ['exec', 'playwright', 'test'], { allowFailure: true });

      console.log(`no console answering at ${base} — running the harness project only.`);
      console.log('the browser suite needs a running surface; see playwright.config.ts.');
      return run('pnpm', ['exec', 'playwright', 'test', '--project=harness'], {
        allowFailure: true,
      });
    },
  },
];

const selected = only === undefined ? STEPS : STEPS.filter((s) => only.split(',').includes(s.id));

if (selected.length === 0) {
  console.error(`no step matched --only=${String(only)}`);
  console.error(`available: ${STEPS.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

/** @type {{id:string,ok:boolean,ms:number}[]} */
const outcomes = [];

for (const step of selected) {
  heading(`${step.id} — ${step.title}`);
  const started = performance.now();
  // A step may be async — the e2e step probes the network before it decides
  // what to run — so every result is awaited, which is a no-op for the rest.
  const result = await step.exec();
  outcomes.push({ id: step.id, ok: result.ok, ms: performance.now() - started });

  if (!result.ok && !args.has('--keep-going')) {
    report();
    console.error(`\ngate FAILED at step "${step.id}"`);
    process.exit(1);
  }
}

report();

const failed = outcomes.filter((o) => !o.ok);
if (failed.length > 0) {
  console.error(`\ngate FAILED: ${failed.map((f) => f.id).join(', ')}`);
  process.exit(1);
}

console.log(`\ngate PASSED: ${outcomes.length}/${STEPS.length} steps green`);

function report() {
  const width = Math.max(...outcomes.map((o) => o.id.length));
  console.log('\n──── gate summary ────');
  for (const o of outcomes) {
    console.log(`${o.ok ? 'PASS' : 'FAIL'}  ${o.id.padEnd(width)}  ${(o.ms / 1000).toFixed(2)}s`);
  }
}
