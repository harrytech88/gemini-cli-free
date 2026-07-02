/**
 * @license
 * Copyright 2026 Harry Dau
 * SPDX-License-Identifier: MIT
 *
 * @license
 */

import { multiApiKeyManager } from '../core/multiApiKeyManager.js';
import type { CommandActionReturn } from './types.js';

export async function performSetKeys(
  keys: string[],
): Promise<CommandActionReturn> {
  await multiApiKeyManager.setKeys(keys);
  return {
    type: 'message',
    messageType: 'info',
    content: `Successfully set ${keys.length} API keys.`,
  };
}

export async function performListKeys(): Promise<CommandActionReturn> {
  await multiApiKeyManager.initialize();
  const keys = multiApiKeyManager.getAllKeys();
  if (keys.length === 0) {
    return {
      type: 'message',
      messageType: 'info',
      content: 'No API keys configured.',
    };
  }
  return {
    type: 'message',
    messageType: 'info',
    content: `Configured API keys: ${keys.join(', ')}`,
  };
}
