#!/usr/bin/env node
import { Command } from 'commander';

import { formatMatrix, runDoctor } from './doctor.js';
import { readChainId, readCode } from './rpc.js';

/**
 * PRD FR-001: `pnpm conduit doctor` outputs a machine-readable capability
 * matrix and exits non-zero when a required capability is missing.
 *
 * The non-zero exit is the point. A doctor that always exits zero is a report
 * nobody reads, and CI needs it to be able to fail.
 */
const program = new Command();

program
  .name('conduit')
  .description('Conduit protocol command line')
  .version('0.0.0')
  .showHelpAfterError();

program
  .command('doctor')
  .description('probe Cleanverse, chain, and Wormhole capabilities and report what is available')
  .option('--json', 'emit the capability matrix as JSON', false)
  .option(
    '--wallet <address...>',
    'wallet to probe with query_apass and verify_apass; repeatable',
    [],
  )
  .option('--cash-chain <key>', 'chain carrying the cash leg', 'monadTestnet')
  .action(async (options: { json: boolean; wallet: string[]; cashChain: string }) => {
    const matrix = await runDoctor(
      {
        env: process.env,
        now: (): Date => new Date(),
        readChainId,
        readCode,
      },
      {
        testWallets: options.wallet,
        cashChain: options.cashChain === 'baseSepolia' ? 'baseSepolia' : 'monadTestnet',
      },
    );

    process.stdout.write(
      options.json ? `${JSON.stringify(matrix, null, 2)}\n` : `${formatMatrix(matrix)}\n`,
    );

    process.exitCode = matrix.ok ? 0 : 1;
  });

await program.parseAsync(process.argv);
