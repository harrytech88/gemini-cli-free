/* eslint-disable headers/header-format */
/**
 * @license
 * Copyright 2026 Harry Dau
 * SPDX-License-Identifier: MIT
 */

import {
  CommandKind,
  type SlashCommand,
  type CommandContext,
  type SlashCommandActionReturn,
} from '../../ui/commands/types.js';
import { performSetKeys, performListKeys } from '@google/gemini-cli-core';

export const configCommand: SlashCommand = {
  name: 'config',
  description: 'Manage configuration settings',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'set-keys',
      description: 'Set API keys',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: async (_context: CommandContext, args: string) => {
        const keys = args.split(' ').filter(Boolean);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        return performSetKeys(keys) as Promise<SlashCommandActionReturn>;
      },
    },
    {
      name: 'list-keys',
      description: 'List API keys',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: async (_context: CommandContext, _args: string) =>
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        performListKeys() as Promise<SlashCommandActionReturn>,
    },
  ],
};
