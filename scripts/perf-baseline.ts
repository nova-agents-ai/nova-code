/**
 * M6.5 performance baseline runner.
 *
 * Usage:
 *   bun run perf:baseline
 *   bun run perf:baseline -- --runs=10
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { measurePerformanceMetric, type PerformanceMetric } from "../src/services/performance/perfBaseline.ts";

const BIN_PATH = fileURLToPath(new URL("../bin/nova-code.ts", import.meta.url));
const DEFAULT_RUNS = 5;
const CHILD_TIMEOUT_MS = 20_000;

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function parseRuns(args: readonly string[]): number {
  const raw = args.find((arg) => arg.startsWith("--runs="));
  if (raw === undefined) return DEFAULT_RUNS;
  const value = Number.parseInt(raw.slice("--runs=".length), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--runs must be a positive integer, got ${raw}`);
  }
  return value;
}

async function runCommand(params: {
  readonly cmd: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd: params.cmd,
    env: params.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeoutHandle = setTimeout(() => proc.kill(), CHILD_TIMEOUT_MS);
  const exitCode = await proc.exited;
  clearTimeout(timeoutHandle);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

function assertSuccess(result: CommandResult, label: string): void {
  if (result.exitCode === 0) return;
  throw new Error(`${label} failed with exit ${result.exitCode}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
}

function baseEnv(home: string): Readonly<Record<string, string>> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    USERPROFILE: home,
  };
}

async function measureStartup(runs: number, home: string): Promise<PerformanceMetric> {
  return measurePerformanceMetric({
    name: "startup.version",
    runs,
    task: async () => {
      const result = await runCommand({
        cmd: ["bun", "run", BIN_PATH, "--version"],
        env: baseEnv(home),
      });
      assertSuccess(result, "startup.version");
    },
  });
}

async function measureSingleToolLoop(runs: number, home: string): Promise<PerformanceMetric> {
  return measurePerformanceMetric({
    name: "ask.todo-write.single-tool-loop",
    runs,
    task: async () => {
      const result = await runCommand({
        cmd: ["bun", "run", BIN_PATH, "ask", "implement a multi-file feature"],
        env: {
          ...baseEnv(home),
          NOVA_API_KEY: "sk-mock",
          NOVA_TRANSPORT: "mock",
          NOVA_MOCK_SCENARIO: "todo-loop",
        },
      });
      assertSuccess(result, "ask.todo-write.single-tool-loop");
    },
  });
}

function printMetrics(metrics: readonly PerformanceMetric[]): void {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), metrics }, null, 2));
  console.error("\nMetric                           runs  min(ms)  median(ms)  avg(ms)  max(ms)");
  for (const metric of metrics) {
    console.error(
      `${metric.name.padEnd(32)} ${String(metric.runs).padStart(4)} ${String(metric.minMs).padStart(8)} ${String(metric.medianMs).padStart(11)} ${String(metric.avgMs).padStart(8)} ${String(metric.maxMs).padStart(8)}`,
    );
  }
}

async function main(): Promise<void> {
  const runs = parseRuns(process.argv.slice(2));
  const home = await mkdtemp(join(tmpdir(), "nova-perf-baseline-"));
  try {
    const metrics = await Promise.all([measureStartup(runs, home), measureSingleToolLoop(runs, home)]);
    printMetrics(metrics);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`perf-baseline: ${message}`);
  process.exit(1);
}
