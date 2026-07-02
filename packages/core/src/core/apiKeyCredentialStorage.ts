/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Harry Dau - 2026
 */

import { HybridTokenStorage } from '../mcp/token-storage/hybrid-token-storage.js';
import type { OAuthCredentials } from '../mcp/token-storage/types.js';
import { debugLogger } from '../utils/debugLogger.js';
import { createCache } from '../utils/cache.js';

const KEYCHAIN_SERVICE_NAME = 'gemini-cli-api-key';
const DEFAULT_API_KEY_ENTRY = 'default-api-key';
const API_KEY_LIST_ENTRY = 'api-key-list';

const storage = new HybridTokenStorage(KEYCHAIN_SERVICE_NAME);

// Cache to store the results of loadApiKey and loadAllApiKeys
const apiKeyCache = createCache<string, Promise<string | string[] | null>>({
  storage: 'map',
  defaultTtl: 30000, // 30 seconds
});

/**
 * Resets the API key cache. Used exclusively for test isolation.
 * @internal
 */
export function resetApiKeyCacheForTesting() {
  apiKeyCache.clear();
}

/**
 * Load cached API key
 */
export async function loadApiKey(): Promise<string | null> {
  const result = await apiKeyCache.getOrCreate(
    DEFAULT_API_KEY_ENTRY,
    async () => {
      try {
        const credentials = await storage.getCredentials(DEFAULT_API_KEY_ENTRY);

        if (
          credentials?.token?.accessToken &&
          typeof credentials.token.accessToken === 'string'
        ) {
          return credentials.token.accessToken;
        }

        return null;
      } catch (error: unknown) {
        debugLogger.error('Failed to load API key from storage:', error);
        return null;
      }
    },
  );
  return typeof result === 'string' ? result : null;
}

/**
 * Load all cached API keys
 */
export async function loadAllApiKeys(): Promise<string[]> {
  const result = await apiKeyCache.getOrCreate(API_KEY_LIST_ENTRY, async () => {
    try {
      const credentials = await storage.getCredentials(API_KEY_LIST_ENTRY);
      if (
        credentials?.token?.accessToken &&
        typeof credentials.token.accessToken === 'string'
      ) {
        const parsed: unknown = JSON.parse(credentials.token.accessToken);
        if (
          Array.isArray(parsed) &&
          parsed.every((item) => typeof item === 'string')
        ) {
          return parsed;
        }
      }
      // Fallback: Check if there's a default key
      const defaultKey: string | null = await loadApiKey();
      return defaultKey ? [defaultKey] : [];
    } catch (error: unknown) {
      debugLogger.error('Failed to load API keys from storage:', error);
      return [];
    }
  });
  return Array.isArray(result) ? result.map((item) => String(item)) : [];
}

/**
 * Save API key
 */
export async function saveApiKey(
  apiKey: string | null | undefined,
): Promise<void> {
  apiKeyCache.delete(DEFAULT_API_KEY_ENTRY);
  apiKeyCache.delete(API_KEY_LIST_ENTRY);
  if (!apiKey || apiKey.trim() === '') {
    try {
      await storage.deleteCredentials(DEFAULT_API_KEY_ENTRY);
      await storage.deleteCredentials(API_KEY_LIST_ENTRY);
    } catch (error: unknown) {
      debugLogger.warn('Failed to delete API key from storage:', error);
    }
    return;
  }

  // Wrap API key in OAuthCredentials format
  const credentials: OAuthCredentials = {
    serverName: DEFAULT_API_KEY_ENTRY,
    token: {
      accessToken: apiKey,
      tokenType: 'ApiKey',
    },
    updatedAt: Date.now(),
  };

  await storage.setCredentials(credentials);
}

/**
 * Save API key list
 */
export async function saveApiKeys(apiKeys: string[]): Promise<void> {
  apiKeyCache.delete(API_KEY_LIST_ENTRY);

  const credentials: OAuthCredentials = {
    serverName: API_KEY_LIST_ENTRY,
    token: {
      accessToken: JSON.stringify(apiKeys),
      tokenType: 'ApiKey',
    },
    updatedAt: Date.now(),
  };

  await storage.setCredentials(credentials);
}

/**
 * Clear cached API key
 */
export async function clearApiKey(): Promise<void> {
  apiKeyCache.delete(DEFAULT_API_KEY_ENTRY);
  try {
    await storage.deleteCredentials(DEFAULT_API_KEY_ENTRY);
  } catch (error: unknown) {
    debugLogger.error('Failed to clear API key from storage:', error);
  }
}
