/* eslint-disable headers/header-format */
/**
 * @license
 * Copyright 2026 Harry Dau
 * SPDX-License-Identifier: MIT
 */

import { type Content, type PartListUnion } from '@google/genai';
import type {
  ChatClient,
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
} from './chatClient.js';
import { GeminiEventType, type ServerGeminiStreamEvent } from './turn.js';
import type { ToolCallRequestInfo } from '../scheduler/types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { populateToolDisplay } from '../agent/tool-display-utils.js';
import { getErrorMessage, toFriendlyError } from '../utils/errors.js';
import type { ModelConfigKey } from '../services/modelConfigService.js';

export class ChatClientTurn {
  private callCounter = 0;
  readonly pendingToolCalls: ToolCallRequestInfo[] = [];
  private responseText = '';
  finishReason: string | undefined;

  constructor(
    private readonly client: ChatClient,
    private readonly prompt_id: string,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  private async *_send(
    message: string,
    signal: AbortSignal,
    tools: ChatToolDefinition[] | undefined,
    historyOverride: ChatMessage[] | undefined,
  ): AsyncGenerator<ServerGeminiStreamEvent> {
    const stream = this.client.sendMessageStream(message, signal, {
      tools,
      historyOverride,
    });

    for await (const event of stream) {
      if (signal?.aborted) {
        yield { type: GeminiEventType.UserCancelled };
        return;
      }

      switch (event.type) {
        case 'chunk': {
          const response = event.value;

          if (response.content) {
            this.responseText += response.content;
            yield {
              type: GeminiEventType.Content,
              value: response.content,
            };
          }

          if (response.toolCalls && response.toolCalls.length > 0) {
            for (const tc of response.toolCalls) {
              const toolEvent = this.handleToolCall(tc);
              if (toolEvent) yield toolEvent;
            }
          }

          if (response.finishReason) {
            const finishMap: Record<string, string> = {
              stop: 'STOP',
              max_tokens: 'MAX_TOKENS',
              tool_calls: 'STOP',
              error: 'ERROR',
              other: 'OTHER',
            };
            this.finishReason = finishMap[response.finishReason] || 'OTHER';
            yield {
              type: GeminiEventType.Finished,
              value: {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                reason: this.finishReason as never,
                usageMetadata: response.usage
                  ? {
                      promptTokenCount: response.usage.promptTokens,
                      candidatesTokenCount: response.usage.completionTokens,
                      totalTokenCount: response.usage.totalTokens,
                    }
                  : undefined,
              },
            };
          }
          break;
        }
        case 'retry':
          yield { type: GeminiEventType.Retry };
          break;
        case 'agent_execution_stopped':
          yield {
            type: GeminiEventType.AgentExecutionStopped,
            value: { reason: event.reason },
          };
          return;
        case 'agent_execution_blocked':
          yield {
            type: GeminiEventType.AgentExecutionBlocked,
            value: { reason: event.reason },
          };
          continue;
        default:
          break;
      }
    }
  }

  private isToolsNotSupportedError(e: unknown): boolean {
    if (e instanceof Error) {
      return (
        e.message.includes('Function call not supported') ||
        (e.message.includes('tool') && e.message.includes('not supported'))
      );
    }
    return false;
  }

  async *run(
    _modelConfigKey: ModelConfigKey,
    req: PartListUnion,
    signal: AbortSignal,
    options: {
      displayContent?: PartListUnion;
      role?: unknown;
      apiHistoryOverride?: Content[];
    } = {},
  ): AsyncGenerator<ServerGeminiStreamEvent> {
    const message = Array.isArray(req)
      ? req
          .map((p) => (typeof p === 'object' && 'text' in p ? p.text : ''))
          .join('')
          .trim() || '...'
      : typeof req === 'string'
        ? req
        : '...';

    const historyOverride: ChatMessage[] | undefined =
      options.apiHistoryOverride
        ? options.apiHistoryOverride.map((content) => {
            const text =
              content.parts
                ?.map((p) =>
                  typeof p === 'object' && 'text' in p ? p.text : '',
                )
                .join('') || '';
            if (content.role === 'user') {
              return { role: 'user' as const, content: text };
            }
            return { role: 'assistant' as const, content: text };
          })
        : undefined;

    const tools = this.toolRegistry
      .getFunctionDeclarations(_modelConfigKey.model)
      .map((fd) => ({
        name: fd.name || '',
        description: fd.description || '',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        inputSchema: (fd.parameters as Record<string, unknown>) ?? {},
      }));

    const toolsToSend = tools.length > 0 ? tools : undefined;

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const attemptTools = attempt === 0 ? toolsToSend : undefined;
        yield* this._send(message, signal, attemptTools, historyOverride);
        return;
      } catch (e) {
        lastError = e;
        if (attempt === 0 && toolsToSend && this.isToolsNotSupportedError(e)) {
          continue;
        }
        break;
      }
    }

    if (signal.aborted) {
      yield { type: GeminiEventType.UserCancelled };
      return;
    }

    const error = toFriendlyError(lastError);
    yield {
      type: GeminiEventType.Error,
      value: {
        error: {
          message: getErrorMessage(error),
        },
      },
    };
  }

  private handleToolCall(tc: ChatToolCall): ServerGeminiStreamEvent | null {
    const name = tc.function.name;
    const args = tc.function.arguments;
    const tool = this.toolRegistry.getTool(name);
    let display;
    if (tool) {
      let invocation;
      try {
        invocation = tool.build(args);
      } catch {
        // Ignore build errors for request display
      }
      display = populateToolDisplay({
        name,
        invocation,
        displayName: tool.displayName,
      });
      if (!display.description) {
        display.description = tool.description;
      }
    }

    const callId = tc.id || `${name}_${Date.now()}_${this.callCounter++}`;
    const toolCallRequest: ToolCallRequestInfo = {
      callId,
      name,
      args,
      display,
      isClientInitiated: false,
      prompt_id: this.prompt_id,
    };

    this.pendingToolCalls.push(toolCallRequest);
    return {
      type: GeminiEventType.ToolCallRequest,
      value: toolCallRequest,
    };
  }

  getResponseText(): string {
    return this.responseText;
  }
}
