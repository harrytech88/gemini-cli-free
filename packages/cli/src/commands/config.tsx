/**
 * @license
 * Copyright 2026 Harry Dau
 * SPDX-License-Identifier: MIT
 *
 * @license
 */

import type { CommandModule } from 'yargs';
import { performSetKeys, performListKeys } from '@google/gemini-cli-core';
import { exitCli } from './utils.js';

export const configCommand: CommandModule = {
  command: 'config <command>',
  describe: 'Manage configuration settings.',
  builder: (yargs) =>
    yargs
      .command('set-keys <keys...>', 'Set API keys', {}, async (argv) => {
        const keys = argv['keys'] ?? [];
        const result = await performSetKeys(keys);
        if (result.type === 'message') {
          process.stdout.write(result.content + '\n');
        }
        await exitCli();
      })
      .command('list-keys', 'List API keys', {}, async () => {
        const result = await performListKeys();
        if (result.type === 'message') {
          process.stdout.write(result.content + '\n');
        }
        await exitCli();
      })
      .demandCommand(1),
  handler: () => {},
};
