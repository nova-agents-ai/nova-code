import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCostLedgerEntry, CostTracker } from "../../services/cost/index.ts";
import { runCostCommand } from "./CostCommand.ts";

interface Capture {
  readonly stdout: string[];
  readonly stderr: string[];
}

async function makeTempHome(): Promise<{
  readonly homeDir: string;
  readonly cleanup: () => Promise<void>;
}> {
  const homeDir = await mkdtemp(join(tmpdir(), "nova-cost-command-test-"));
  return {
    homeDir,
    cleanup: () => rm(homeDir, { recursive: true, force: true }),
  };
}

function createCapture(): Capture {
  return { stdout: [], stderr: [] };
}

describe("cost command", () => {
  test("ledger 为空时展示 0 usage", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    const capture = createCapture();
    try {
      const exitCode = await runCostCommand([], {
        configSource: { homeDir },
        io: {
          stdout: (text) => capture.stdout.push(text),
          stderr: (text) => capture.stderr.push(text),
        },
      });
      expect(exitCode).toBe(0);
      expect(capture.stdout.join("")).toContain("0 input, 0 output");
    } finally {
      await cleanup();
    }
  });

  test("汇总 ledger 并支持 --json", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    const capture = createCapture();
    try {
      const tracker = new CostTracker();
      tracker.recordUsage("claude-sonnet-4-5-20250929", { input_tokens: 7, output_tokens: 3 });
      await appendCostLedgerEntry({
        source: { homeDir },
        entry: {
          schemaVersion: 1,
          createdAt: "2026-05-14T00:00:00.000Z",
          command: "chat",
          exitCode: 0,
          snapshot: tracker.snapshot(),
        },
      });

      const exitCode = await runCostCommand(["--json"], {
        configSource: { homeDir },
        io: {
          stdout: (text) => capture.stdout.push(text),
          stderr: (text) => capture.stderr.push(text),
        },
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(capture.stdout.join("")) as {
        readonly entries: number;
        readonly snapshot: {
          readonly totalInputTokens: number;
          readonly totalOutputTokens: number;
        };
      };
      expect(parsed.entries).toBe(1);
      expect(parsed.snapshot.totalInputTokens).toBe(7);
      expect(parsed.snapshot.totalOutputTokens).toBe(3);
    } finally {
      await cleanup();
    }
  });
});
