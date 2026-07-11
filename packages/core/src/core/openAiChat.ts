/* eslint-disable headers/header-format */
/**
 * @license
 * Copyright 2026 Harry Dau
 * SPDX-License-Identifier: MIT
 */

import {
  type ChatClient,
  type ChatMessage,
  type ChatStreamEvent,
  type ChatToolCall,
  type ChatToolDefinition,
  type ChatResponse,
  ChatStreamEventType,
} from './chatClient.js';
import { parseSSEStream } from './sseParser.js';
import { debugLogger } from '../utils/debugLogger.js';

interface OpenAiConfig {
  apiKey: string;
  baseUrl: string;
  modelName: string;
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  args: string;
}

export class OpenAiChat implements ChatClient {
  private history: ChatMessage[] = [];
  private systemInstruction = '';
  private lastTokenCount = 0;
  private readonly baseUrl: string;
  private readonly modelName: string;
  private readonly apiKey: string;

  constructor(
    _context: { config: { getSessionId(): string } },
    config: OpenAiConfig,
  ) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.modelName = config.modelName;
  }

  async initialize(
    _resumedSessionData?: unknown,
    _kind?: string,
  ): Promise<void> {
    this.history = [];
  }

  setSystemInstruction(sysInstr: string): void {
    this.systemInstruction = sysInstr;
  }

  getSystemInstruction(): string {
    return this.systemInstruction;
  }

  private async *_doSend(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent> {
    const response = await this.fetchWithRetry(body, signal);
    debugLogger.log(
      `[OpenAiChat] Response status: ${response.status} ${response.statusText}`,
    );

    if (!response.ok) {
      await this.handleHttpError(response);
      return;
    }

    const responseClone = response.clone();

    const accumulatedCalls = new Map<number, AccumulatedToolCall>();
    let finalContent = '';
    let finishReason: ChatResponse['finishReason'] | undefined;
    let usage: ChatResponse['usage'] | undefined;
    let hadSseData = false;

    try {
      for await (const sseEvent of parseSSEStream(response, signal)) {
        if (sseEvent.type !== 'data' || !sseEvent.json) continue;
        hadSseData = true;
        const data = sseEvent.json;

        const usageVal = data['usage'];
        if (
          usageVal &&
          typeof usageVal === 'object' &&
          usageVal !== null &&
          !Array.isArray(usageVal)
        ) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          const u = usageVal as Record<string, unknown>;
          const pt = u['prompt_tokens'];
          const ct = u['completion_tokens'];
          const tt = u['total_tokens'];
          usage = {
            promptTokens: typeof pt === 'number' ? pt : Number(pt) || 0,
            completionTokens: typeof ct === 'number' ? ct : Number(ct) || 0,
            totalTokens: typeof tt === 'number' ? tt : Number(tt) || 0,
          };
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const choices = data['choices'] as
          | Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              text?: string;
              finish_reason?: string | null;
            }>
          | undefined;

        if (!choices || choices.length === 0) continue;
        const choice = choices[0];
        if (!choice) continue;

        let chunkContent: string | undefined;
        let chunkToolCalls:
          | Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>
          | undefined;

        const delta = choice.delta;
        if (delta) {
          chunkContent = delta.content;
          chunkToolCalls = delta.tool_calls;
        } else if (typeof choice.text === 'string') {
          chunkContent = choice.text;
        }

        if (chunkContent) {
          finalContent += chunkContent;
          yield {
            type: ChatStreamEventType.CHUNK,
            value: { content: chunkContent },
          };
        }

        if (chunkToolCalls) {
          for (const tc of chunkToolCalls) {
            const index = tc.index ?? 0;
            if (tc.id) {
              accumulatedCalls.set(index, {
                id: tc.id,
                name: tc.function?.name ?? '',
                args: '',
              });
            }
            if (tc.function?.arguments) {
              const existing = accumulatedCalls.get(index);
              if (existing) {
                existing.args += tc.function.arguments;
              }
            }
          }
        }

        if (choice.finish_reason) {
          finishReason = this.mapFinishReason(choice.finish_reason);
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      throw e;
    }

    if (!hadSseData) {
      try {
        const text = await responseClone.text();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const data = JSON.parse(text) as Record<string, unknown>;

        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const choices = data['choices'] as
          | Array<{
              message?: {
                content?: string;
                reasoning_content?: string;
                role?: string;
              };
              text?: string;
              finish_reason?: string | null;
            }>
          | undefined;

        const usageVal = data['usage'];
        if (
          usageVal &&
          typeof usageVal === 'object' &&
          usageVal !== null &&
          !Array.isArray(usageVal)
        ) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          const u = usageVal as Record<string, unknown>;
          const pt = u['prompt_tokens'];
          const ct = u['completion_tokens'];
          const tt = u['total_tokens'];
          usage = {
            promptTokens: typeof pt === 'number' ? pt : Number(pt) || 0,
            completionTokens: typeof ct === 'number' ? ct : Number(ct) || 0,
            totalTokens: typeof tt === 'number' ? tt : Number(tt) || 0,
          };
        }

        if (choices && choices.length > 0) {
          const choice = choices[0];
          const msg = choice.message;
          const content =
            choice.text ?? msg?.content ?? msg?.reasoning_content ?? '';
          finishReason = choice.finish_reason
            ? this.mapFinishReason(choice.finish_reason)
            : 'stop';

          if (content) {
            finalContent = content;
            yield {
              type: ChatStreamEventType.CHUNK,
              value: { content },
            };
          }
        }
      } catch {
        // Non-streaming fallback failed, will proceed with whatever we have
      }
    }

    const toolCalls: ChatToolCall[] = [];
    for (const [, tc] of accumulatedCalls) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        parsedArgs = JSON.parse(tc.args) as Record<string, unknown>;
      } catch {
        parsedArgs = {};
      }
      toolCalls.push({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: parsedArgs },
      });
    }

    yield {
      type: ChatStreamEventType.CHUNK,
      value: {
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason:
          finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        usage,
      },
    };

    if (finishReason) {
      if (toolCalls.length > 0) {
        this.history.push({
          role: 'assistant',
          content: finalContent || undefined,
          toolCalls,
        });
      } else {
        this.history.push({
          role: 'assistant',
          content: finalContent || undefined,
        });
      }
    }

    this.lastTokenCount = usage?.totalTokens ?? 0;
  }

  async *sendMessageStream(
    message: string | ChatMessage[],
    signal: AbortSignal,
    options?: {
      tools?: ChatToolDefinition[];
      config?: Record<string, unknown>;
      historyOverride?: ChatMessage[];
    },
  ): AsyncGenerator<ChatStreamEvent> {
    let useSystemRole = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = this.buildRequestBody(
        this.buildMessages(message, options?.historyOverride, useSystemRole),
        options?.tools,
      );

      debugLogger.log(
        `[OpenAiChat] Request to ${this.baseUrl}/chat/completions [model=${this.modelName}]:`,
        JSON.stringify(body, null, 2),
      );

      try {
        yield* this._doSend(body, signal);
        return;
      } catch (e) {
        if (
          attempt === 0 &&
          e instanceof Error &&
          (e.message.includes('Role must be in') ||
            e.message.includes('Unsupported role'))
        ) {
          useSystemRole = false;
          continue;
        }
        throw e;
      }
    }
  }

  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  addHistory(message: ChatMessage): void {
    this.history.push(message);
  }

  clearHistory(): void {
    this.history = [];
  }

  getLastPromptTokenCount(): number {
    return this.lastTokenCount;
  }

  recordCompletedToolCalls(
    toolCallId: string,
    name: string,
    response: Record<string, unknown>,
  ): void {
    this.history.push({
      role: 'tool',
      toolCallId,
      toolName: name,
      content: JSON.stringify(response),
    });
  }

  private buildMessages(
    message: string | ChatMessage[],
    historyOverride?: ChatMessage[],
    useSystemRole = true,
  ): ChatMessage[] {
    const msgs: ChatMessage[] = [];

    if (this.systemInstruction) {
      msgs.push({
        role: useSystemRole ? 'system' : 'user',
        content: this.systemInstruction,
      });
    }

    const baseHistory = historyOverride ?? this.history;
    for (const h of baseHistory) {
      msgs.push(h);
    }

    if (typeof message === 'string') {
      msgs.push({ role: 'user', content: message });
    } else {
      for (const m of message) {
        msgs.push(m);
      }
    }

    return msgs;
  }

  private buildRequestBody(
    messages: ChatMessage[],
    tools?: ChatToolDefinition[],
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.modelName,
      messages: messages.map((m) => this.toOpenAiMessage(m)),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (tools && tools.length > 0) {
      body['tools'] = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    return body;
  }

  private toOpenAiMessage(msg: ChatMessage): Record<string, unknown> {
    const result: Record<string, unknown> = { role: msg.role };

    if (msg.role === 'tool') {
      result['tool_call_id'] = msg.toolCallId;
      result['content'] = msg.content ?? '';
      return result;
    }

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      result['content'] = msg.content ?? null;
      result['tool_calls'] = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments),
        },
      }));
      return result;
    }

    result['content'] = msg.content ?? '';
    return result;
  }

  private async fetchWithRetry(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Response> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });

        if (response.status === 429 && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }

        return response;
      } catch (e) {
        if (signal.aborted) throw e;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    throw new Error('Request failed after retries');
  }

  private async handleHttpError(response: Response): Promise<never> {
    let errorText = '';
    try {
      errorText = await response.text();
    } catch {
      errorText = `HTTP ${response.status}`;
    }
    const err = new Error(`OpenAI API error ${response.status}: ${errorText}`);
    Object.defineProperty(err, 'status', { value: response.status });
    throw err;
  }

  private mapFinishReason(reason: string): ChatResponse['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
      case 'max_tokens':
        return 'max_tokens';
      case 'tool_calls':
        return 'tool_calls';
      case 'error':
        return 'error';
      default:
        return 'other';
    }
  }
}
