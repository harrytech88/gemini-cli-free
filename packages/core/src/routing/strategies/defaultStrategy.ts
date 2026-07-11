/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Harry Dau - 2026
 */

import type { Config } from '../../config/config.js';
import type { BaseLlmClient } from '../../core/baseLlmClient.js';
import type {
  RoutingContext,
  RoutingDecision,
  TerminalStrategy,
} from '../routingStrategy.js';
import { resolveModel } from '../../config/models.js';
import type { LocalLiteRtLmClient } from '../../core/localLiteRtLmClient.js';

export class DefaultStrategy implements TerminalStrategy {
  readonly name = 'default';

  async route(
    _context: RoutingContext,
    config: Config,
    _baseLlmClient: BaseLlmClient,
    _localLiteRtLmClient: LocalLiteRtLmClient,
  ): Promise<RoutingDecision> {
    const defaultModel = resolveModel(
      config.getModel(),
      config.getGemini31LaunchedSync?.() ?? false,
      false,
      config.getHasAccessToPreviewModel?.() ?? true,
      config,
      config.hasLatestFlashGAAccess?.() ?? false,
      config.hasLatestFlashLiteGAAccess?.() ?? false,
    );
    const modelDef = config
      .getModelConfigService()
      .getModelDefinition(defaultModel);
    return {
      model: defaultModel,
      provider: modelDef?.provider ?? 'gemini',
      baseUrl: modelDef?.baseUrl,
      metadata: {
        source: this.name,
        latencyMs: 0,
        reasoning: `Routing to default model: ${defaultModel}`,
      },
    };
  }
}
