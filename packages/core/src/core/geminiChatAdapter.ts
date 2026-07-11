/* eslint-disable headers/header-format */
/**
 * @license
 * Copyright 2026 Harry Dau
 * SPDX-License-Identifier: MIT
 */

import { type Content, type Part, type PartListUnion } from '@google/genai';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { ModelConfigKey } from '../services/modelConfigService.js';
import { getResponseText } from '../utils/partUtils.js';
import { LlmRole } from '../telemetry/types.js';
import {
  type ChatClient,
  type ChatMessage,
  type ChatResponse,
  type ChatStreamEvent,
  type ChatToolCall,
  type ChatToolDefinition,
  ChatStreamEventType,
} from './chatClient.js';
import type { ProviderConfig } from './chatClientFactory.js';
import { GeminiChat, StreamEventType, type StreamEvent } from './geminiChat.js';
import {
  CoreToolCallStatus,
  type CompletedToolCall,
} from '../scheduler/types.js';
import type { ResumedSessionData } from '../services/chatRecordingService.js';

export class GeminiChatAdapter implements ChatClient {
  readonly inner: GeminiChat;
  private readonly provider: ProviderConfig;

  constructor(
    readonly context: AgentLoopContext,
    provider: ProviderConfig,
    initialHistory?: Array<
      | import('@google/genai').Content
      | import('./agentChatHistory.js').HistoryTurn
    >,
    resumedSessionData?: unknown,
    onModelChanged?: (
      modelId: string,
    ) => Promise<Array<import('@google/genai').Tool>>,
  ) {
    this.provider = provider;
    this.inner = this.createInnerChat(
      initialHistory,
      resumedSessionData,
      onModelChanged,
    );
  }

  private createInnerChat(
    initialHistory?: Array<
      | import('@google/genai').Content
      | import('./agentChatHistory.js').HistoryTurn
    >,
    resumedSessionData?: unknown,
    onModelChanged?: (
      modelId: string,
    ) => Promise<Array<import('@google/genai').Tool>>,
  ): GeminiChat {
    return new GeminiChat(
      this.context,
      '',
      [],
      initialHistory ?? [],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      resumedSessionData as ResumedSessionData | undefined,
      onModelChanged ??
        (async (modelId: string) => {
          const toolRegistry = this.context.toolRegistry;
          const toolDeclarations =
            toolRegistry.getFunctionDeclarations(modelId);
          return [{ functionDeclarations: toolDeclarations }];
        }),
    );
  }

  async initialize(resumedSessionData?: unknown, kind?: string): Promise<void> {
    await this.inner.initialize(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      resumedSessionData as Parameters<typeof this.inner.initialize>[0],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      kind as Parameters<typeof this.inner.initialize>[1],
    );
  }

  setSystemInstruction(sysInstr: string): void {
    this.inner.setSystemInstruction(sysInstr);
  }

  getSystemInstruction(): string {
    return this.inner.getSystemInstruction();
  }

  async *sendMessageStream(
    message: string | ChatMessage[],
    signal: AbortSignal,
    options?: {
      tools?: ChatToolDefinition[];
      config?: import('./chatClient.js').ChatRequestConfig;
      historyOverride?: ChatMessage[];
    },
  ): AsyncGenerator<ChatStreamEvent> {
    const modelConfigKey: ModelConfigKey = {
      model: this.provider.modelName,
      isChatModel: true,
    };

    const req: PartListUnion =
      typeof message === 'string'
        ? [{ text: message }]
        : this.chatMessagesToParts(message);

    const stream = this.inner.sendMessageStream(
      modelConfigKey,
      req,
      this.context.promptId,
      signal,
      LlmRole.MAIN,
      undefined,
      options?.historyOverride
        ? this.chatMessagesToContents(options.historyOverride)
        : undefined,
    );

    for await (const event of await stream) {
      const converted = this.convertStreamEvent(event);
      if (converted) {
        yield converted;
      }
    }
  }

  private convertStreamEvent(event: StreamEvent): ChatStreamEvent | null {
    switch (event.type) {
      case StreamEventType.RETRY:
        return { type: ChatStreamEventType.RETRY };
      case StreamEventType.AGENT_EXECUTION_STOPPED:
        return {
          type: ChatStreamEventType.AGENT_EXECUTION_STOPPED,
          reason: event.reason,
        };
      case StreamEventType.AGENT_EXECUTION_BLOCKED:
        return {
          type: ChatStreamEventType.AGENT_EXECUTION_BLOCKED,
          reason: event.reason,
        };
      case StreamEventType.CHUNK: {
        const resp = event.value;
        const functionCalls = resp.functionCalls ?? [];
        const toolCalls: ChatToolCall[] = functionCalls.map((fc) => ({
          id: fc.id ?? '',
          type: 'function' as const,
          function: {
            name: fc.name?.trim() || 'generic_tool',
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            arguments: (fc.args as Record<string, unknown>) ?? {},
          },
        }));

        let finishReason: ChatResponse['finishReason'];
        const rawFinishReason = resp.candidates?.[0]?.finishReason;
        if (rawFinishReason) {
          const reasonStr = String(rawFinishReason).toLowerCase();
          if (reasonStr.includes('stop')) finishReason = 'stop';
          else if (reasonStr.includes('max') || reasonStr.includes('length'))
            finishReason = 'max_tokens';
          else if (reasonStr.includes('tool') || reasonStr.includes('function'))
            finishReason = 'tool_calls';
          else if (reasonStr.includes('error') || reasonStr.includes('safety'))
            finishReason = 'error';
          else finishReason = 'other';
        }

        const usage = resp.usageMetadata
          ? {
              promptTokens: resp.usageMetadata.promptTokenCount ?? 0,
              completionTokens: resp.usageMetadata.candidatesTokenCount ?? 0,
              totalTokens: resp.usageMetadata.totalTokenCount ?? 0,
            }
          : undefined;

        return {
          type: ChatStreamEventType.CHUNK,
          value: {
            content: getResponseText(resp) ?? undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            finishReason,
            usage,
          },
        };
      }
      default:
        return null;
    }
  }

  getHistory(): ChatMessage[] {
    const history = this.inner.getHistory(false);
    return history.map((c) => this.contentToChatMessage(c));
  }

  private contentToChatMessage(content: Content): ChatMessage {
    const text = getResponseText(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      content as unknown as Parameters<typeof getResponseText>[0],
    );

    const functionCalls =
      content.parts
        ?.filter((p) => p.functionCall)
        .map(
          (p) =>
            ({
              id: p.functionCall?.id ?? '',
              type: 'function' as const,
              function: {
                name: p.functionCall?.name?.trim() || 'generic_tool',
                /* eslint-disable */
                arguments:
                  (p.functionCall?.args as unknown as Record<
                    string,
                    unknown
                  >) ?? {},
                /* eslint-enable */
              },
            }) as ChatToolCall,
        ) ?? [];

    const functionResponses = content.parts?.filter((p) => p.functionResponse);

    let role;
    switch (content.role) {
      case 'user':
        role = 'user' as ChatMessage['role'];
        break;
      case 'model':
        role = 'assistant' as ChatMessage['role'];
        break;
      default:
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        role = content.role as ChatMessage['role'];
    }

    if (functionResponses && functionResponses.length > 0) {
      const fr = functionResponses[0].functionResponse;
      return {
        role: 'tool',
        content: text ?? undefined,
        toolCallId: fr?.id ?? '',
        toolName: fr?.name ?? '',
      };
    }

    return {
      role,
      content: text ?? undefined,
      toolCalls: functionCalls.length > 0 ? functionCalls : undefined,
    };
  }

  addHistory(message: ChatMessage): void {
    this.inner.addHistory(this.chatMessageToContent(message));
  }

  clearHistory(): void {
    this.inner.clearHistory();
  }

  getLastPromptTokenCount(): number {
    return this.inner.getLastPromptTokenCount();
  }

  recordCompletedToolCalls(
    toolCallId: string,
    name: string,
    response: Record<string, unknown>,
  ): void {
    this.inner.recordCompletedToolCalls(name, [
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      {
        status: CoreToolCallStatus.Success,
        request: {
          callId: toolCallId,
          name,
          args: {},
          isClientInitiated: false,
          prompt_id: this.context.promptId,
        },
        response: {
          callId: toolCallId,
          responseParts: [
            {
              functionResponse: {
                name,
                response,
                id: toolCallId,
              },
            },
          ],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
        },
      } as CompletedToolCall,
    ]);
  }

  private chatMessagesToParts(messages: ChatMessage[]): PartListUnion {
    const parts: Part[] = [];
    for (const msg of messages) {
      if (msg.content) {
        parts.push({ text: msg.content });
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: tc.function.arguments,
              id: tc.id,
            },
          });
        }
      }
    }
    return parts;
  }

  private chatMessagesToContents(messages: ChatMessage[]): Content[] {
    return messages.map((m) => this.chatMessageToContent(m));
  }

  private chatMessageToContent(message: ChatMessage): Content {
    const parts: Part[] = [];
    if (message.content) {
      parts.push({ text: message.content });
    }
    if (message.toolCalls) {
      for (const tc of message.toolCalls) {
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: tc.function.arguments,
            id: tc.id,
          },
        });
      }
    }
    if (message.toolCallId && message.toolName) {
      parts.push({
        functionResponse: {
          name: message.toolName,
          response: { content: message.content ?? '' },
          id: message.toolCallId,
        },
      });
    }

    let role: string;
    switch (message.role) {
      case 'user':
        role = 'user';
        break;
      case 'assistant':
        role = 'model';
        break;
      case 'system':
        role = 'user';
        break;
      case 'tool':
        role = 'user';
        break;
      default:
        role = 'user';
    }

    return { role, parts };
  }
}
