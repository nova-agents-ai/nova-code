/**
 * config 模块单元测试。
 *
 * 不碰真实 ~/.nova-code/config.json：所有读写都通过 ConfigSource 注入临时目录。
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../llm/errors.ts";
import {
  getConfigFilePath,
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
    expect(path).toBe("/fake/home/.nova-code/config.json");
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
        { apiKey: "sk-ant-xxx", model: "claude-haiku-4-5", maxTokens: 4096 },
        { homeDir },
      );
      const loaded = await loadPersistedConfig({ homeDir });
      expect(loaded).toEqual({
        apiKey: "sk-ant-xxx",
        model: "claude-haiku-4-5",
        maxTokens: 4096,
      });
    } finally {
      await cleanup();
    }
  });

  test("非法 JSON 抛 ConfigError", async () => {
    const { homeDir, cleanup } = await makeTempHome();
    try {
      const path = getConfigFilePath({ homeDir });
      // 手动写入一个损坏的 JSON
      await writeFile(path.replace("config.json", ""), "", { flag: "a" }).catch(() => {});
      await Bun.write(path, "{ not valid json");
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
      { apiKey: "from-file", model: "from-file-model" },
      {
        env: {
          NOVA_API_KEY: "from-env",
          NOVA_MODEL: "from-env-model",
        },
      },
    );
    expect(result.apiKey).toBe("from-env");
    expect(result.model).toBe("from-env-model");
  });

  test("配置文件值生效（无对应 env）", () => {
    const result = resolveConfig(
      {
        apiKey: "sk-ant-xxx",
        baseURL: "https://proxy.example.com",
        maxTokens: 2048,
        maxTurns: 5,
      },
      { env: {} },
    );
    expect(result.apiKey).toBe("sk-ant-xxx");
    expect(result.baseURL).toBe("https://proxy.example.com");
    expect(result.maxTokens).toBe(2048);
    expect(result.maxTurns).toBe(5);
  });

  test("缺省值在 persisted 与 env 都没设时生效", () => {
    const result = resolveConfig({ apiKey: "sk-ant-xxx" }, { env: {} });
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
    expect(result.maxTokens).toBe(8192);
    expect(result.maxTurns).toBe(25);
    expect(result.baseURL).toBeUndefined();
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
