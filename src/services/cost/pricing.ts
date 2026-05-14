/**
 * 静态模型价格表与 usage → USD 估算。
 *
 * 对齐 claude-code/src/utils/modelCost.ts 的核心形态：按模型档位保存
 * input/output/cache read/cache write 的每百万 token 美元单价，再用 SDK usage
 * 中的 4 个 token 字段计算本次调用的估算费用。
 *
 * 注意：价格是 M5 的内置快照。Anthropic 官方价格可能变化；后续 M12 多 provider
 * 阶段再把它抽成可配置 provider pricing。
 */

import type { ApiUsage } from "../../types/message.ts";

/** 每百万 token 的美元单价。 */
export interface ModelPricing {
  readonly inputTokensPerMtok: number;
  readonly outputTokensPerMtok: number;
  readonly cacheCreationInputTokensPerMtok: number;
  readonly cacheReadInputTokensPerMtok: number;
}

/** pricing 查找结果。unknown model 会回退到 Sonnet 4.x 档位并打标。 */
export interface ModelPricingLookup {
  readonly canonicalName: string;
  readonly pricing: ModelPricing;
  readonly usedFallback: boolean;
}

/** 单次 usage 的费用估算。 */
export interface UsageCostEstimate {
  readonly costUsd: number;
  readonly pricing: ModelPricing;
  readonly pricingModel: string;
  readonly usedFallback: boolean;
}

/** Sonnet 4.x：$3 input / $15 output / $3.75 cache write / $0.30 cache read。 */
export const COST_TIER_3_15: ModelPricing = {
  inputTokensPerMtok: 3,
  outputTokensPerMtok: 15,
  cacheCreationInputTokensPerMtok: 3.75,
  cacheReadInputTokensPerMtok: 0.3,
};

/** Opus 4 / 4.1：$15 input / $75 output / $18.75 cache write / $1.50 cache read。 */
export const COST_TIER_15_75: ModelPricing = {
  inputTokensPerMtok: 15,
  outputTokensPerMtok: 75,
  cacheCreationInputTokensPerMtok: 18.75,
  cacheReadInputTokensPerMtok: 1.5,
};

/** Opus 4.5+：$5 input / $25 output / $6.25 cache write / $0.50 cache read。 */
export const COST_TIER_5_25: ModelPricing = {
  inputTokensPerMtok: 5,
  outputTokensPerMtok: 25,
  cacheCreationInputTokensPerMtok: 6.25,
  cacheReadInputTokensPerMtok: 0.5,
};

/** Haiku 3.5：$0.80 input / $4 output / $1 cache write / $0.08 cache read。 */
export const COST_HAIKU_35: ModelPricing = {
  inputTokensPerMtok: 0.8,
  outputTokensPerMtok: 4,
  cacheCreationInputTokensPerMtok: 1,
  cacheReadInputTokensPerMtok: 0.08,
};

/** Haiku 4.5：$1 input / $5 output / $1.25 cache write / $0.10 cache read。 */
export const COST_HAIKU_45: ModelPricing = {
  inputTokensPerMtok: 1,
  outputTokensPerMtok: 5,
  cacheCreationInputTokensPerMtok: 1.25,
  cacheReadInputTokensPerMtok: 0.1,
};

const FALLBACK_PRICING_MODEL = "claude-sonnet-4.x";

interface PricingRule {
  readonly canonicalName: string;
  readonly needles: readonly string[];
  readonly pricing: ModelPricing;
}

const PRICING_RULES: readonly PricingRule[] = [
  {
    canonicalName: "claude-opus-4.7",
    needles: ["opus-4-7", "opus-4.7"],
    pricing: COST_TIER_5_25,
  },
  {
    canonicalName: "claude-opus-4.6",
    needles: ["opus-4-6", "opus-4.6"],
    pricing: COST_TIER_5_25,
  },
  {
    canonicalName: "claude-opus-4.5",
    needles: ["opus-4-5", "opus-4.5"],
    pricing: COST_TIER_5_25,
  },
  {
    canonicalName: "claude-opus-4.1",
    needles: ["opus-4-1", "opus-4.1"],
    pricing: COST_TIER_15_75,
  },
  {
    canonicalName: "claude-opus-4",
    needles: ["opus-4"],
    pricing: COST_TIER_15_75,
  },
  {
    canonicalName: "claude-sonnet-4.x",
    needles: ["sonnet-4-6", "sonnet-4.6", "sonnet-4-5", "sonnet-4.5", "sonnet-4"],
    pricing: COST_TIER_3_15,
  },
  {
    canonicalName: "claude-3.7-sonnet",
    needles: ["3-7-sonnet", "3.7-sonnet", "sonnet-3-7", "sonnet-3.7"],
    pricing: COST_TIER_3_15,
  },
  {
    canonicalName: "claude-3.5-sonnet",
    needles: ["3-5-sonnet", "3.5-sonnet", "sonnet-3-5", "sonnet-3.5"],
    pricing: COST_TIER_3_15,
  },
  {
    canonicalName: "claude-haiku-4.5",
    needles: ["haiku-4-5", "haiku-4.5"],
    pricing: COST_HAIKU_45,
  },
  {
    canonicalName: "claude-3.5-haiku",
    needles: ["3-5-haiku", "3.5-haiku", "haiku-3-5", "haiku-3.5"],
    pricing: COST_HAIKU_35,
  },
];

/** 根据模型名选择价格档位；支持带日期后缀的 Anthropic model id。 */
export function getModelPricing(model: string): ModelPricingLookup {
  const normalized = model.toLowerCase();
  for (const rule of PRICING_RULES) {
    if (rule.needles.some((needle) => normalized.includes(needle))) {
      return {
        canonicalName: rule.canonicalName,
        pricing: rule.pricing,
        usedFallback: false,
      };
    }
  }
  return {
    canonicalName: FALLBACK_PRICING_MODEL,
    pricing: COST_TIER_3_15,
    usedFallback: true,
  };
}

/** 按 Anthropic usage 字段计算本次调用的 USD 估算费用。 */
export function calculateUsageCostUsd(params: {
  readonly model: string;
  readonly usage: ApiUsage;
}): UsageCostEstimate {
  const lookup = getModelPricing(params.model);
  const usage = params.usage;
  const pricing = lookup.pricing;
  const costUsd =
    (usage.input_tokens / 1_000_000) * pricing.inputTokensPerMtok +
    (usage.output_tokens / 1_000_000) * pricing.outputTokensPerMtok +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      pricing.cacheCreationInputTokensPerMtok +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * pricing.cacheReadInputTokensPerMtok;

  return {
    costUsd,
    pricing,
    pricingModel: lookup.canonicalName,
    usedFallback: lookup.usedFallback,
  };
}
