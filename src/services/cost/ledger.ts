/**
 * Cost ledger：把 chat 会话结束时的 usage 快照追加到 ~/.nova-code/cost.jsonl。
 *
 * 设计取舍：claude-code 的 /cost 是 TUI 内存命令，能直接读当前 session state；
 * nova-code 的 `nova-code cost` 是独立 CLI 子命令，必须有一个轻量持久化层才能
 * 展示上一轮 chat 的统计。
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type ConfigSource, getCostLedgerPath } from "../../config/config.ts";
import { ConfigError } from "../../errors/index.ts";
import {
  type CostModelUsage,
  type CostSnapshot,
  createEmptyCostSnapshot,
  mergeCostSnapshots,
} from "./CostTracker.ts";

export type CostLedgerCommand = "chat" | "ask";

export interface CostLedgerEntry {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly command: CostLedgerCommand;
  readonly exitCode: number;
  readonly snapshot: CostSnapshot;
  readonly sessionId?: string;
}

export interface AppendCostLedgerEntryParams {
  readonly entry: CostLedgerEntry;
  readonly source?: ConfigSource;
}

/** 追加一条 JSONL entry。 */
export async function appendCostLedgerEntry(params: AppendCostLedgerEntryParams): Promise<void> {
  if (isEmptySnapshot(params.entry.snapshot)) return;
  const path = getCostLedgerPath(params.source);
  try {
    await mkdir(dirname(path), { recursive: true });
    const existing = await readFileTextIfExists(path);
    await Bun.write(path, `${existing}${JSON.stringify(params.entry)}\n`);
  } catch (error) {
    throw new ConfigError(`Failed to write cost ledger at ${path}: ${describeError(error)}`);
  }
}

/** 读取全部 ledger entry；文件不存在时返回空数组。 */
export async function readCostLedgerEntries(
  source: ConfigSource = {},
): Promise<readonly CostLedgerEntry[]> {
  const path = getCostLedgerPath(source);
  const raw = await readFileTextIfExists(path);
  if (raw.trim() === "") return [];

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line, index) => parseCostLedgerEntry(line, path, index + 1));
}

/** 汇总多条 ledger entry。 */
export function summarizeCostLedgerEntries(entries: readonly CostLedgerEntry[]): CostSnapshot {
  if (entries.length === 0) return createEmptyCostSnapshot();
  return mergeCostSnapshots(entries.map((entry) => entry.snapshot));
}

function parseCostLedgerEntry(line: string, path: string, lineNumber: number): CostLedgerEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new ConfigError(
      `Cost ledger at ${path}:${lineNumber} is not valid JSON: ${describeError(error)}`,
    );
  }

  if (!isCostLedgerEntry(parsed)) {
    throw new ConfigError(`Cost ledger at ${path}:${lineNumber} has an invalid schema.`);
  }
  return parsed;
}

function isCostLedgerEntry(value: unknown): value is CostLedgerEntry {
  if (!isRecord(value)) return false;
  if (value["schemaVersion"] !== 1) return false;
  if (typeof value["createdAt"] !== "string") return false;
  if (value["command"] !== "chat" && value["command"] !== "ask") return false;
  if (typeof value["exitCode"] !== "number") return false;
  if (value["sessionId"] !== undefined && typeof value["sessionId"] !== "string") return false;
  return isCostSnapshot(value["snapshot"]);
}

function isCostSnapshot(value: unknown): value is CostSnapshot {
  if (!isRecord(value)) return false;
  if (!isNumberField(value, "totalInputTokens")) return false;
  if (!isNumberField(value, "totalOutputTokens")) return false;
  if (!isNumberField(value, "totalCacheReadInputTokens")) return false;
  if (!isNumberField(value, "totalCacheCreationInputTokens")) return false;
  if (!isNumberField(value, "totalCostUsd")) return false;
  if (typeof value["usedFallbackPricing"] !== "boolean") return false;
  if (!Array.isArray(value["models"])) return false;
  return value["models"].every(isCostModelUsage);
}

function isCostModelUsage(value: unknown): value is CostModelUsage {
  if (!isRecord(value)) return false;
  if (typeof value["model"] !== "string") return false;
  if (typeof value["pricingModel"] !== "string") return false;
  if (!isNumberField(value, "inputTokens")) return false;
  if (!isNumberField(value, "outputTokens")) return false;
  if (!isNumberField(value, "cacheReadInputTokens")) return false;
  if (!isNumberField(value, "cacheCreationInputTokens")) return false;
  if (!isNumberField(value, "costUsd")) return false;
  return typeof value["usedFallbackPricing"] === "boolean";
}

function isNumberField(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "number" && Number.isFinite(value[key]);
}

function isEmptySnapshot(snapshot: CostSnapshot): boolean {
  return (
    snapshot.totalInputTokens +
      snapshot.totalOutputTokens +
      snapshot.totalCacheReadInputTokens +
      snapshot.totalCacheCreationInputTokens ===
    0
  );
}

async function readFileTextIfExists(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return "";
  return file.text();
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
