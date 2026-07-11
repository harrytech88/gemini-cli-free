/* eslint-disable headers/header-format */
/**
 * @license
 * Copyright 2026 Harry Dau
 * SPDX-License-Identifier: MIT
 */

import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { ChatClient } from './chatClient.js';
import { GeminiChatAdapter } from './geminiChatAdapter.js';
import { OpenAiChat } from './openAiChat.js';

export type ProviderType =
  | 'gemini'
  | 'openai'
  | 'anthropic'
  | 'openai-compatible';

export interface ProviderConfig {
  type: ProviderType;
  apiKey: string;
  baseUrl?: string;
  modelName: string;
}

export class ChatClientFactory {
  static createClient(
    provider: ProviderConfig,
    context: AgentLoopContext,
  ): ChatClient {
    switch (provider.type) {
      case 'gemini':
        return new GeminiChatAdapter(context, provider);
      case 'openai':
      case 'openai-compatible':
        return new OpenAiChat(context, {
          apiKey: provider.apiKey,
          baseUrl:
            provider.baseUrl ||
            process.env['OPENAI_COMPATIBLE_BASE_URL'] ||
            'https://api.openai.com/v1',
          modelName: provider.modelName,
        });
      case 'anthropic':
        throw new Error(
          `Anthropic adapter not yet implemented. Provider type: ${provider.type}`,
        );
      default:
        throw new Error(
          `Unknown provider type: ${(provider as { type: string }).type}`,
        );
    }
  }
}
