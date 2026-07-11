# Gemini CLI Model Routing Upgrade Plan

## 1. Introduction

### The Problem

The agent currently uses a **single model** per session. The model is chosen at
startup (via `config.getActiveModel()`) and only changes through explicit
fallback (rate limits, errors). This means:

- Simple reads and greps pay the same per-token cost as complex multi-file
  refactors
- A model optimized for code generation is also used for summarization and
  documentation
- No ability to route subtasks to specialized models during a single session

### The Solution

Let the **model itself** decide which model should handle the **next turn**.
After each turn, the model can recommend a model change based on what it plans
to do next. The system prompt already tells the model to plan and think ahead --
we extend that to model selection.

The existing routing infrastructure (`ModelRouterService` at
`packages/core/src/routing/modelRouterService.ts`) already supports composable
routing strategies. We add an **AgentRecommendationStrategy** that reads the
model's own recommendation.

---

## 2. Existing Infrastructure

The codebase already has significant routing infrastructure:

| Component                     | File                                        | Purpose                                                  |
| ----------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| `ModelRouterService`          | `routing/modelRouterService.ts:30`          | Central coordinator, chains strategies                   |
| `RoutingContext`              | `routing/routingStrategy.ts:32`             | Carries `history`, `request`, `signal`, `requestedModel` |
| `RoutingDecision`             | `routing/routingStrategy.ts:15`             | Output: `model` string + metadata                        |
| `DefaultStrategy`             | `strategies/defaultStrategy.ts`             | Terminal strategy, always returns a model                |
| `FallbackStrategy`            | `strategies/fallbackStrategy.ts`            | Handles availability fallback chains                     |
| `OverrideStrategy`            | `strategies/overrideStrategy.ts`            | User-forced model override                               |
| `ApprovalModeStrategy`        | `strategies/approvalModeStrategy.ts`        | Model choice by plan/auto/yolo mode                      |
| `ClassifierStrategy`          | `strategies/classifierStrategy.ts`          | LLM-based classifier to pick model                       |
| `NumericalClassifierStrategy` | `strategies/numericalClassifierStrategy.ts` | Numerical threshold-based classifier                     |
| `GemmaClassifierStrategy`     | `strategies/gemmaClassifierStrategy.ts`     | On-device Gemma classifier                               |
| `modelChains`                 | `config/defaultModelConfigs.ts:614`         | Fallback chains per tier (preview, default, lite)        |

### Current Router Flow (`client.ts`)

```
Start of each turn:
1. If currentSequenceModel is set -> use it (sticky)
2. Else -> ModelRouterService.route(routingContext) -> pick model
3. applyModelSelection() -> check availability, set active model
4. model = currentSequenceModel (sticky for subsequent turns)
```

The existing `ClassifierStrategy` already does LLM-based model selection, but
it's a **separate LLM call** (a classifier, not the main agent). Our approach is
different: the **main agent itself** recommends the next model as part of its
turn output, costing zero extra LLM calls.

---

## 3. The Routing Matrix

Below is the recommended task-to-model mapping, compiled from public benchmarks
(LMSYS Chatbot Arena, SWE-bench, Aider polyglot, MMLU-Pro, HumanEval). This is a
**fixed matrix** -- it doesn't need per-user calibration, but can be overridden
via config.

### Model Tiers

| Tier         | Concrete Models (current Gemini lineup)          | Cost Ratio | Strengths                                      |
| ------------ | ------------------------------------------------ | ---------- | ---------------------------------------------- |
| `flash-lite` | `gemini-3.1-flash-lite`, `gemini-2.0-flash-lite` | 0.1x       | Fast, cheap, good at extraction/classification |
| `flash`      | `gemini-3-flash-preview`, `gemini-2.5-flash`     | 1x         | General-purpose, good at code, fast            |
| `pro`        | `gemini-2.5-pro`, `gemini-3.1-pro-preview`       | 3-5x       | Strong reasoning, excellent at code edits      |
| `preview`    | `gemini-3-pro-preview`                           | 5-10x      | Best reasoning, architecture, complex planning |

### Task Domain Definitions

| Domain                  | Description                                                             | Recommended Tier | Rationale                                        |
| ----------------------- | ----------------------------------------------------------------------- | ---------------- | ------------------------------------------------ |
| **summarization**       | File summaries, grep output condensing, tool output compression         | `flash-lite`     | Extraction-only, no reasoning needed             |
| **context-compression** | Chat history distillation (already done by `chatCompressionService.ts`) | `flash-lite`     | Current behavior, already cheap                  |
| **investigation**       | grep, glob, file reads, git status, ls, codebase exploration            | `flash`          | Fast, good enough for search/read                |
| **simple-edit**         | Single-file edits, known pattern replacements                           | `flash`          | Low complexity, cheap                            |
| **question**            | "How does X work?", "What does this function do?"                       | `flash`          | Explanation, not mutation                        |
| **code-gen**            | Multi-file edits, new feature implementation, refactoring               | `pro`            | Needs strong reasoning and precision             |
| **debugging**           | Test failures, bug reproduction, root cause analysis                    | `pro`            | Needs multi-step reasoning                       |
| **planning**            | Architecture design, plan mode, complex strategy                        | `preview`        | Highest reasoning requirement                    |
| **docs**                | Writing markdown, READMEs, comments, documentation                      | `flash`          | LLMs are universally good at prose               |
| **test-writing**        | Writing unit tests, integration tests                                   | `pro`            | Edge cases matter, cheaper than planning         |
| **orchestration**       | Deciding next steps, routing, delegation to sub-agents                  | `flash`          | Simple classification, not complex reasoning     |
| **new-app**             | Scaffolding new applications from scratch                               | `preview`        | Design decisions, framework choice, architecture |
| **review**              | Code review, PR review, change analysis                                 | `pro`            | Needs understanding of full context              |

### The Matrix as Config

```typescript
// New addition to defaultModelConfigs.ts or a separate routing config
taskRoutingMatrix: {
  summarization:       { tier: 'flash-lite', cost: 0.1 },
  'context-compression': { tier: 'flash-lite', cost: 0.1 },
  investigation:      { tier: 'flash',       cost: 1   },
  'simple-edit':      { tier: 'flash',       cost: 1   },
  question:           { tier: 'flash',       cost: 1   },
  docs:               { tier: 'flash',       cost: 1   },
  orchestration:      { tier: 'flash',       cost: 1   },
  'code-gen':         { tier: 'pro',         cost: 3   },
  debugging:          { tier: 'pro',         cost: 3   },
  'test-writing':     { tier: 'pro',         cost: 3   },
  review:             { tier: 'pro',         cost: 3   },
  planning:           { tier: 'preview',     cost: 5   },
  'new-app':          { tier: 'preview',     cost: 5   },
}
```

This is a **guide** for the model, not a hard constraint. The model can still
recommend any tier, but the matrix helps it make informed decisions.

---

## 4. The `recommend_model` Tool

The model will call this tool at the end of its turn to suggest the model for
the **next** turn.

### Tool Definition

```typescript
export const RECOMMEND_MODEL_TOOL_NAME = 'recommend_model';

// Tool declaration (sent to the model API alongside other tools)
{
  name: RECOMMEND_MODEL_TOOL_NAME,
  description: `Recommend which model should handle the NEXT turn, based on what you plan to do next.

The recommended model will be used for the next LLM call. This lets you optimize:
- Use cheaper models (flash-lite, flash) for simple tasks
- Use more capable models (pro, preview) for complex reasoning or code changes

Rules:
- Default is the current model -- only call this if you need to CHANGE the model
- Be honest about complexity: over-escalating wastes money, under-escalating causes extra turns
- Consider the task domains from the routing matrix`,
  parameters: {
    type: 'object',
    properties: {
      model: {
        type: 'string',
        enum: ['flash-lite', 'flash', 'pro', 'preview'],
        description: 'The model tier for the next turn',
      },
      domain: {
        type: 'string',
        enum: [
          'summarization', 'context-compression', 'investigation',
          'simple-edit', 'question', 'code-gen', 'debugging',
          'planning', 'docs', 'test-writing', 'orchestration', 'new-app', 'review',
        ],
        description: 'The primary task domain for the next turn',
      },
      rationale: {
        type: 'string',
        description: 'Brief explanation of why this model is appropriate',
        maxLength: 200,
      },
    },
    required: ['model', 'domain', 'rationale'],
  },
}
```

### Tool Registration

Add to `TOOL_NAMES` in `tool-names.ts`:

```typescript
export const RECOMMEND_MODEL_TOOL_NAME = 'recommend_model';

export const ALL_BUILTIN_TOOL_NAMES = [
  // ... existing tools
  RECOMMEND_MODEL_TOOL_NAME,
] as const;
```

Add to `PLAN_MODE_TOOLS` if allowed during planning.

---

## 5. System Prompt Changes

### New Section in `snippets.ts`

Add a `renderModelRecommendation()` render function and include it in the
`getCoreSystemPrompt()` composition.

```typescript
// In the SystemPromptOptions interface
export interface SystemPromptOptions {
  // ...existing fields
  modelRecommendation?: boolean; // enabled by default
}

// In getCoreSystemPrompt()
export function getCoreSystemPrompt(options: SystemPromptOptions): string {
  return `
${renderPreamble(options.preamble)}
${renderCoreMandates(options.coreMandates)}
// ...existing sections...
${renderModelRecommendation(options.modelRecommendation)}
// ...remaining sections...
`.trim();
}
```

### The Render Function

```typescript
export function renderModelRecommendation(enabled?: boolean): string {
  if (!enabled) return '';
  return `
# Model Self-Selection

You can recommend which model handles the NEXT turn by calling the \`recommend_model\` tool.

## Why This Matters
Different models have different costs and capabilities. By choosing wisely, you:
- Save money on simple tasks (reads, searches, simple questions -> flash or flash-lite)
- Get better results on complex tasks (refactoring, debugging, architecture -> pro or preview)
- Avoid wasting tokens on unnecessary model power

## How to Decide
You have full context of what you just did and what you plan to do next. Consider:

### Use cheaper models (flash-lite, flash) when:
- Reading files or searching code
- Running shell commands to investigate
- Answering straightforward questions
- Summarizing content or tool output
- Writing documentation or comments
- Deciding next steps (orchestration is cheap)
- Making simple, known-pattern edits

### Use more capable models (pro, preview) when:
- Multi-file editing or refactoring
- Debugging test failures or complex bugs
- Writing tests with thorough edge-case coverage
- Designing architecture or planning
- Building new applications from scratch
- Code review with deep understanding required

### When in doubt:
- If the task is complex or risky -> escalate (cost of a wrong turn is higher than the model price)
- If the task is straightforward -> stay cheap (the model is good enough)
- You can always change the model again next turn

## Important
- Only call \`recommend_model\` if you want to CHANGE the model. If the current model is fine, do nothing.
- The recommendation is for the NEXT turn only. The system may override your choice based on availability.
- You cannot recommend a model for the current turn -- only for future turns.
`.trim();
}
```

### Section Control

Add the `GEMINI_PROMPT_MODEL_RECOMMENDATION` env var toggle (default enabled).

```typescript
// In PromptProvider
modelRecommendation: this.withSection(
  'modelRecommendation',
  () => true,
  !isPlanMode, // disable in plan mode where we want the best model always
),
```

---

## 6. Architecture Changes

### 6.1 New Strategy: `AgentRecommendationStrategy`

Add to `routing/strategies/agentRecommendationStrategy.ts`.

```typescript
export class AgentRecommendationStrategy implements RoutingStrategy {
  readonly name = 'agent-recommendation';

  async route(
    context: RoutingContext,
    config: Config,
  ): Promise<RoutingDecision | null> {
    // Check if the last model response included a recommend_model tool call
    const lastHistoryEntry = context.history[context.history.length - 1];
    const recommendation = extractRecommendation(lastHistoryEntry);

    if (!recommendation) return null; // decline, let next strategy decide

    // Resolve the recommended tier to a concrete model
    const concreteModel = resolveModelFromTier(recommendation.model, config);

    // Check if the model is available
    if (!isModelAvailable(concreteModel, config)) {
      return null; // unavailable, fall through
    }

    return {
      model: concreteModel,
      metadata: {
        source: 'agent-recommendation',
        latencyMs: 0,
        reasoning: `Agent recommended ${recommendation.model} for ${recommendation.domain}: ${recommendation.rationale}`,
      },
    };
  }
}
```

### 6.2 Register Strategy in `ModelRouterService`

```typescript
// In initializeDefaultStrategy(), add before the terminal strategy:
strategies.push(new AgentRecommendationStrategy());
```

The strategy order matters:

1. `FallbackStrategy` -- availability override
2. `OverrideStrategy` -- user-forced override
3. `ApprovalModeStrategy` -- plan/auto/yolo mode
4. `AgentRecommendationStrategy` -- **new**: model self-selection
5. `GemmaClassifierStrategy` -- on-device classifier
6. `ClassifierStrategy` -- LLM classifier fallback
7. `DefaultStrategy` -- terminal: always returns a model

### 6.3 Change Sticky Model Logic in `client.ts`

Currently the model is sticky for the entire sequence:

```typescript
if (this.currentSequenceModel) {
  modelToUse = this.currentSequenceModel; // always sticky
}
```

Change to:

```typescript
if (this.currentSequenceModel && !this.pendingModelRecommendation) {
  modelToUse = this.currentSequenceModel;
} else if (this.pendingModelRecommendation) {
  // Router will use the agent's recommendation
  modelToUse = undefined; // force re-routing
  this.pendingModelRecommendation = undefined; // consume
}
```

Where `pendingModelRecommendation` is set when the agent calls `recommend_model`
during its turn execution.

### 6.4 Tool Call Interception in Scheduler

The `Scheduler` already handles tool execution. Add handling for
`recommend_model`:

```typescript
// In scheduler.ts, _execute method or tool routing switch
if (toolCall.name === RECOMMEND_MODEL_TOOL_NAME) {
  // Don't actually execute anything -- store the recommendation
  const { model, domain, rationale } = toolCall.args;
  this.pendingRecommendation = { model, domain, rationale };
  return { type: 'recommendation', ... };
}
```

Then in `client.ts`, after the turn completes and before the next turn, if
`pendingRecommendation` is set, clear `currentSequenceModel` and let the router
pick the recommended model.

### 6.5 Compression Prompt Update

Add `<model_history>` to the state snapshot to preserve routing decisions:

```xml
<state_snapshot>
    <overall_goal>...</overall_goal>
    <!-- ...existing fields... -->
    <model_history>
        <!-- Track which models were used for which phases -->
        <!-- Example:
         - Turn 1-3: flash (investigation)
         - Turn 4-7: pro (implementation)
         - Turn 8: flash-lite (compression)
        -->
    </model_history>
</state_snapshot>
```

---

## 7. Changes by File

| File                                                | Change                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `prompts/snippets.ts`                               | Add `renderModelRecommendation()`, add to `SystemPromptOptions` and `getCoreSystemPrompt()` |
| `prompts/promptProvider.ts`                         | Wire `modelRecommendation` section, pass it in options                                      |
| `routing/strategies/agentRecommendationStrategy.ts` | **New file**: strategy that reads `recommend_model` tool call from last history entry       |
| `routing/modelRouterService.ts`                     | Register `AgentRecommendationStrategy` in `initializeDefaultStrategy()`                     |
| `routing/strategy.ts`                               | Add `domain` field to `RoutingDecision`? (optional)                                         |
| `tools/tool-names.ts`                               | Add `RECOMMEND_MODEL_TOOL_NAME` constant                                                    |
| `tools/definitions/coreTools.ts`                    | Add `recommend_model` tool definition                                                       |
| `tools/registerBuiltinTools.ts`                     | Register the tool in the tool registry                                                      |
| `scheduler/scheduler.ts`                            | Intercept `recommend_model` calls, store recommendation                                     |
| `core/client.ts`                                    | Respect pending recommendation, clear sticky model when recommendation exists               |
| `config/defaultModelConfigs.ts`                     | Add `taskRoutingMatrix`                                                                     |
| `prompts/snippets.legacy.ts`                        | Add minimal version for legacy models? (Optional -- legacy models can skip)                 |
| `core/prompts.ts`                                   | No change needed (already delegates to PromptProvider)                                      |

---

## 8. Implementation Plan (Phased)

### Phase 1: Foundation (Minimal)

**Goal**: Get model recommendation working with 2 tiers (flash/pro), no domain
tracking.

- Add `RECOMMEND_MODEL_TOOL_NAME` to tool-names
- Add the tool definition to coreTools
- Add `renderModelRecommendation()` to snippets.ts
- Wire the section in PromptProvider
- Register in Schedule tool registry
- Add `AgentRecommendationStrategy` that reads the tool call from history
- Register strategy in ModelRouterService

**Estimated effort**: ~2 days **Testable**: Yes -- model calls
`recommend_model`, next turn uses the recommended model

### Phase 2: Full Matrix

**Goal**: All 4 tiers + domain tracking + compression prompt update.

- Add `taskRoutingMatrix` to defaultModelConfigs
- Add domain field to the tool definition
- Add domain context to the recommendation strategy (use the matrix to validate)
- Update compression prompt to preserve model history
- Add `flash-lite` and `preview` tier support to the recommendation strategy

**Estimated effort**: ~2 days

### Phase 3: Safety and Guardrails

**Goal**: Prevent the model from making bad routing decisions.

- Escalation guard: if the model on `flash` hasn't made progress in 3+ turns,
  auto-escalate to `pro`
- Downgrade guard: only allow downgrade if the current turn didn't use mutation
  tools (edit, write, shell). Prevents a model from downgrading itself right
  before writing code.
- Loop detection: if the model keeps switching models every turn without
  progress, detect and pin to current model
- User override: `GEMINI_DISABLE_MODEL_ROUTING=1` to disable entirely
- Minimum turn count: don't allow model switch in first 2 turns (let the model
  "warm up")
- **Default disabled**: Feature is opt-in. User must explicitly enable it before
  `recommend_model` tool is registered or the prompt section is rendered.

**Estimated effort**: ~2 days

### Phase 4: Observability

**Goal**: Track routing decisions, measure cost savings, find bad
recommendations.

- Emit telemetry events for each `recommend_model` call (model, domain,
  rationale)
- Track token cost per model per session
- Track correction turns (turns needed after a downgrade that should have been
  an escalation)
- Add a `--routing-stats` CLI flag to display session routing summary

**Estimated effort**: ~1 day

### Phase 5: CLI Config Commands & Config TUI

**Goal**: User-facing controls to enable/disable model routing and view routing
stats.

- **CLI command**: `gemini model-routing enable|disable|status` -- toggles the
  feature at the config level. Maps to the same underlying flag as
  `GEMINI_DISABLE_MODEL_ROUTING`.
- **Config TUI**: Add a "Model Routing" toggle in the interactive config TUI
  (`config.tsx` or equivalent). Clearly labeled with description of what it does
  and cost implications.
- **Default disabled**: Both the CLI command and config TUI start with the
  feature off. No routing-related code runs until user explicitly enables it.
  The `recommend_model` tool is not registered, the prompt section is not
  rendered, and `AgentRecommendationStrategy` is not added to the router chain.
- **Status command**: `gemini model-routing status` shows:
  - enabled/disabled
  - current session routing stats (if any): how many times model switched,
    estimated cost delta vs single-model
- **Config file**: `modelRouting.enabled: true|false` in `.gemini/config.yaml`

**Implementation details**: | Component | What | |---|---| |
`cli/commands/model-routing.ts` | **New**: yargs CommandModule with `enable`,
`disable`, `status` subcommands | | `cli/commands/model-routing/enable.ts` |
**New**: Sets `modelRouting.enabled = true` | |
`cli/commands/model-routing/disable.ts` | **New**: Sets
`modelRouting.enabled = false` | | `cli/commands/model-routing/status.ts` |
**New**: Prints current state + session stats | | `cli/config.tsx` |
**Modified**: Add "Model Routing" toggle to config TUI | | `config/config.ts` |
**Modified**: Add `isModelRoutingEnabled()` getter, checked by PromptProvider
and ModelRouterService | | `prompts/promptProvider.ts` | **Modified**: Guard
`modelRecommendation` section behind `config.isModelRoutingEnabled()` | |
`routing/modelRouterService.ts` | **Modified**: Only register
`AgentRecommendationStrategy` when enabled |

**Estimated effort**: ~2 days

---

## 9. Example Session Flow

```
Turn 1:
  User: "Can you look at this bug in src/parser.ts?"
  Model (flash, default): Reads files, greps for related code
  -> recommend_model(model: "pro", domain: "debugging", rationale: "Found the issue,
     need to implement fix with multi-file changes")

Turn 2:
  Model (pro): Edits src/parser.ts, adds test, runs tests
  -> confirm everything passes
  -> recommend_model(model: "flash", domain: "investigation", rationale: "Fix verified,
     next step is to check if any other files reference the changed function")

Turn 3:
  Model (flash): Greps for references, confirms no other changes needed
  -> no recommendation (stays on flash)

Cost comparison vs single-model session:
- Single pro: 3 turns x pro price = 15 units
- Single flash: 3 turns x flash price = 3 units (but might fail on the refactor)
- Routed: flash + pro + flash = 0.3 + 1.5 + 0.3 = 2.1 units + better result
```

---

## 10. Risks and Mitigations

| Risk                                                             | Mitigation                                                                                    |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Model recommends itself (stays on cheap when it should escalate) | Escalation guard: auto-escalate after N failed turns or error rate > threshold                |
| Model ping-pongs between models                                  | Minimum turn count before switching allowed; loop detection                                   |
| Over-escalation (wasteful)                                       | Cheaper than under-escalation (extra turns). Track correction turns metric to detect patterns |
| Compression loses routing state                                  | Add `<model_history>` to state snapshot                                                       |
| User confused by model changes                                   | Surface model changes in CLI output: `[Model: flash -> pro (debugging)]`                      |
| Tool doesn't fire (model doesn't call it)                        | Fallback: if no recommendation, keep current model (no regression)                            |
| Legacy models can't use the tool                                 | Disable the section for legacy models via `isModernModel` check                               |
| Latency of strategy chain                                        | AgentRecommendationStrategy is near-instant (reads from history, no LLM call)                 |

---

## 11. Summary

| Aspect              | Current                       | After Upgrade                                                                                                        |
| ------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Model selection     | Single model per session      | Per-turn, model-recommended                                                                                          |
| Routing mechanism   | Fallback chains + classifiers | + Agent self-recommendation                                                                                          |
| Cost optimization   | None (best model always)      | Cheaper models for simple tasks                                                                                      |
| Task specialization | None                          | Domain-aware routing                                                                                                 |
| Extra LLM calls     | 0 (classifier is optional)    | 0 (recommendation is free, embedded in turn output)                                                                  |
| User control        | `--model` flag                | + `GEMINI_DISABLE_MODEL_ROUTING=1` + `gemini model-routing enable\|disable\|status` CLI commands + Config TUI toggle |
| Default state       | Always on                     | **Disabled**. Must opt in.                                                                                           |
