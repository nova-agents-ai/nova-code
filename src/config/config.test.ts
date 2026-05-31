/**
 * config 模块单元测试。
 *
 * 不碰真实 ~/.nova-code/config.json：所有读写都通过 ConfigSource 注入临时目录。
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../errors/index.ts";
import {
  getConfigFilePath,
  getCostLedgerPath,
  getLogsDirPath,
  getSessionsDirPath,
  loadConfig,
  loadPersistedConfig,
  resolveConfig,
  savePersistedConfig,
} from "./config.ts";

async function makeTempHome(): Promise<{
  homeDir: string;
  cleanup: () => Promise<void>;
}> {
  const homeDir = await mkdtemp(join(tmpdir(), "nova-code-config-test-"));
  return {
    homeDir,
    cleanup: () => rm(homeDir, { recursive: true, force: true }),
  };
}

describe("config - getConfigFilePath", () => {
  test("以 ~/.nova-code/config.json 为路径", () => {
    const path = getConfigFilePath({ homeDir: "/fake/home" });
    // 使用正则匹配，兼容 Windows (\) 和 POSIX (/) 路径分隔符
    expect(path).toMatch(/[\\/]fake[\\/]home[\\/]\.nova-code[\\/]config\.json$/);
  });
});

describe("config - getLogsDirPath", () => {
  test("以 ~/.nova-code/logs 为路径", () => {
    const path = getLogsDirPath({ homeDir: "/fake/home" });
    // 使用正则匹配，兼容 Windows (\) 和 POSIX (/) 路径分隔符
    expect(path).toMatch(/[\\/]fake[\\/]home[\\/]\.nova-code[\\/]logs$/);
  });
});

describe("config - getSessionsDirPath", () => {
  test("以 ~/.nova-code/sessions 为路径", () => {
    const path = getSessionsDirPath({ homeDir: "/fake/home" });
    expect(path).toMatch(/[\\/]fake[\\/]home[\\/]\.nova-code[\\/]sessions$/);
  });

  test("不传 source 时基于当前 homedir()\uff08只验证以 /sessions 结尾）", () => {
    const path = getSessionsDirPath();
    expect(path.endsWith("/.nova-code/sessions") || path.endsWith("\\.nova-code\\sessions")).toBe(
      true,
    );
  });
});

describe("config - getCostLedgerPath", () => {
  test("以 ~/.nova-code/cost.jsonl 为路径", () => {
    const path = getCostLedgerPath({ homeDir: "/fake/home" });
    expect(path).toMatch(/[\\/]fake[\\/]home[\\/]\.nova-code[\\/]cost\.jsonl$/);
  });
});

describe("config - loadPersistedConfig", () => {
  test("文件不存在时返回空对象（不报错）", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const result = await loadPersistedConfig({ homeDir });
      expect(result).toEqual({});
    } finally {
      await cleanup();
    }
  });

  test("读取合法 JSON 配置", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      await savePersistedConfig(
        {
          apiKey: "sk-ant-xxx",
          model: "claude-haiku-4-5",
          maxTokens: 4096,
          webProxy: "http://proxy.example:8080",
          webProxyDomains: ["example.com", "*.blocked.test"],
          mcpServers: {
            filesystem: {
              command: "bunx",
              args: ["@modelcontextprotocol/server-filesystem", "/tmp"],
              autoApprove: false,
            },
            remote: {
              type: "http",
              url: "https://mcp.example/mcp",
              headers: { Authorization: `Bearer \${MCP_TOKEN}` },
              timeoutMs: 5000,
            },
          },
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "bun run .nova-code/hooks/pre.ts" }],
              },
            ],
          },
        },
        { homeDir },
      );
      const loaded = await loadPersistedConfig({ homeDir });
      expect(loaded).toEqual({
        apiKey: "sk-ant-xxx",
        model: "claude-haiku-4-5",
        maxTokens: 4096,
        webProxy: "http://proxy.example:8080",
        webProxyDomains: ["example.com", "*.blocked.test"],
        mcpServers: {
          filesystem: {
            command: "bunx",
            args: ["@modelcontextprotocol/server-filesystem", "/tmp"],
            autoApprove: false,
          },
          remote: {
            type: "http",
            url: "https://mcp.example/mcp",
            headers: { Authorization: `Bearer \${MCP_TOKEN}` },
            timeoutMs: 5000,
          },
        },
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "bun run .nova-code/hooks/pre.ts" }],
            },
          ],
        },
      });
    } finally {
      await cleanup();
    }
  });

  test("非法 JSON 抛 ConfigError", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const path = getConfigFilePath({ homeDir });
      // 先创建 .nova-code 目录，再写入损坏的 JSON
      await mkdir(join(homeDir, ".nova-code"), { recursive: true });
      await writeFile(path, "{ not valid json", "utf8");
      await expect(loadPersistedConfig({ homeDir })).rejects.toThrow(ConfigError);
    } finally {
      await cleanup();
    }
  });

  test("字段类型错误抛 ConfigError 并包含字段名", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const path = getConfigFilePath({ homeDir });
      await Bun.write(path, JSON.stringify({ maxTokens: "not-a-number" }));
      await expect(loadPersistedConfig({ homeDir })).rejects.toThrow(/maxTokens.*positive integer/);
    } finally {
      await cleanup();
    }
  });

  test("webProxy 必须是 http/https URL，webProxyDomains 必须是字符串数组", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const path = getConfigFilePath({ homeDir });
      await Bun.write(path, JSON.stringify({ webProxy: "socks5://proxy.example:1080" }));
      await expect(loadPersistedConfig({ homeDir })).rejects.toThrow(/webProxy.*http or https/);

      await Bun.write(path, JSON.stringify({ webProxyDomains: ["ok.test", 123] }));
      await expect(loadPersistedConfig({ homeDir })).rejects.toThrow(/webProxyDomains\[1\]/);
    } finally {
      await cleanup();
    }
  });

  test("mcpServers 校验 server name 与 stdio server 字段", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const path = getConfigFilePath({ homeDir });
      await Bun.write(path, JSON.stringify({ mcpServers: { "bad.name": { command: "bun" } } }));
      await expect(loadPersistedConfig({ homeDir })).rejects.toThrow(/must match/);

      await Bun.write(path, JSON.stringify({ mcpServers: { ok: { args: ["missing-command"] } } }));
      await expect(loadPersistedConfig({ homeDir })).rejects.toThrow(/command/);

      await Bun.write(
        path,
        JSON.stringify({ mcpServers: { ok: { command: "bun", timeoutMs: 0 } } }),
      );
      await expect(loadPersistedConfig({ homeDir })).rejects.toThrow(/timeoutMs/);

      await Bun.write(path, JSON.stringify({ mcpServers: { remote: { type: "http" } } }));
      await expect(loadPersistedConfig({ homeDir })).rejects.toThrow(/url/);

      await Bun.write(
        path,
        JSON.stringify({ mcpServers: { remote: { type: "http", url: "ftp://example/mcp" } } }),
      );
      await expect(loadPersistedConfig({ homeDir })).rejects.toThrow(/http or https/);
    } finally {
      await cleanup();
    }
  });

  test("hooks 校验事件名、matcher 与 command hook 字段", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const path = getConfigFilePath({ homeDir });
      await Bun.write(path, JSON.stringify({ hooks: { Unknown: [] } }));
      await expect(loadPersistedConfig({ homeDir })).rejects.toThrow(/unsupported event/);

      await Bun.write(path, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [] }] } }));
      await expect(loadPersistedConfig({ homeDir })).resolves.toEqual({
        hooks: { PreToolUse: [{ hooks: [] }] },
      });

      await Bun.write(
        path,
        JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "x" }] }] } }),
      );
      await expect(loadPersistedConfig({ homeDir })).rejects.toThrow(/type/);

      await Bun.write(
        path,
        JSON.stringify({
          hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "" }] }] },
        }),
      );
      await expect(loadPersistedConfig({ homeDir })).rejects.toThrow(/command/);
    } finally {
      await cleanup();
    }
  });

  test("顶层不是对象时抛 ConfigError", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const path = getConfigFilePath({ homeDir });
      await Bun.write(path, JSON.stringify(["not", "an", "object"]));
      await expect(loadPersistedConfig({ homeDir })).rejects.toThrow(/must be a JSON object/);
    } finally {
      await cleanup();
    }
  });
});

describe("config - resolveConfig", () => {
  test("apiKey 缺失时抛 ConfigError 并提示 env 变量名", () => {
    expect(() => resolveConfig({}, { env: {} })).toThrow(/NOVA_API_KEY/);
  });

  test("环境变量优先于配置文件", () => {
    const result = resolveConfig(
      {
        apiKey: "from-file",
        model: "from-file-model",
        webProxy: "http://file-proxy.example:8080",
        webProxyDomains: ["file.example"],
      },
      {
        env: {
          NOVA_API_KEY: "from-env",
          NOVA_MODEL: "from-env-model",
          NOVA_WEB_PROXY: "https://env-proxy.example:8443",
          NOVA_WEB_PROXY_DOMAINS: "env.example, *.blocked.test",
        },
      },
    );
    expect(result.apiKey).toBe("from-env");
    expect(result.model).toBe("from-env-model");
    expect(result.webProxy).toBe("https://env-proxy.example:8443");
    expect(result.webProxyDomains).toEqual(["env.example", "*.blocked.test"]);
    expect(result.mcpServers).toEqual({});
    expect(result.hooks).toEqual({});
  });

  test("配置文件值生效（无对应 env）", () => {
    const result = resolveConfig(
      {
        apiKey: "sk-ant-xxx",
        baseURL: "https://proxy.example.com",
        maxTokens: 2048,
        maxTurns: 5,
        webProxy: "http://web-proxy.example:8080",
        webProxyDomains: ["example.com"],
        mcpServers: { git: { command: "uvx", args: ["mcp-server-git"] } },
      },
      { env: {} },
    );
    expect(result.apiKey).toBe("sk-ant-xxx");
    expect(result.baseURL).toBe("https://proxy.example.com");
    expect(result.maxTokens).toBe(2048);
    expect(result.maxTurns).toBe(5);
    expect(result.webProxy).toBe("http://web-proxy.example:8080");
    expect(result.webProxyDomains).toEqual(["example.com"]);
    expect(result.mcpServers).toEqual({ git: { command: "uvx", args: ["mcp-server-git"] } });
    expect(result.hooks).toEqual({});
  });

  test("缺省值在 persisted 与 env 都没设时生效", () => {
    const result = resolveConfig({ apiKey: "sk-ant-xxx" }, { env: {} });
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
    expect(result.maxTokens).toBe(8192);
    expect(result.maxTurns).toBe(25);
    expect(result.baseURL).toBeUndefined();
    expect(result.webProxy).toBeUndefined();
    expect(result.webProxyDomains).toEqual([]);
    expect(result.mcpServers).toEqual({});
    expect(result.hooks).toEqual({});
  });
});

describe("config - savePersistedConfig", () => {
  test("能够先 save 再 load 出相同内容", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const config = {
        apiKey: "sk-ant-roundtrip",
        model: "claude-haiku-4-5",
        maxTokens: 2048,
        maxTurns: 10,
        webProxy: "https://proxy.example:8443",
        webProxyDomains: ["example.com"],
        mcpServers: { git: { command: "uvx", args: ["mcp-server-git"], autoApprove: true } },
      };
      await savePersistedConfig(config, { homeDir });
      const reloaded = await loadPersistedConfig({ homeDir });
      expect(reloaded).toEqual(config);
    } finally {
      await cleanup();
    }
  });

  test("自动创建父目录", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      // homeDir 存在但 .nova-code 不存在 —— savePersistedConfig 应自动 mkdir
      await savePersistedConfig({ apiKey: "sk-ant-xxx" }, { homeDir });
      const reloaded = await loadPersistedConfig({ homeDir });
      expect(reloaded.apiKey).toBe("sk-ant-xxx");
    } finally {
      await cleanup();
    }
  });

  test("写入非法配置时抛 ConfigError（输入校验）", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      await expect(
        savePersistedConfig(
          { maxTokens: -1 } as unknown as Parameters<typeof savePersistedConfig>[0],
          { homeDir },
        ),
      ).rejects.toThrow(/positive integer/);
    } finally {
      await cleanup();
    }
  });
});

describe("config - loadConfig (集成)", () => {
  test("从空 home 加载，env 提供 apiKey → 走默认值", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const config = await loadConfig({
        homeDir,
        env: { NOVA_API_KEY: "sk-ant-xxx" },
      });
      expect(config.apiKey).toBe("sk-ant-xxx");
      expect(config.model).toBe("claude-sonnet-4-5-20250929");
    } finally {
      await cleanup();
    }
  });

  test("文件 + env 混合", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      await savePersistedConfig(
        { apiKey: "from-file", model: "claude-haiku-4-5", maxTokens: 1024 },
        { homeDir },
      );
      const config = await loadConfig({
        homeDir,
        env: { NOVA_API_KEY: "from-env" },
      });
      // env 覆盖 apiKey；其它字段沿用文件
      expect(config.apiKey).toBe("from-env");
      expect(config.model).toBe("claude-haiku-4-5");
      expect(config.maxTokens).toBe(1024);
    } finally {
      await cleanup();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// M16: autoMemoryEnabled 字段
// ────────────────────────────────────────────────────────────────────────────
describe("autoMemoryEnabled (M16)", () => {
  test("默认 true（未设置时）", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const config = await loadConfig({ homeDir, env: { NOVA_API_KEY: "sk" } });
      expect(config.autoMemoryEnabled).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("文件设 false 后 resolve 也是 false", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      await savePersistedConfig({ apiKey: "sk", autoMemoryEnabled: false }, { homeDir });
      const config = await loadConfig({ homeDir });
      expect(config.autoMemoryEnabled).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("非 boolean 抛 ConfigError", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      // 直接写入非法 JSON
      const path = `${homeDir}/.nova-code/config.json`;
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '{"apiKey":"sk","autoMemoryEnabled":"yes"}');
      await expect(loadConfig({ homeDir })).rejects.toThrow(/autoMemoryEnabled/);
    } finally {
      await cleanup();
    }
  });
});
