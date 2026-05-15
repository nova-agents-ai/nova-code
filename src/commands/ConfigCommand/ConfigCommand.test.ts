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

  test("set webProxy / webProxyDomains 写入配置，get webProxy 会脱敏凭证", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    const capture = createCapture();
    try {
      const io = {
        stdout: (text: string) => capture.stdout.push(text),
        stderr: (text: string) => capture.stderr.push(text),
      };
      await runConfigCommand(["set", "webProxy", "http://user:pass@proxy.example:8080"], {
        configSource: { homeDir },
        io,
      });
      await runConfigCommand(["set", "webProxyDomains", "example.com, *.blocked.test"], {
        configSource: { homeDir },
        io,
      });

      const stored = await loadPersistedConfig({ homeDir });
      expect(stored.webProxy).toBe("http://user:pass@proxy.example:8080");
      expect(stored.webProxyDomains).toEqual(["example.com", "*.blocked.test"]);

      capture.stdout.length = 0;
      await runConfigCommand(["get", "webProxy"], { configSource: { homeDir }, io });
      expect(capture.stdout.join("")).toBe("http://****:****@proxy.example:8080/\n");
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

  test("set webProxy 非 http/https URL 时返回 1", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    const capture = createCapture();
    try {
      const exitCode = await runConfigCommand(["set", "webProxy", "socks5://127.0.0.1:1080"], {
        configSource: { homeDir },
        io: {
          stdout: (text) => capture.stdout.push(text),
          stderr: (text) => capture.stderr.push(text),
        },
      });
      expect(exitCode).toBe(1);
      expect(capture.stderr.join("")).toContain("http or https");
    } finally {
      await cleanup();
    }
  });
});
