import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPersistedConfig } from "../../config/config.ts";
import { runConfigCommand } from "./ConfigCommand.ts";

interface Capture {
  readonly stdout: string[];
  readonly stderr: string[];
}

async function makeTempHome(): Promise<{
  readonly homeDir: string;
  readonly cleanup: () => Promise<void>;
}> {
  const homeDir = await mkdtemp(join(tmpdir(), "nova-config-command-test-"));
  return {
    homeDir,
    cleanup: () => rm(homeDir, { recursive: true, force: true }),
  };
}

function createCapture(): Capture {
  return { stdout: [], stderr: [] };
}

describe("config command", () => {
  test("set model 写入配置，get model 读回", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    const capture = createCapture();
    try {
      const setCode = await runConfigCommand(["set", "model", "claude-haiku-4-5"], {
        configSource: { homeDir },
        io: {
          stdout: (text) => capture.stdout.push(text),
          stderr: (text) => capture.stderr.push(text),
        },
      });
      expect(setCode).toBe(0);
      expect((await loadPersistedConfig({ homeDir })).model).toBe("claude-haiku-4-5");

      capture.stdout.length = 0;
      const getCode = await runConfigCommand(["get", "model"], {
        configSource: { homeDir },
        io: {
          stdout: (text) => capture.stdout.push(text),
          stderr: (text) => capture.stderr.push(text),
        },
      });
      expect(getCode).toBe(0);
      expect(capture.stdout.join("")).toBe("claude-haiku-4-5\n");
    } finally {
      await cleanup();
    }
  });

  test("get apiKey 会脱敏", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    const capture = createCapture();
    try {
      await runConfigCommand(["set", "apiKey", "sk-ant-123456"], {
        configSource: { homeDir },
        io: {
          stdout: (text) => capture.stdout.push(text),
          stderr: (text) => capture.stderr.push(text),
        },
      });
      capture.stdout.length = 0;
      await runConfigCommand(["get", "apiKey"], {
        configSource: { homeDir },
        io: {
          stdout: (text) => capture.stdout.push(text),
          stderr: (text) => capture.stderr.push(text),
        },
      });
      expect(capture.stdout.join("")).toBe("****3456\n");
    } finally {
      await cleanup();
    }
  });

  test("set maxTokens 非正整数时返回 1", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    const capture = createCapture();
    try {
      const exitCode = await runConfigCommand(["set", "maxTokens", "0"], {
        configSource: { homeDir },
        io: {
          stdout: (text) => capture.stdout.push(text),
          stderr: (text) => capture.stderr.push(text),
        },
      });
      expect(exitCode).toBe(1);
      expect(capture.stderr.join("")).toContain("positive integer");
    } finally {
      await cleanup();
    }
  });
});
