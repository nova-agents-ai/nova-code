/** M13 e2e：enabled local plugin contributes skill, slash command, hook, and path-scoped rule. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_PATH = fileURLToPath(new URL("../bin/nova-code.ts", import.meta.url));

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface MockLogEntry {
  readonly lastUserText?: string;
  readonly systemSnippet?: string;
  readonly toolResultText?: string;
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nova-m13-plugins-"));
  await writeFixture(workDir);
  const enabled = await runNova(["plugin", "enable", "demo", "--yes"], workDir);
  expect(enabled.exitCode, `stdout=${enabled.stdout}\nstderr=${enabled.stderr}`).toBe(0);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("m13-e2e-plugins", () => {
  test("ask expands plugin slash command locally", async () => {
    const logFile = join(workDir, "mock-plugin-command.jsonl");
    const result = await runAsk(workDir, logFile, "chat", "/demo:review src/a.ts");

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    const log = await readMockLogEntries(logFile);
    expect(log[0]?.lastUserText ?? "").toContain(
      'The user directly invoked the plugin slash command "/demo:review".',
    );
    expect(log[0]?.lastUserText ?? "").toContain("PLUGIN_COMMAND_MARKER src/a.ts");
  }, 20_000);

  test("ask loads plugin skill listing, hook, and path-scoped rule", async () => {
    const logFile = join(workDir, "mock-plugin-rules.jsonl");
    const result = await runAsk(workDir, logFile, "rules-loop", "read src/a.ts");

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    const log = await readMockLogEntries(logFile);
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log[0]?.systemSnippet ?? "").toContain("- demo-skill: Demo plugin skill.");
    expect(log[0]?.systemSnippet ?? "").not.toContain("PLUGIN_SKILL_BODY_MARKER");
    expect(log[0]?.systemSnippet ?? "").not.toContain("PLUGIN_RULE_MARKER");
    expect(log[1]?.systemSnippet ?? "").toContain("PLUGIN_RULE_MARKER");
    expect(log[1]?.toolResultText ?? "").toContain("PLUGIN_HOOK_MARKER");
  }, 20_000);
});

async function writeFixture(dir: string): Promise<void> {
  await Bun.write(join(dir, ".git"), "gitdir: fake");
  await mkdir(join(dir, "src"), { recursive: true });
  await Bun.write(join(dir, "src", "a.ts"), "export const a = 1;\n");

  const pluginDir = join(dir, ".nova-code", "plugins", "demo");
  await mkdir(join(pluginDir, "skills", "demo-skill"), { recursive: true });
  await mkdir(join(pluginDir, "commands"), { recursive: true });
  await mkdir(join(pluginDir, "hooks"), { recursive: true });
  await mkdir(join(pluginDir, "rules"), { recursive: true });

  await Bun.write(
    join(pluginDir, "plugin.json"),
    JSON.stringify({ name: "demo", version: "1.0.0", description: "Demo plugin" }, null, 2),
  );
  await Bun.write(
    join(pluginDir, "skills", "demo-skill", "SKILL.md"),
    "---\ndescription: Demo plugin skill.\n---\nPLUGIN_SKILL_BODY_MARKER\n",
  );
  await Bun.write(
    join(pluginDir, "commands", "review.md"),
    "---\ndescription: Review via demo plugin.\n---\nPLUGIN_COMMAND_MARKER $ARGUMENTS\n",
  );
  await Bun.write(
    join(pluginDir, "hooks", "hooks.json"),
    JSON.stringify({
      PostToolUse: [
        {
          matcher: "FileRead",
          hooks: [{ type: "command", command: "bun $" + "{NOVA_PLUGIN_ROOT}/hook.ts" }],
        },
      ],
    }),
  );
  await Bun.write(
    join(pluginDir, "hook.ts"),
    "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'PLUGIN_HOOK_MARKER'}}));\n",
  );
  await Bun.write(
    join(pluginDir, "rules", "typescript.md"),
    '---\npaths: ["src/**/*.ts"]\n---\nPLUGIN_RULE_MARKER\n',
  );
}

async function runAsk(
  cwd: string,
  logFile: string,
  scenario: string,
  prompt: string,
): Promise<RunResult> {
  return await runNova(["ask", prompt], cwd, {
    NOVA_API_KEY: "sk-mock",
    NOVA_TRANSPORT: "mock",
    NOVA_MOCK_SCENARIO: scenario,
    NOVA_MOCK_LOG_FILE: logFile,
    MOCK_RULES_FILE_PATH: "src/a.ts",
  });
}

async function runNova(
  args: readonly string[],
  cwd: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: ["bun", BIN_PATH, ...args],
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: cwd,
      USERPROFILE: cwd,
      NOVA_WEB_PROXY: "",
      NOVA_WEB_PROXY_DOMAINS: "",
      ...extraEnv,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutHandle = setTimeout(() => proc.kill(), 15_000);
  const exitCode = await proc.exited;
  clearTimeout(timeoutHandle);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

async function readMockLogEntries(path: string): Promise<readonly MockLogEntry[]> {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as MockLogEntry);
}

function errnoCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
