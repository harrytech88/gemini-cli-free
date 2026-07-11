# Federated Pattern Genome

## 1. Concept

A **federated pattern genome** is a structural fingerprint of a codebase's
architecture, dependencies, and known issues. It enables:

- **Cross-project pattern detection** -- "This codebase has a similar dependency
  graph to Project X, which had a deadlock bug last week. Proactively check
  these 3 files."
- **Privacy-preserving knowledge sharing** -- no source code leaves the
  boundary, only structural hashes and anonymized issue fingerprints
- **Institutional memory** -- the agent remembers every bug it fixed across all
  projects, not just via static `GEMINI.md` files
- **Evolvable warnings** -- as more projects join the federation, pattern
  matches become more precise

The key insight: source code is the _expression_; the genome is the _anatomy_.
Two codebases can share the same anatomy without sharing a single line of code.

---

## 2. What a DNA Fingerprint Is

A DNA fingerprint is a **deterministic structural signature** extracted from
code. It must be:

- **Deterministic** -- same code always produces the same fingerprint
- **Local** -- fingerprints exist at file, module, and project granularity
- **One-way** -- cannot be reversed into source code
- **Similarity-searchable** -- similar structures produce similar fingerprints
- **Small** -- a few KB per project, easily storable and transmittable

### Anatomy of a Fingerprint

```json
{
  "schemaVersion": 1,
  "projectId": "sha256(origin_url + root_commit_hash)", // anonymous, stable
  "fingerprintedAt": "2026-07-10T12:00:00Z",

  // --- Dependency Graph ---
  "dependencyFingerprint": {
    "directDeps": ["express", "react", "lodash"], // names only, no versions
    "dependencyGraphHash": "a1b2c3d4...", // hash of full dependency tree shape
    "entryPoints": ["src/index.ts", "src/app.tsx"]
  },

  // --- Module Anatomy ---
  "modules": [
    {
      "path": "src/services/api.ts",
      "structuralHash": "e5f6a7b8...", // hash of AST structure (imports, exports, class/function signatures)
      "fanOut": ["src/utils/http.ts", "src/types/api.ts"],
      "fanIn": ["src/components/UserList.tsx", "src/hooks/useUsers.ts"],
      "patterns": [
        {
          "type": "async-retry-circuit-breaker",
          "hash": "d9e0f1a2..."
        },
        {
          "type": "repository-pattern",
          "hash": "b3c4d5e6..."
        }
      ],
      "publicApiSignature": "sha256(exported_names + parameter_types)", // what the module exposes
      "errorClasses": ["ApiError", "RateLimitError", "AuthError"],
      "errorHandlingPattern": "error-boundary-wrapper"
    }
  ],

  // --- Architectural Patterns (Cross-Module) ---
  "architecture": {
    "layers": ["presentation", "application", "domain", "infrastructure"],
    "layerViolations": [], // detected circular or inverted dependencies
    "patternInstances": [
      {
        "pattern": "three-tier-rest-api",
        "confidence": 0.92,
        "modules": ["src/controllers/", "src/services/", "src/repositories/"]
      }
    ]
  },

  // --- Issue History (Anonymized) ---
  "issues": [
    {
      "issueType": "deadlock",
      "patternHash": "a1b2c3d4...", // which pattern was involved
      "rootCauseModule": "src/services/api.ts", // local path, not absolute
      "fixSignature": "sha256(files_touched + dependency_delta)", // what changed to fix it
      "fixCategory": "added-timeout-to-retry",
      "severity": "critical",
      "occurredAt": "2026-07-08T14:30:00Z"
    }
  ]
}
```

### How Fingerprints Are Generated

The agent already has all the context needed. After every session:

```typescript
// After session ends, the memoryService (already at memoryService.ts)
// runs background extraction. We add a new extractor step.

class GenomeExtractor {
  async extractFingerprint(
    session: SessionRecord,
  ): Promise<ProjectFingerprint> {
    // 1. Parse the project's dependency graph (package.json, Cargo.toml, etc.)
    const deps = await this.parseDependencies(projectRoot);

    // 2. Walk source files, extract AST-level structural hashes
    const modules = await this.walkSourceFiles(projectRoot);

    // 3. Detect architectural patterns
    const architecture = await this.detectPatterns(modules);

    // 4. Read compression snapshots for issue history
    const issues = await this.extractIssuesFromSessions(session);

    // 5. Hash everything together
    return this.assembleFingerprint(deps, modules, architecture, issues);
  }
}
```

The compression prompt already produces `<state_snapshot>` with
`<artifact_trail>` and `<key_knowledge>`. We add a `<dna_fingerprint>` block
that captures the structural deltas from the session.

---

## 3. Pattern Detection

Pattern detection is done by the **model itself** -- no separate ML pipeline
needed. The system prompt gets a new section:

```
## Pattern Detection
After every bug fix or significant code change, analyze the structural pattern:
- What architectural pattern was involved? (e.g. "circuit-breaker", "repository", "event-bus")
- What was the root cause category? (e.g. "race-condition", "missing-timeout", "improper-error-handling")
- What modules were affected?
- What was the fix signature (not the code, the structural delta)?

Output your analysis in <dna_analysis> tags. This will be used to build a
knowledge base that protects other projects from the same issue.
```

The model doesn't need to be trained specifically for this -- it already
understands architectural patterns. You're just asking it to _annotate_ its own
work.

### Pattern Library (Seed)

A starter catalog of known patterns the model can classify against:

| Pattern                       | Signature                                                 | Known Issue                                            |
| ----------------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| `async-retry-circuit-breaker` | nested try-catch with exponential backoff + state machine | Missing timeout on inner retry causes unbounded wait   |
| `repository-pattern`          | data access abstraction layer                             | Leaking transaction scope across repositories          |
| `event-bus-pub-sub`           | emitter/listener decoupling                               | Listener ordering race condition on async emit         |
| `middleware-chain`            | sequential request processors                             | Middleware mutating shared state causes side effects   |
| `three-tier-rest-api`         | controller -> service -> repository                       | Circular dependency between layers via DTOs            |
| `dependency-injection-graph`  | constructor-injected services                             | Singleton scoping causes cross-request state pollution |
| `state-machine`               | explicit states + transitions                             | Missing transition handler causes silent no-op         |
| `observer-reactive`           | observable -> subscriber push model                       | Unsubscription leak causes memory growth               |

These are seeded manually and grow as the federation contributes new pattern
discoveries.

---

## 4. The Hub Architecture

```
┌─────────────────────────┐     ┌─────────────────────────┐
│  Organization A         │     │  Organization B         │
│  ┌───────────────────┐  │     │  ┌───────────────────┐  │
│  │ Gemini CLI Agent  │  │     │  │ Gemini CLI Agent  │  │
│  │ ↓ DNA fingerprint │  │     │  │ ↓ DNA fingerprint │  │
│  │ ↓ Issue report    │  │     │  │ ↓ Issue report    │  │
│  └────────┬──────────┘  │     │  └────────┬──────────┘  │
└───────────┼─────────────┘     └───────────┼─────────────┘
            │                               │
            │  (GraphQL / gRPC, TLS,        │
            │   signed by org key)          │
            ▼                               ▼
     ┌──────────────────────────────────────────┐
     │           FEDERATION HUB                  │
     │                                           │
     │  ┌────────────┐  ┌────────────────────┐   │
     │  │ DNA Index  │  │ Match Engine        │   │
     │  │ (vector    │  │ (structural hash    │   │
     │  │  search)   │  │  + embedding sim)   │   │
     │  └────────────┘  └────────────────────┘   │
     │                                           │
     │  ┌────────────┐  ┌────────────────────┐   │
     │  │ Issue DB   │  │ Notification Queue  │   │
     │  │ (anonymized│  │ (outbound webhooks  │   │
     │  │  reports)  │  │  + polling API)     │   │
     │  └────────────┘  └────────────────────┘   │
     │                                           │
     │  ┌────────────────────────────────────┐   │
     │  │ Policy / Access Control            │   │
     │  │ (per-org: allow/deny pattern types │   │
     │  │  + which patterns to subscribe to) │   │
     │  └────────────────────────────────────┘   │
     └──────────────────────────────────────────┘
```

### Submission Flow

1. Agent finishes a session with a bug fix
2. GenomeExtractor runs (background, like `memoryService.ts` extraction)
3. Extractor produces a `ProjectFingerprint` + `IssueReport`
4. CLI prompts user: "Submit an anonymous pattern report to the federation?
   [y/N]"
5. If yes: fingerprint is signed with organization key, sent via HTTPS
6. Hub validates signature, strips any identifying metadata, indexes by
   structural hash
7. Hub runs Match Engine against existing fingerprints
8. If match found: Hub checks if this is a new issue type for that pattern
9. Hub broadcasts advisory to all orgs with matching fingerprints: "Pattern
   async-retry-circuit-breaker (hash a1b2c3d4): 3 orgs reported deadlocks.
   Suggested audit: timeout configuration in retry wrappers."

### Advisory Flow

1. Organization starts a CLI session (or agent starts working)
2. Before the first model call, agent queries the Hub: "Here's my project
   fingerprint. Any active advisories for my patterns?"
3. Hub returns matching advisories
4. Agent injects advisories into the system prompt as `<federation_advisories>`
   context
5. The model sees: "WARNING: Your code uses pattern X which has known issue Y.
   Check files Z."

---

## 5. Security Model

| Concern                       | Solution                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No code leak**              | DNA fingerprints are one-way hashes. Pattern hashes are derived from AST structure, not source. Module paths are relative. Dep names only (no versions).                                                       |
| **No project identification** | `projectId` is `sha256(origin_url + root_commit)`. No metadata about the organization is stored on the Hub.                                                                                                    |
| **Submitter anonymity**       | Submissions are signed by org key, but the Hub strips the signature after validation and stores only an anonymous contributor ID.                                                                              |
| **Data poisoning**            | All submissions include a `confidence` score (how sure the agent is about the pattern match). Malicious submissions with low confidence are deprioritized. Humans can flag false positives.                    |
| **Opt-in per project**        | Default is off. User must run `genome enable` for the project. Global disable flag `GEMINI_GENOME_DISABLE=1`.                                                                                                  |
| **Hub trust**                 | Organizations pin the Hub's public key. The CLI validates all responses. Self-hosted Hub option for air-gapped environments.                                                                                   |
| **What is shared**            | Only: structural hashes, pattern type labels, error categories, relative module paths, fix category labels. Never: source code, file contents, variable names, string literals, configuration values, secrets. |

---

## 6. Integration with the Agent

### New Tool: `report_pattern_issue`

```typescript
{
  name: 'report_pattern_issue',
  description: 'Report a structural pattern issue discovered during this session. '
    'No source code is shared — only anonymous structural fingerprints.',
  parameters: {
    type: 'object',
    properties: {
      patternType: { type: 'string', enum: patternLibrary.keys() },
      rootCauseCategory: { type: 'string' },
      severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      affectedModules: { type: 'array', items: { type: 'string' } },
      fixCategory: { type: 'string' },
    },
    required: ['patternType', 'rootCauseCategory', 'severity', 'fixCategory'],
  },
}
```

The model calls this after completing a bug fix. The tool doesn't execute
immediately -- it queues the report for user review.

### New System Prompt Section

```
## Federation Advisories
The following advisories apply to your current codebase's structural patterns:

<federation_advisories>
  - Pattern "async-retry-circuit-breaker" (affects: src/services/api.ts, src/utils/retry.ts):
    Critical: 3 organizations reported deadlocks when inner retry lacks timeout.
    Recommended check: Review timeout configuration in retry wrappers.
    Report URL: https://hub/patterns/a1b2c3d4
</federation_advisories>

If an advisory matches code you are about to modify, proactively check
the affected pattern and warn the user before making changes.
```

### Compression Prompt Update

Add `<dna_fingerprint>` to the state snapshot:

```xml
<state_snapshot>
    <dna_fingerprint>
        <pattern_delta>
            - src/services/api.ts: modified retry logic (pattern: async-retry-circuit-breaker)
            - src/utils/retry.ts: added timeout parameter
        </pattern_delta>
        <issue_reported>
            Pattern: async-retry-circuit-breaker
            Fix: added timeout to inner retry
            Severity: critical
            Affects: any codebase with similar retry chains
        </issue_reported>
    </dna_fingerprint>
</state_snapshot>
```

### Session Lifecycle Integration

```
Startup:
  1. Load project fingerprint (from cache / regenerate if deps changed)
  2. Query Hub: "Any advisories for my fingerprint?"
  3. If yes -> inject into system prompt as <federation_advisories>
  4. Continue normal session

During session:
  5. Model works normally
  6. If model detects pattern + fixes it -> may call report_pattern_issue tool
  7. Tool queues the report

End of session (background):
  8. GenomeExtractor runs (part of memoryService background extraction)
  9. Extracts updated fingerprint from current codebase state
  10. If queued report exists -> prompt user to submit
  11. If user approves -> submit to Hub
  12. Cache new fingerprint locally

On schedule (cron / periodic):
  13. Re-fingerprint the project (deps may have changed)
  14. Re-query Hub with updated fingerprint
  15. New advisories appear in next session
```

---

## 7. Local Storage

Fingerprints are cached locally in `.gemini/genome/`:

```
.gemini/genome/
├── fingerprint.json              # Current project fingerprint
├── fingerprint-v1.json           # Previous version (for diffing)
├── fingerprint-v2.json           # ...keep last N
├── advisory-cache.json           # Last Hub query results (with TTL)
└── pending-reports/
    ├── 2026-07-10T12-00-00.json  # Queued issue reports awaiting user approval
    └── 2026-07-10T14-30-00.json
```

The fingerprint is regenerated only when the dependency graph changes or on
explicit request. This is cheap -- structural hashing is fast, and the agent
already reads all source files during its work.

---

## 8. Implementation Plan

### Phase 1: Local Fingerprinting (No Hub)

**Goal:** Generate and cache fingerprints locally. No network calls. Feature is
off by default.

| Component                           | What                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `genome/fingerprinter.ts`           | **New**: Walk project, extract deps, AST hashes, detect patterns              |
| `genome/patternDetector.ts`         | **New**: Classify modules into known pattern types                            |
| `genome/fingerprint.ts`             | **New**: Types (`ProjectFingerprint`, `ModuleFingerprint`, `PatternInstance`) |
| `genome/storage.ts`                 | **New**: Read/write `.gemini/genome/`                                         |
| `prompts/snippets.ts`               | Add `renderPatternDetection()` section (optional, user opt-in)                |
| `services/memoryService.ts`         | Add `GenomeExtractor` as another background extraction step                   |
| `context/chatCompressionService.ts` | Add `<dna_fingerprint>` to compression snapshot                               |

**CLI command scaffold (disabled by default):** | `cli/commands/genome.ts` |
**New**: yargs CommandModule with `enable`, `disable`, `status` subcommands | |
`cli/commands/genome/enable.ts` | **New**: Sets `genome.enabled = true` +
registers genome tools | | `cli/commands/genome/disable.ts` | **New**: Sets
`genome.enabled = false` | | `cli/commands/genome/status.ts` | **New**: Shows
enabled/disabled + fingerprint stats | | `config/config.ts` | **Modified**: Add
`isGenomeEnabled()` getter, defaults to `false` |

The genome extractor, fingerprint storage, and prompt section are all gated
behind `isGenomeEnabled()`. If disabled, none of the genome code runs -- zero
overhead.

**Estimated effort:** 5-6 days (includes scaffolded commands)

### Phase 2: Issue Reporting Tool

**Goal:** Model can report issues; user can review and approve. All gated behind
`isGenomeEnabled()`.

| Component                       | What                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| `tools/report-pattern-issue.ts` | **New**: Tool definition + handler (queues report, doesn't send)     |
| `tools/tool-names.ts`           | Add `REPORT_PATTERN_ISSUE_TOOL_NAME`                                 |
| `genome/issueReport.ts`         | **New**: Types + validation for issue reports                        |
| `genome/storage.ts`             | Add pending report queue management                                  |
| CLI UI                          | Prompt user to review/submit pending reports on session end          |
| `prompts/snippets.ts`           | Add `renderFederationAdvisories()` section (placeholder, no Hub yet) |

**Config TUI update:** Add "Pattern Genome" toggle to the interactive config TUI
(`config.tsx`). Clearly labeled with description of what it does and privacy
guarantees.

**Estimated effort:** 4-5 days (includes Config TUI toggle)

### Phase 3: Hub Server (Reference Implementation)

**Goal:** A simple hub that accepts reports and returns advisories.

| Component                  | What                                                                         |
| -------------------------- | ---------------------------------------------------------------------------- |
| `hub/` standalone service  | **New**: GraphQL API, could be a simple Cloudflare Worker or Go service      |
| `hub/matchEngine.ts`       | Structural hash matching + similarity scoring                                |
| `hub/dnaIndex.ts`          | Vector index (can use Postgres pgvector or sqlite with simple hash matching) |
| `hub/notificationQueue.ts` | Outbound webhooks + polling API                                              |
| `genome/hubClient.ts`      | **New**: CLI-side client for Hub API calls                                   |

**Estimated effort:** 5-7 days

### Phase 4: End-to-End Federation

**Goal:** Multiple organizations sharing pattern knowledge. Feature remains
disabled by default at every level.

| Component                                                                    | What                                                           |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `genome/hubClient.ts`                                                        | Sign submissions, validate Hub responses                       |
| `config/config.ts`                                                           | `genome.enabled`, `genome.hubUrl`, `genome.orgKey` config      |
| CLI: `genome enable/disable/status` commands (already scaffolded in Phase 1) | User-facing control, extended with hub config                  |
| CLI: `genome submit`                                                         | Manual fingerprint submission (only available when enabled)    |
| CLI auto-query                                                               | Session startup query + advisory injection (only when enabled) |
| CLI: `genome config`                                                         | Set `hubUrl` and `orgKey` for federation                       |
| Security audit                                                               | Ensure no code can leak through any path                       |

**Config TUI update (Phase 4):** Add "Hub URL" and "Organization Key" fields to
the genome section in config TUI, shown only when genome is enabled.

**Estimated effort:** 5-6 days

---

## 9. Risks and Mitigations

| Risk                                | Impact                                        | Mitigation                                                                                                          |
| ----------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **False pattern match**             | Wastes developer time checking wrong code     | `confidence` threshold; user can dismiss advisory for this project                                                  |
| **Hub becomes a liability target**  | Attacker learns which orgs use which patterns | Zero-trust design: Hub never knows the org identity. Self-host option.                                              |
| **Model misclassifies pattern**     | Wrong fingerprint submitted                   | Pattern detection is double-checked by the extractor (deterministic), not just the model                            |
| **No participation = no value**     | Cold start problem                            | Seed with ~50 known patterns + synthetic examples. Single org still benefits (local issue history across projects). |
| **Fingerprint drift**               | Code changes faster than fingerprint updates  | Re-fingerprint on git hook (`post-commit`, `post-merge`)                                                            |
| **Privacy regulation (GDPR, etc.)** | Users demand right to delete                  | Hub supports deletion by projectId. CLI can withdraw all submissions for a project.                                 |

---

## 10. Summary

| Aspect                        | Detail                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **What is shared**            | Structural hashes, pattern labels, error categories, fix categories. No source code.                           |
| **How patterns are detected** | By the model itself (prompt-driven) + deterministic extractor (post-session)                                   |
| **How matches work**          | Structural hash comparison + similarity scoring                                                                |
| **How users are warned**      | `<federation_advisories>` injected into system prompt on session start                                         |
| **How issues are reported**   | `report_pattern_issue` tool -> user review -> Hub submission                                                   |
| **Local storage**             | `.gemini/genome/` fingerprint cache + pending report queue                                                     |
| **Hub requirement**           | None initially (Phase 1-2 work fully offline). Hub adds cross-org value.                                       |
| **Default state**             | **Disabled**. Must opt in via `gemini genome enable` or Config TUI toggle.                                     |
| **Integration surface**       | 1 new tool + 1 new prompt section + 1 background extractor + CLI commands + Config TUI toggle + < 10 new files |
