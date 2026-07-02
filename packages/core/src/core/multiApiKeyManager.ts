/**
 * @license
 * Copyright 2026 Harry Dau
 * SPDX-License-Identifier: MIT
 *
 * @license
 */

import { loadAllApiKeys, saveApiKeys } from './apiKeyCredentialStorage.js';

export class MultiApiKeyManager {
  private keys: string[] = [];
  private currentIndex: number = 0;

  constructor() {}

  async initialize(): Promise<void> {
    this.keys = await loadAllApiKeys();
    this.currentIndex = 0;
  }

  getCurrentKey(): string | null {
    if (this.keys.length === 0) {
      return null;
    }
    return this.keys[this.currentIndex];
  }

  getAllKeys(): string[] {
    return this.keys;
  }

  rotateKey(): string | null {
    if (this.keys.length <= 1) {
      return this.getCurrentKey();
    }
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    return this.getCurrentKey();
  }

  async setKeys(keys: string[]): Promise<void> {
    this.keys = keys;
    this.currentIndex = 0;
    await saveApiKeys(keys);
  }
}

export const multiApiKeyManager = new MultiApiKeyManager();
