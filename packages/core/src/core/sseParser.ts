/* eslint-disable headers/header-format */
/**
 * @license
 * Copyright 2026 Harry Dau
 * SPDX-License-Identifier: MIT
 */

export interface SSEEvent {
  type: 'data' | 'event';
  raw: string;
  json?: Record<string, unknown>;
  name?: string;
}

export async function* parseSSEStream(
  response: Response,
  _signal: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      /* eslint-disable */
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const rawData = line.slice(6);
          if (rawData === '[DONE]') return;
          yield {
            type: 'data',
            json: JSON.parse(rawData) as unknown as Record<string, unknown>,
            raw: line,
          };
        } else if (line.startsWith('event: ')) {
          yield { type: 'event', name: line.slice(7), raw: line };
        }
      }
      /* eslint-enable */
    }
  } finally {
    void reader.cancel();
    reader.releaseLock();
  }
}
