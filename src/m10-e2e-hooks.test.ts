/** M10 e2e：ask + mock LLM 触发 PreToolUse / PostToolUse command hooks。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_PATH = fileURLToPath(new URL("../bin/nova-code.ts", import.meta.url));

interface RunAskResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

let home: string;
let preLog: string;
let postLog: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nova-m10-home-"));
  preLog = join(home, "pre-hook.json");
  postLog = join(home, "post-hook.json");
  await writeHookFixture(home, preLog, postLog);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("m10-e2e-hooks", () => {
  test("PreToolUse/PostToolUse command hooks run around TodoWrite", async () => {
    const result = await runAskChild(home);

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stderr).toContain("HOOKED_TODO_OUTPUT");

    const pre = JSON.parse(await readFile(preLog, "utf8")) as Record<string, unknown>;
    const post = JSON.parse(await readFile(postLog, "utf8")) as Record<string, unknown>;
    expect(pre["hook_event_name"]).toBe("PreToolUse");
    expect(pre["tool_name"]).toBe("TodoWrite");
    expect(post["hook_event_name"]).toBe("PostToolUse");
    expect(post["tool_name"]).toBe("TodoWrite");
    expect(String(post["tool_response"])).toContain("Implementing changes across files");
  }, 20_000);
});

async function writeHookFixture(homeDir: string, prePath: string, postPath: string): Promise<void> {
  const hooksDir = join(homeDir, "hooks");
  await mkdir(hooksDir, { recursive: true });
  const preScript = join(hooksDir, "pre.ts");
  const postScript = join(hooksDir, "post.ts");
  await Bun.write(
    preScript,
    `const input = await new Response(Bun.stdin.stream()).json();
await Bun.write(process.argv[2], JSON.stringify(input, null, 2));
`,
  );
  await Bun.write(
    postScript,
    `const input = await new Response(Bun.stdin.stream()).json();
await Bun.write(process.argv[2], JSON.stringify(input, null, 2));
console.log(JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PostToolUse",
  updatedOutput: "HOOKED_TODO_OUTPUT"
}}));
`,
  );

  await mkdir(join(homeDir, ".nova-code"), { recursive: true });
  await Bun.write(
    join(homeDir, ".nova-code", "config.json"),
    `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "TodoWrite",
              hooks: [{ type: "command", command: `bun run ${preScript} ${prePath}` }],
            },
          ],
          PostToolUse: [
            {
              matcher: "TodoWrite",
              hooks: [{ type: "command", command: `bun run ${postScript} ${postPath}` }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function runAskChild(homeDir: string): Promise<RunAskResult> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", BIN_PATH, "ask", "use todo write for a multi-step task"],
    cwd: homeDir,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: homeDir,
      USERPROFILE: homeDir,
      NOVA_API_KEY: "sk-mock",
      NOVA_TRANSPORT: "mock",
      NOVA_MOCK_SCENARIO: "todo-loop",
      NOVA_WEB_PROXY: "",
      NOVA_WEB_PROXY_DOMAINS: "",
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
