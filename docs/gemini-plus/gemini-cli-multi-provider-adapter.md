# Multi-Provider Chat Adapter Plan

## 1. The Core Problem

`GeminiChat` (`packages/core/src/core/geminiChat.ts`) is tightly coupled to the
Google Gemini SDK (`@google/genai`). Every method, type, and streaming event is
specific to Gemini's `GenerateContentResponse`. To support OpenAI-compatible
APIs (OpenAI, Anthropic, Ollama, etc.) without an external proxy, we need a
provider-agnostic interface and adapter implementations.

## 2. The `ChatClient` Interface

A new shared interface that `GeminiChat` (refactored) and `OpenAiChat` (new)
both implement.

```typescript
// packages/core/src/core/chatClient.ts

import type { AsyncGenerator } from 'stream';
import type { AgentLoopContext } from '../config/agent-loop-context.js';

/**
 * Provider-agnostic representation of a message in the conversation.
 * Normalizes the different formats (Gemini Content, OpenAI ChatML, Anthropic messages).
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string;
  toolCalls?: ChatToolCall[];
  toolCallId?: string; // for tool result messages
  toolName?: string; // for tool result messages
  name?: string; // for function calls in some formats
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * Provider-agnostic stream event.
 */
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

/**
 * Provider-agnostic model response (one chunk of a stream).
 */
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

/**
 * Abstraction for a single-model tool definition.
 */
export interface ChatToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Provider-agnostic configuration for a generation request.
 */
export interface ChatRequestConfig {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  stopSequences?: string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
}

/**
 * The core interface all chat clients must implement.
 * This replaces direct GeminiChat usage in the AgentLoop.
 */
export interface ChatClient {
  /** Initialize the client with history. */
  initialize(resumedSessionData?: unknown, kind?: string): Promise<void>;

  /** Set the system instruction. */
  setSystemInstruction(sysInstr: string): void;

  /** Get the current system instruction. */
  getSystemInstruction(): string;

  /** Send a message and get back a stream of events. */
  sendMessageStream(
    message: string | ChatMessage[],
    signal: AbortSignal,
    options?: {
      tools?: ChatToolDefinition[];
      config?: ChatRequestConfig;
      historyOverride?: ChatMessage[];
    },
  ): Promise<AsyncGenerator<ChatStreamEvent>>;

  /** Get the conversation history in provider-agnostic format. */
  getHistory(): ChatMessage[];

  /** Add a message to history. */
  addHistory(message: ChatMessage): void;

  /** Clear all history. */
  clearHistory(): void;

  /** Get token count from the last prompt. */
  getLastPromptTokenCount(): number;

  /** Record completed tool calls back into history. */
  recordCompletedToolCalls(
    toolCallId: string,
    name: string,
    response: Record<string, unknown>,
  ): void;
}
```

### Design Decisions

1. **Normalized types only at the boundary.** The `ChatMessage`, `ChatToolCall`,
   `ChatResponse` types are the _only_ shared types. Each adapter translates
   internally to/from its provider's native format. No Gemini types leak out; no
   OpenAI types leak out.

2. **No `ModelConfigKey` in the interface.** The adapter manages its own model
   name and endpoint. The `ModelRouterService` resolves a provider + model name,
   and the correct adapter is instantiated with the right endpoint
   configuration.

3. **AsyncGenerator pattern preserved.** The existing `Turn` class and
   `Scheduler` already consume `StreamEvent` objects. The adapter layer produces
   `ChatStreamEvent`, and the `Turn` (or a new thin wrapper) converts them to
   the existing `ServerGeminiStreamEvent` format. This minimizes changes to the
   downstream consumers.

---

## 3. Adapter Architecture

```
                    ┌─────────────────────────────────────┐
                    │          AgentLoop / Turn            │
                    │    (mostly unchanged, consumes       │
                    │     StreamEvent as before)           │
                    └──────────┬──────────────────────────┘
                               │
                    ┌──────────▼──────────────────────────┐
                    │       ChatClientFactory              │
                    │  (selects adapter by provider type)   │
                    └──────────┬──────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
     │  GeminiChat  │  │  OpenAiChat  │  │AnthropicChat │
     │  (refactored)│  │   (new)      │  │   (future)   │
     └──────────────┘  └──────────────┘  └──────────────┘
              │                │                │
              ▼                ▼                ▼
     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
     │ Google GenAI │  │  OpenAI SDK  │  │ Anthropic SDK│
     │    SDK       │  │  (or fetch)  │  │   (or fetch) │
     └──────────────┘  └──────────────┘  └──────────────┘
```

### `ChatClientFactory`

```typescript
// packages/core/src/core/chatClientFactory.ts

export type ProviderType =
  | 'gemini'
  | 'openai'
  | 'anthropic'
  | 'openai-compatible';

export interface ProviderConfig {
  type: ProviderType;
  apiKey: string;
  baseUrl?: string; // for OpenAI-compatible (Ollama, vLLM, etc.)
  modelName: string; // provider-specific model name
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
        return new OpenAiChat(context, provider);
      case 'anthropic':
        return new AnthropicChat(context, provider);
    }
  }
}
```

---

## 4. Model Definitions Update

### Current state (`defaultModelConfigs.ts`)

Models are defined by a string name + chain. There's no `provider` field:

```typescript
modelDefinitions: {
  'gemini-2.5-pro': {
    tier: 'pro',
    family: 'gemini',
    isPreview: false,
    features: { supportsModernFeatures: true },
  },
}
```

### New state

Add a `provider` field to model definitions:

```typescript
modelDefinitions: {
  'gemini-2.5-pro': {
    tier: 'pro',
    family: 'gemini',
    provider: 'gemini',        // NEW
    apiKeyEnvVar: 'GEMINI_API_KEY',
    isPreview: false,
    features: { supportsModernFeatures: true },
  },
  'gpt-4o': {
    tier: 'pro',
    family: 'openai',
    provider: 'openai',        // NEW
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    isPreview: false,
    features: { supportsModernFeatures: true },
  },
  'claude-sonnet-4': {
    tier: 'pro',
    family: 'anthropic',
    provider: 'anthropic',     // NEW
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com/v1',
    isPreview: false,
    features: { supportsModernFeatures: false },
  },
  'ollama-llama3': {
    tier: 'flash',
    family: 'openai-compatible',
    provider: 'openai-compatible', // NEW
    baseUrl: 'http://localhost:11434/v1',
    apiKeyEnvVar: '',          // no key needed for local
    isPreview: false,
    features: { supportsModernFeatures: true },
  },
}
```

### `ModelConfigService` changes

The `ModelRouterService` resolves a model name and now also resolves its
`provider`. The `RoutingDecision` gets a new field:

```typescript
export interface RoutingDecision {
  model: string; // concrete model name (e.g. 'gpt-4o')
  provider: ProviderType; // NEW
  baseUrl?: string; // NEW
  metadata: { source: string; latencyMs: number; reasoning: string };
}
```

---

## 5. `OpenAiChat` Adapter Design

### File: `packages/core/src/core/openAiChat.ts`

### Constructor

```typescript
export class OpenAiChat implements ChatClient {
  private history: ChatMessage[] = [];
  private systemInstruction: string = '';
  private lastTokenCount: number = 0;

  constructor(
    private context: AgentLoopContext,
    private config: {
      apiKey: string;
      baseUrl: string;
      modelName: string;
    },
  ) {}

  // ... implements ChatClient
}
```

### `sendMessageStream` Implementation

Converts the normalized request to OpenAI ChatML format:

```
Request:
  POST {baseUrl}/chat/completions
  Headers: Authorization: Bearer {apiKey}
  Body:
    model: {modelName}
    messages: [
      { role: "system", content: systemInstruction },
      ...history.map(toChatML),
      { role: "user", content: message }
    ]
    tools: [...toolDefinitions.map(toOpenAIFormat)]
    stream: true
    temperature, max_tokens, etc.
```

Response parsing (stream of SSE `data:` lines):

```typescript
// OpenAI delta format:
// {"choices":[{"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}
// {"choices":[{"delta":{"tool_calls":[{"id":"call_xxx","function":{"name":"read_file","arguments":"{\"path\":\"...\"}"}}]},"finish_reason":"tool_calls"}]}

// Converted to ChatStreamEvent:
{
  type: ChatStreamEventType.CHUNK,
  value: {
    content: "Hello",
    toolCalls: [{ id: "call_xxx", type: "function", function: { name: "read_file", arguments: {...} } }],
    finishReason: "tool_calls",
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  },
}
```

### Type Mapping (OpenAI -> Normalized)

| OpenAI                                                       | ChatClient                                       |
| ------------------------------------------------------------ | ------------------------------------------------ |
| `messages[].role: "system"`                                  | `role: "system"`                                 |
| `messages[].role: "user"`                                    | `role: "user"`                                   |
| `messages[].role: "assistant"` with `content` + `tool_calls` | `role: "assistant"` with `content` + `toolCalls` |
| `messages[].role: "tool"` with `content` + `tool_call_id`    | `role: "tool"` with `content` + `toolCallId`     |
| `tools[].function`                                           | `ChatToolDefinition`                             |
| `stream_options: { include_usage: true }`                    | `usage` field in `ChatResponse`                  |
| SSE `data: [DONE]`                                           | stream ends                                      |

### Tool Call Consolidation

OpenAI sends function arguments as a concatenated string across multiple stream
chunks (`arguments: "{\"path\":"`, `arguments: "\"/src/foo.ts\""`,
`arguments: "}"`). The adapter must accumulate these and parse the final JSON:

```typescript
private accumulatedToolCalls: Map<string, { id: string; name: string; args: string }> = new Map();

// On each delta with tool_calls:
for (const toolCallDelta of delta.tool_calls) {
  if (toolCallDelta.id) {
    // New tool call started
    this.accumulatedToolCalls.set(toolCallDelta.index, {
      id: toolCallDelta.id,
      name: toolCallDelta.function.name,
      args: '',
    });
  }
  if (toolCallDelta.function?.arguments) {
    const existing = this.accumulatedToolCalls.get(toolCallDelta.index);
    existing.args += toolCallDelta.function.arguments;
  }
}

// On finish, parse all accumulated args as JSON
for (const [index, tc] of this.accumulatedToolCalls) {
  tc.args = JSON.parse(tc.args);
}
```

---

## 6. `AnthropicChat` Adapter (Future)

Anthropic's API is different enough to warrant its own adapter:

| Anthropic                                                                                                 | Normalized                                   |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `system: [{"text": "..."}]` (separate from messages)                                                      | `systemInstruction`                          |
| `messages[].role: "user"` with `content: [{"type":"text","text":"..."}]`                                  | `role: "user"`                               |
| `messages[].role: "assistant"` with `content: [{"type":"text","text":"..."}]` + `stop_reason: "tool_use"` | `role: "assistant"` with content + toolCalls |
| `content[].type: "tool_use"` with `id`, `name`, `input`                                                   | `toolCalls`                                  |
| `content[].type: "tool_result"` with `tool_use_id`, `content`                                             | `role: "tool"` with `toolCallId`             |
| `tools[]` with `name`, `description`, `input_schema`                                                      | `ChatToolDefinition`                         |
| `stop_reason: "end_turn"`                                                                                 | `finishReason: "stop"`                       |
| `stop_reason: "max_tokens"`                                                                               | `finishReason: "max_tokens"`                 |
| `stop_reason: "tool_use"`                                                                                 | `finishReason: "tool_calls"`                 |

Key differences from OpenAI:

- `system` is a separate top-level parameter, not a message role
- Content blocks are typed objects (`text`, `tool_use`, `tool_result`), not a
  flat string
- Tool calls use `id` at the content block level, not as a separate parameter
- Streaming uses SSE with `content_block_delta`, `content_block_stop`,
  `message_delta` event types rather than delta objects

---

## 7. Changes to Existing Code

### 7.1 GeminiChat Refactoring

The existing `GeminiChat` is ~1400 lines. Rather than rewriting it, create a
thin adapter:

```typescript
// packages/core/src/core/geminiChatAdapter.ts

export class GeminiChatAdapter implements ChatClient {
  private inner: GeminiChat; // existing class, mostly unchanged

  constructor(context: AgentLoopContext, provider: ProviderConfig) {
    // Instantiate the existing GeminiChat as before
    this.inner = new GeminiChat(context, ...);
  }

  async sendMessageStream(message, signal, options): Promise<AsyncGenerator<ChatStreamEvent>> {
    // Call inner.sendMessageStream
    // Convert each StreamEvent to ChatStreamEvent
    for await (const event of this.inner.sendMessageStream(...)) {
      yield this.convertEvent(event);
    }
  }

  private convertEvent(event: StreamEvent): ChatStreamEvent { ... }
  private convertResponse(response: GenerateContentResponse): ChatResponse { ... }
}
```

The conversion is trivial because `GenerateContentResponse` maps 1:1 to
`ChatResponse`.

### 7.2 Turn Class Changes

The `Turn` class (`turn.ts`) currently consumes `StreamEvent` from
`GeminiChat.sendMessageStream()` and converts to `ServerGeminiStreamEvent`. It
needs to consume `ChatStreamEvent` from `ChatClient.sendMessageStream()`
instead.

Since both event types have similar structure (CHUNK, RETRY,
AGENT_EXECUTION_STOPPED, AGENT_EXECUTION_BLOCKED), the conversion is
straightforward:

```typescript
// turn.ts - before
const responseStream = await this.chat.sendMessageStream(...);

// turn.ts - after
const responseStream = await this.chat.sendMessageStream(...);
// this.chat is now ChatClient, not GeminiChat
```

The `Turn` already extracts `functionCalls` from chunks -- it would instead
extract `ChatResponse.toolCalls`.

### 7.3 GeminiClient (client.ts)

Currently creates `GeminiChat` directly:

```typescript
// client.ts - before
const chat = new GeminiChat(
  config,
  sysInstr,
  tools,
  history,
  resumedData,
  onModelChanged,
);

// client.ts - after
const provider = config.getActiveModelProvider(); // NEW: resolves current model's provider
const chat = ChatClientFactory.createClient(provider, config);
await chat.initialize(resumedSessionData);
```

### 7.4 ModelRouterService

Add `provider` to `RoutingDecision`:

```typescript
// routingStrategy.ts
export interface RoutingDecision {
  model: string;
  provider: ProviderType; // NEW
  baseUrl?: string;       // NEW
  metadata: { ... };
}
```

The `DefaultStrategy` and all other strategies must resolve the provider from
model definitions when creating a decision.

### 7.5 Config

Add provider configuration fields:

```typescript
// config.ts
interface ProviderCredentials {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  // ... per-provider keys
}

getActiveModelProvider(): ProviderConfig {
  const modelDef = this.getModelDefinition(this.getActiveModel());
  const apiKey = this.resolveApiKey(modelDef.apiKeyEnvVar);
  return {
    type: modelDef.provider,
    apiKey,
    baseUrl: modelDef.baseUrl,
    modelName: this.getActiveModel(),
  };
}
```

---

## 8. Tool Calling Compatibility

This is the hardest part. Different providers have different levels of
tool-calling support:

| Feature                     | Gemini                  | OpenAI                    | Anthropic                                  | Ollama (functionary) |
| --------------------------- | ----------------------- | ------------------------- | ------------------------------------------ | -------------------- |
| Parallel tool calls         | Native                  | Native                    | Yes (multiple tool_use blocks)             | Depends on model     |
| Partial arguments in stream | Yes (`partialArgs`)     | Yes (concatenated string) | No (complete JSON in `content_block_stop`) | Depends              |
| Tool call ID                | Yes (string)            | Yes (`tool_calls[].id`)   | Yes (`tool_use.id`)                        | Depends              |
| Function response           | `functionResponse` part | `tool` role message       | `tool_result` block                        | Depends              |

**Key insight:** The `Scheduler` and agent loop don't care about the tool format
-- they consume `ToolCallRequestInfo` objects with `{ callId, name, args }`. The
adapter is responsible for converting the provider's tool call format into
`ChatToolCall[]`. As long as each adapter produces consistent `ChatToolCall[]`,
the rest of the system is unchanged.

### Tool Definition Translation

Each adapter converts `ChatToolDefinition[]` to the provider's format:

```typescript
// OpenAiChat
toProviderTools(tools: ChatToolDefinition[]): OpenAI.Tool[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// AnthropicChat
toProviderTools(tools: ChatToolDefinition[]): Anthropic.Tool[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}
```

---

## 9. Implementation Plan

### Phase 1: Core Interface

**Goal:** Define `ChatClient` interface, refactor `GeminiChat` to
`GeminiChatAdapter`.

| File                            | Change                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `core/chatClient.ts`            | **New**: `ChatMessage`, `ChatToolCall`, `ChatResponse`, `ChatStreamEvent`, `ChatStreamEventType`, `ChatClient` interface |
| `core/chatClientFactory.ts`     | **New**: `ProviderType`, `ProviderConfig`, `ChatClientFactory.createClient()`                                            |
| `core/geminiChatAdapter.ts`     | **New**: Wraps existing `GeminiChat`, implements `ChatClient`, converts types                                            |
| `core/geminiChat.ts`            | No change (adapter uses it internally)                                                                                   |
| `core/turn.ts`                  | Change `chat` field type from `GeminiChat` to `ChatClient`; update event conversion                                      |
| `core/client.ts`                | Use `ChatClientFactory` instead of `new GeminiChat(...)`                                                                 |
| `config/defaultModelConfigs.ts` | Add `provider`, `apiKeyEnvVar`, `baseUrl` to model definitions                                                           |
| `routing/routingStrategy.ts`    | Add `provider`, `baseUrl` to `RoutingDecision`                                                                           |
| `routing/*.ts`                  | All strategies: populate `provider` field                                                                                |

**Estimated effort:** 3-4 days

### Phase 2: OpenAI Adapter

**Goal:** Working `OpenAiChat` that handles streaming, tool calls, and history.

| File                      | Change                                                              |
| ------------------------- | ------------------------------------------------------------------- |
| `core/openAiChat.ts`      | **New**: Full `ChatClient` implementation using OpenAI SDK or fetch |
| Install dependency        | `npm install openai` or use native `fetch` with SSE parsing         |
| `core/openAiChat.test.ts` | **New**: Tests with mocked OpenAI endpoints                         |

Key implementation details for `OpenAiChat`:

- SSE stream parsing (native `fetch` + `ReadableStream` to avoid an extra
  dependency)
- Tool call argument accumulation across stream deltas
- Usage token extraction from `stream_options: { include_usage: true }`
- Error mapping (OpenAI error codes -> ChatClient errors)
- Retry with backoff (reuse the existing `retryWithBackoff` from
  `utils/retry.ts`)
- Non-streaming fallback for simple calls (countTokens, etc.)

**Estimated effort:** 3-4 days

### Phase 3: Anthropic Adapter

**Goal:** Working `AnthropicChat` for Claude models.

| File                         | Change                                    |
| ---------------------------- | ----------------------------------------- |
| `core/anthropicChat.ts`      | **New**: Full `ChatClient` implementation |
| `core/anthropicChat.test.ts` | **New**: Tests                            |

Key differences from OpenAI adapter:

- `system` as separate field, not a message role
- Content block stream events (`content_block_start`, `content_block_delta`,
  `content_block_stop`)
- Tool use/result blocks instead of function calls
- Message-level `stop_reason` instead of per-choice `finish_reason`

**Estimated effort:** 2-3 days

### Phase 4: Router Integration

**Goal:** Model routing works across providers.

| File                                                | Change                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `routing/strategies/agentRecommendationStrategy.ts` | Already knows the domain; add `provider` field based on recommended model |
| `config/config.ts`                                  | `getActiveModelProvider()` resolves provider from model definition        |
| `config/config.ts`                                  | Add credential resolution (API keys per provider)                         |
| `config/defaultModelConfigs.ts`                     | Add OpenAI/Anthropic model entries                                        |
| Core Mandates prompt section                        | No change (system prompt is provider-agnostic)                            |

**Estimated effort:** 1-2 days

### Phase 5: Tool Call Coverage

**Goal:** Ensure all providers handle edge cases correctly.

| Feature                                              | Tests needed                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Parallel tool calls (multiple tools in one response) | All adapters                                                                              |
| Tool call with no arguments                          | OpenAI style: `arguments: "{}"`                                                           |
| Streaming tool call arguments (multi-chunk)          | OpenAI: concatenation; Anthropic: single block                                            |
| Tool execution errors handling                       | All adapters map to `tool` role response                                                  |
| Token counting across providers                      | OpenAI: `usage` in stream; Anthropic: `message_delta.usage`; Gemini: existing countTokens |

**Estimated effort:** 2-3 days

### Phase 6: Configuration & User Experience

**Goal:** Easy setup for multi-provider.

```yaml
# .gemini/config.yaml
models:
  - model: 'gpt-4o'
    provider: 'openai'
    api_key: '${OPENAI_API_KEY}'
    tier: 'pro'
  - model: 'gemini-2.5-pro'
    provider: 'gemini'
    api_key: '${GEMINI_API_KEY}'
    tier: 'pro'
  - model: 'ollama-llama3'
    provider: 'openai-compatible'
    base_url: 'http://localhost:11434/v1'
    tier: 'flash'
    no_key: true

routing:
  domina:
    summarization: 'ollama-llama3'
    investigation: 'gemini-2.5-flash'
    debugging: 'gpt-4o' # recommended by model
    code-gen: 'gpt-4o'
    planning: 'gemini-2.5-pro'
```

**Estimated effort:** 2-3 days

---

## 10. SSE Streaming (OpenAI/Native Fetch)

The OpenAI adapter can use native `fetch` instead of the `openai` npm package to
avoid the dependency. The key challenge is SSE parsing:

```typescript
// core/sseParser.ts

export async function* parseSSEStream(
  response: Response,
  signal: AbortSignal,
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
      buffer = lines.pop() || ''; // keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;
          yield { type: 'data', json: JSON.parse(data), raw: line };
        } else if (line.startsWith('event: ')) {
          yield { type: 'event', name: line.slice(7), raw: line };
        }
      }
    }
  } finally {
    reader.cancel();
    reader.releaseLock();
  }
}
```

---

## 11. File Summary

| File                            | Status       | Purpose                                              |
| ------------------------------- | ------------ | ---------------------------------------------------- |
| `core/chatClient.ts`            | **New**      | `ChatClient` interface + normalized types            |
| `core/chatClientFactory.ts`     | **New**      | Factory to create the right adapter                  |
| `core/geminiChatAdapter.ts`     | **New**      | Wraps existing GeminiChat                            |
| `core/openAiChat.ts`            | **New**      | OpenAI/OpenAI-compatible adater                      |
| `core/anthropicChat.ts`         | **New**      | Anthropic adater (Phase 3)                           |
| `core/sseParser.ts`             | **New**      | SSE stream parser for OpenAI                         |
| `core/geminiChat.ts`            | Unchanged    | Inner implementation                                 |
| `core/turn.ts`                  | **Modified** | `chat` type `GeminiChat` -> `ChatClient`             |
| `core/client.ts`                | **Modified** | Factory instead of direct instantiation              |
| `config/defaultModelConfigs.ts` | **Modified** | Add `provider`, `apiKeyEnvVar`, `baseUrl`            |
| `config/config.ts`              | **Modified** | `getActiveModelProvider()`, per-provider credentials |
| `routing/routingStrategy.ts`    | **Modified** | Add `provider`, `baseUrl` to `RoutingDecision`       |
| `routing/strategies/*.ts`       | **Modified** | Populate new RoutingDecision fields                  |
| `tools/tool-names.ts`           | Unchanged    | Tool names are provider-agnostic                     |
| `prompts/snippets.ts`           | Unchanged    | System prompt is provider-agnostic                   |

---

## 12. Risk Assessment

| Risk                                                       | Likelihood | Impact | Mitigation                                                                     |
| ---------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------ |
| OpenAI API format changes                                  | Low        | Medium | Single adapter file to update; no changes to rest of system                    |
| Tool call format incompatibility                           | Medium     | High   | Test with real API calls for each provider before release; document edge cases |
| Streaming parsing bugs                                     | Medium     | Medium | SSE parser is ~50 lines and well-tested pattern; add fuzz testing              |
| Rate limiting differs per provider                         | High       | Medium | Reuse existing `retryWithBackoff`; add per-provider rate limit config          |
| Token counting inconsistency                               | Low        | Low    | Each provider's SDK returns this differently; accept slight variance           |
| Anthropic doesn't support parallel tool calls consistently | Low        | Medium | Fall back to sequential tool execution for Anthropic                           |
