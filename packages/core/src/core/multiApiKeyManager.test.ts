/**
 * @license
 * Copyright 2026 Harry Dau
 * SPDX-License-Identifier: MIT
 *
 * @license
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MultiApiKeyManager } from './multiApiKeyManager.js';
import * as storage from './apiKeyCredentialStorage.js';

vi.mock('./apiKeyCredentialStorage.js', () => ({
  loadAllApiKeys: vi.fn(),
  saveApiKeys: vi.fn(),
}));

describe('MultiApiKeyManager', () => {
  let manager: MultiApiKeyManager;

  beforeEach(async () => {
    manager = new MultiApiKeyManager();
    vi.mocked(storage.loadAllApiKeys).mockResolvedValue([
      'key1',
      'key2',
      'key3',
    ]);
    await manager.initialize();
  });

  it('should initialize with keys', () => {
    expect(manager.getCurrentKey()).toBe('key1');
  });

  it('should rotate keys', () => {
    expect(manager.getCurrentKey()).toBe('key1');
    expect(manager.rotateKey()).toBe('key2');
    expect(manager.rotateKey()).toBe('key3');
    expect(manager.rotateKey()).toBe('key1');
  });

  it('should not rotate if only one key', async () => {
    vi.mocked(storage.loadAllApiKeys).mockResolvedValue(['key1']);
    await manager.initialize();
    expect(manager.getCurrentKey()).toBe('key1');
    expect(manager.rotateKey()).toBe('key1');
  });
});
