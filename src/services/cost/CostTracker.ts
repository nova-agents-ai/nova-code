/**
 * 会话级 cost tracker。
 *
 * 对齐 claude-code/src/cost-tracker.ts 的最小核心：累计 input/output/cache read/
 * cache write token 与按模型拆分的 USD 估算。nova-code 暂不统计 duration、代码行数、
 * server-side web search；这些等 M10/M12 再接入。
 */

import type { ApiUsage } from "../../types/message.ts";
import { calculateUsageCostUsd } from "./pricing.ts";

/** 单模型累计 usage。 */
export interface CostModelUsage {
  readonly model: string;
  readonly pricingModel: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly costUsd: number;
  readonly usedFallbackPricing: boolean;
}

/** 某个命令 / 多个 ledger entry 的 cost 快照。 */
export interface CostSnapshot {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheReadInputTokens: number;
  readonly totalCacheCreationInputTokens: number;
  readonly totalCostUsd: number;
  readonly usedFallbackPricing: boolean;
  readonly models: readonly CostModelUsage[];
}

interface MutableCostModelUsage {
  model: string;
  pricingModel: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  usedFallbackPricing: boolean;
}

/** 累计当前进程内的一组 LLM usage。 */
export class CostTracker {
  private readonly usageByModel = new Map<string, MutableCostModelUsage>();

  /** 记录一次 Anthropic message.usage。 */
  recordUsage(model: string, usage: ApiUsage): void {
    const estimate = calculateUsageCostUsd({ model, usage });
    const current = this.getOrCreateUsage(model, estimate.pricingModel);
    current.inputTokens += usage.input_tokens;
    current.outputTokens += usage.output_tokens;
    current.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
    current.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
    current.costUsd += estimate.costUsd;
    current.usedFallbackPricing = current.usedFallbackPricing || estimate.usedFallback;
  }

  /** 是否已经累计过任何 token。 */
  hasUsage(): boolean {
    const snapshot = this.snapshot();
    return totalTokens(snapshot) > 0;
  }

  /** 返回不可变快照。 */
  snapshot(): CostSnapshot {
    return buildSnapshot([...this.usageByModel.values()].map(toCostModelUsage));
  }

  private getOrCreateUsage(model: string, pricingModel: string): MutableCostModelUsage {
    const current = this.usageByModel.get(model);
    if (current !== undefined) return current;
    const created: MutableCostModelUsage = {
      model,
      pricingModel,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
      usedFallbackPricing: false,
    };
    this.usageByModel.set(model, created);
    return created;
  }
}

/** 空快照，供 cost ledger 为空或命令无 usage 时使用。 */
export function createEmptyCostSnapshot(): CostSnapshot {
  return buildSnapshot([]);
}

/** 合并多份 CostSnapshot，主要给 `nova-code cost` 汇总历史 ledger。 */
export function mergeCostSnapshots(snapshots: readonly CostSnapshot[]): CostSnapshot {
  const byModel = new Map<string, MutableCostModelUsage>();
  for (const snapshot of snapshots) {
    for (const usage of snapshot.models) {
      const current = byModel.get(usage.model) ?? createMutableFromUsage(usage);
      if (!byModel.has(usage.model)) {
        byModel.set(usage.model, current);
        continue;
      }
      current.inputTokens += usage.inputTokens;
      current.outputTokens += usage.outputTokens;
      current.cacheReadInputTokens += usage.cacheReadInputTokens;
      current.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      current.costUsd += usage.costUsd;
      current.usedFallbackPricing = current.usedFallbackPricing || usage.usedFallbackPricing;
    }
  }
  return buildSnapshot([...byModel.values()].map(toCostModelUsage));
}

/** 人类可读的 cost 摘要；chat 退出与 cost 命令共用。 */
export function formatCostSummary(snapshot: CostSnapshot): string {
  const lines = [
    `Total cost:            ${formatUsd(snapshot.totalCostUsd)}${fallbackSuffix(snapshot)}`,
    `Usage:                 ${formatTokenUsage(snapshot)}`,
  ];

  if (snapshot.models.length > 0) {
    lines.push("Usage by model:");
    for (const usage of snapshot.models) {
      lines.push(`  ${usage.model}: ${formatModelUsage(usage)} (${formatUsd(usage.costUsd)})`);
    }
  }

  return lines.join("\n");
}

/** chat 退出时加统一前缀，避免与模型正文混在一起。 */
export function formatChatCostSummary(snapshot: CostSnapshot): string {
  return formatCostSummary(snapshot)
    .split("\n")
    .map((line) => `[cost] ${line}`)
    .join("\n");
}

function buildSnapshot(models: readonly CostModelUsage[]): CostSnapshot {
  const sortedModels = [...models].sort((left, right) => left.model.localeCompare(right.model));
  return {
    totalInputTokens: sumBy(sortedModels, (usage) => usage.inputTokens),
    totalOutputTokens: sumBy(sortedModels, (usage) => usage.outputTokens),
    totalCacheReadInputTokens: sumBy(sortedModels, (usage) => usage.cacheReadInputTokens),
    totalCacheCreationInputTokens: sumBy(sortedModels, (usage) => usage.cacheCreationInputTokens),
    totalCostUsd: sumBy(sortedModels, (usage) => usage.costUsd),
    usedFallbackPricing: sortedModels.some((usage) => usage.usedFallbackPricing),
    models: sortedModels,
  };
}

function createMutableFromUsage(usage: CostModelUsage): MutableCostModelUsage {
  return { ...usage };
}

function toCostModelUsage(usage: MutableCostModelUsage): CostModelUsage {
  return { ...usage };
}

function sumBy<T>(values: readonly T[], selector: (value: T) => number): number {
  return values.reduce((sum, value) => sum + selector(value), 0);
}

function totalTokens(snapshot: CostSnapshot): number {
  return (
    snapshot.totalInputTokens +
    snapshot.totalOutputTokens +
    snapshot.totalCacheReadInputTokens +
    snapshot.totalCacheCreationInputTokens
  );
}

function formatTokenUsage(snapshot: CostSnapshot): string {
  return (
    `${formatNumber(snapshot.totalInputTokens)} input, ` +
    `${formatNumber(snapshot.totalOutputTokens)} output, ` +
    `${formatNumber(snapshot.totalCacheReadInputTokens)} cache read, ` +
    `${formatNumber(snapshot.totalCacheCreationInputTokens)} cache write`
  );
}

function formatModelUsage(usage: CostModelUsage): string {
  return (
    `${formatNumber(usage.inputTokens)} input, ` +
    `${formatNumber(usage.outputTokens)} output, ` +
    `${formatNumber(usage.cacheReadInputTokens)} cache read, ` +
    `${formatNumber(usage.cacheCreationInputTokens)} cache write`
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatUsd(cost: number): string {
  if (cost > 0.5) return `$${round(cost, 100).toFixed(2)}`;
  return `$${cost.toFixed(4)}`;
}

function fallbackSuffix(snapshot: CostSnapshot): string {
  return snapshot.usedFallbackPricing ? " (unknown model pricing fallback applied)" : "";
}

function round(value: number, precision: number): number {
  return Math.round(value * precision) / precision;
}
