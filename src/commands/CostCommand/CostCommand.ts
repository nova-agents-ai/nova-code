/** `nova-code cost`：展示历史 chat ledger 的 token 与费用汇总。 */

import type { ConfigSource } from "../../config/config.ts";
import { ConfigError } from "../../errors/index.ts";
import {
  formatCostSummary,
  readCostLedgerEntries,
  summarizeCostLedgerEntries,
} from "../../services/cost/index.ts";
import type { CommandDefinition } from "../types.ts";

interface CostCommandIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface RunCostCommandOptions {
  readonly configSource?: ConfigSource;
  readonly io?: CostCommandIO;
}

export const costCommand: CommandDefinition = {
  name: "cost",
  description: "展示历史 chat 的 token 消耗与估算费用",
  usage: "nova-code cost [--json]",
  run: (args) => runCostCommand(args),
};

/** 测试友好的 cost 命令入口。 */
export async function runCostCommand(
  args: readonly string[],
  options: RunCostCommandOptions = {},
): Promise<number> {
  const io = options.io ?? defaultIO();
  const flags = parseCostArgs(args);
  if (flags.ok === false) {
    io.stderr(`cost: ${flags.message}\n`);
    return 1;
  }

  try {
    const entries = await readCostLedgerEntries(options.configSource);
    const snapshot = summarizeCostLedgerEntries(entries);
    if (flags.json) {
      io.stdout(`${JSON.stringify({ entries: entries.length, snapshot }, null, 2)}\n`);
    } else {
      io.stdout(`${formatCostSummary(snapshot)}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(`cost: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

type ParseCostArgsResult =
  | { readonly ok: true; readonly json: boolean }
  | { readonly ok: false; readonly message: string };

function parseCostArgs(args: readonly string[]): ParseCostArgsResult {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    return { ok: false, message: `unknown argument ${arg}` };
  }
  return { ok: true, json };
}

function defaultIO(): CostCommandIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}
