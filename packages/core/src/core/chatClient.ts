/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

/**
 * Provider-agnostic representation of a message in the conversation.
 * Normalizes the different formats (Gemini Content, OpenAI ChatML, Anthropic messages).
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string;
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
  toolName?: string;
  name?: string;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export enum ChatStreamEventType {
  CHUNK = 'chunk',
  RETRY = 'retry',
  AGENT_EXECUTION_STOPPED = 'agent_execution_stopped',
  AGENT_EXECUTION_BLOCKED = 'agent_execution_blocked',
}

export type ChatStreamEvent =
  | { type: ChatStreamEventType.CHUNK; value: ChatResponse }
  | { type: ChatStreamEventType.RETRY }
  | { type: ChatStreamEventType.AGENT_EXECUTION_STOPPED; reason: string }
  | { type: ChatStreamEventType.AGENT_EXECUTION_BLOCKED; reason: string };

export interface ChatResponse {
  content?: string;
  toolCalls?: ChatToolCall[];
  finishReason?: 'stop' | 'max_tokens' | 'tool_calls' | 'error' | 'other';
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ChatToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatRequestConfig {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  stopSequences?: string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
}

export interface ChatClient {
  initialize(resumedSessionData?: unknown, kind?: string): Promise<void>;

  setSystemInstruction(sysInstr: string): void;

  getSystemInstruction(): string;

  sendMessageStream(
    message: string | ChatMessage[],
    signal: AbortSignal,
    options?: {
      tools?: ChatToolDefinition[];
      config?: ChatRequestConfig;
      historyOverride?: ChatMessage[];
    },
  ): AsyncGenerator<ChatStreamEvent>;

  getHistory(): ChatMessage[];

  addHistory(message: ChatMessage): void;

  clearHistory(): void;

  getLastPromptTokenCount(): number;

  recordCompletedToolCalls(
    toolCallId: string,
    name: string,
    response: Record<string, unknown>,
  ): void;
}
