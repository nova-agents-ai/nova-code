import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiUsage } from "../../types/message.ts";
import {
  appendCostLedgerEntry,
  CostTracker,
  formatCostSummary,
  readCostLedgerEntries,
  summarizeCostLedgerEntries,
} from "./index.ts";
import { calculateUsageCostUsd, getModelPricing } from "./pricing.ts";

async function makeTempHome(): Promise<{
  readonly homeDir: string;
  readonly cleanup: () => Promise<void>;
}> {
  const homeDir = await mkdtemp(join(tmpdir(), "nova-cost-test-"));
  return {
    homeDir,
    cleanup: () => rm(homeDir, { recursive: true, force: true }),
  };
}

const SONNET_USAGE: ApiUsage = {
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  cache_creation_input_tokens: 1_000_000,
  cache_read_input_tokens: 1_000_000,
};

describe("cost pricing", () => {
  test("识别带日期后缀的 Sonnet 4.5 模型", () => {
    const lookup = getModelPricing("claude-sonnet-4-5-20250929");
    expect(lookup.usedFallback).toBe(false);
    expect(lookup.canonicalName).toBe("claude-sonnet-4.x");
  });

  test("按 input/output/cache write/cache read 计算 USD", () => {
    const estimate = calculateUsageCostUsd({
      model: "claude-sonnet-4-5-20250929",
      usage: SONNET_USAGE,
    });
    expect(estimate.costUsd).toBeCloseTo(22.05, 8);
  });
});

describe("CostTracker", () => {
  test("累计同一模型多次 usage 并格式化摘要", () => {
    const tracker = new CostTracker();
    tracker.recordUsage("claude-sonnet-4-5-20250929", {
      input_tokens: 10,
      output_tokens: 2,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
    });
    tracker.recordUsage("claude-sonnet-4-5-20250929", {
      input_tokens: 5,
      output_tokens: 1,
    });

    const snapshot = tracker.snapshot();
    expect(snapshot.totalInputTokens).toBe(15);
    expect(snapshot.totalOutputTokens).toBe(3);
    expect(snapshot.totalCacheCreationInputTokens).toBe(3);
    expect(snapshot.totalCacheReadInputTokens).toBe(4);
    expect(snapshot.models).toHaveLength(1);
    expect(formatCostSummary(snapshot)).toContain(
      "15 input, 3 output, 4 cache read, 3 cache write",
    );
  });
});

describe("cost ledger", () => {
  test("append/read/summarize 使用注入 home，不污染真实 ~/.nova-code", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const tracker = new CostTracker();
      tracker.recordUsage("claude-haiku-4-5", { input_tokens: 1000, output_tokens: 200 });
      await appendCostLedgerEntry({
        source: { homeDir },
        entry: {
          schemaVersion: 1,
          createdAt: "2026-05-14T00:00:00.000Z",
          command: "chat",
          exitCode: 0,
          sessionId: "sess-test",
          snapshot: tracker.snapshot(),
        },
      });

      const entries = await readCostLedgerEntries({ homeDir });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.sessionId).toBe("sess-test");
      const summary = summarizeCostLedgerEntries(entries);
      expect(summary.totalInputTokens).toBe(1000);
      expect(summary.totalOutputTokens).toBe(200);
    } finally {
      await cleanup();
    }
  });
});
