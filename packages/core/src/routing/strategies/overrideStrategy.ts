/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Harry Dau - 2026
 */

import type { Config } from '../../config/config.js';
import { isAutoModel, resolveModel } from '../../config/models.js';
import type { BaseLlmClient } from '../../core/baseLlmClient.js';
import type {
  RoutingContext,
  RoutingDecision,
  RoutingStrategy,
} from '../routingStrategy.js';
import type { LocalLiteRtLmClient } from '../../core/localLiteRtLmClient.js';

/**
 * Handles cases where the user explicitly specifies a model (override).
 */
export class OverrideStrategy implements RoutingStrategy {
  readonly name = 'override';

  async route(
    context: RoutingContext,
    config: Config,
    _baseLlmClient: BaseLlmClient,
    _localLiteRtLmClient: LocalLiteRtLmClient,
  ): Promise<RoutingDecision | null> {
    const overrideModel = context.requestedModel ?? config.getModel();

    // If the model is 'auto' we should pass to the next strategy.
    if (isAutoModel(overrideModel, config)) {
      return null;
    }

    const resolvedModel = resolveModel(
      overrideModel,
      config.getGemini31LaunchedSync?.() ?? false,
      false,
      config.getHasAccessToPreviewModel?.() ?? true,
      config,
      config.hasLatestFlashGAAccess?.() ?? false,
      config.hasLatestFlashLiteGAAccess?.() ?? false,
    );
    const modelDef = config
      .getModelConfigService()
      .getModelDefinition(resolvedModel);
    return {
      model: resolvedModel,
      provider: modelDef?.provider ?? 'gemini',
      baseUrl: modelDef?.baseUrl,
      metadata: {
        source: this.name,
        latencyMs: 0,
        reasoning: `Routing bypassed by forced model directive. Using: ${overrideModel}`,
      },
    };
  }
}
