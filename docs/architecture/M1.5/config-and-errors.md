# 06 · Config & Errors —— 配置加载与错误层次

> 对应文件：
> - [src/config/config.ts](../../src/config/config.ts)（265 行）
> - [src/errors/](../../src/errors/)（4 个错误类 + index）
> - [src/services/api/errors.ts](../../src/services/api/errors.ts)（LLMApiError）

---

## 1. 配置体系

### 1.1 文件位置

```
~/.nova-code/
├── config.json        # 用户可编辑的配置
└── logs/              # debug sink 追加模式写日志
    └── ask-<ts>-<pid>.log
```

`~/.nova-code/` 是一切 nova-code 状态的根。目前只存配置与 ask 的 debug 日志。未来 session 历史 / 缓存也会放这里。

### 1.2 三层配置：env > 文件 > 默认

```
env (NOVA_*)               ┐
  ↓ 覆盖                    │
~/.nova-code/config.json    │
(PersistedConfig)           │
  ↓ 合并缺省                │    最终 ResolvedConfig
内置默认值                  ┘
```

| 字段 | env 变量 | 默认值 |
|---|---|---|
| `apiKey` | `NOVA_API_KEY` | **必填**（缺失抛 `ConfigError`） |
| `baseURL` | `NOVA_BASE_URL` | `undefined`（走 Anthropic 官方） |
| `model` | `NOVA_MODEL` | `"claude-sonnet-4-5-20250929"` |
| `maxTokens` | — | `8192` |
| `maxTurns` | — | `25` |

**为什么 env 优先**：CI / 容器 / 临时切换 endpoint 场景更常用 env。

**为什么用 `NOVA_` 前缀而非 `ANTHROPIC_`**：避免和 Anthropic SDK 自己识别的 `ANTHROPIC_API_KEY` 冲突。用户可以同时保留两套配置：一套 nova-code 用，一套其它直用 SDK 的工具用。

### 1.3 两种类型：`PersistedConfig` vs `ResolvedConfig`

```ts
interface PersistedConfig {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly maxTurns?: number;
}
// 所有字段可选，对应"用户愿意写的就写"的松语义。

interface ResolvedConfig {
  readonly apiKey: string;               // 必填
  readonly baseURL: string | undefined;  // 可选
  readonly model: string;
  readonly maxTokens: number;
  readonly maxTurns: number;
}
// 所有字段都已确定，下游（QueryEngine / client.ts）直接用。
```

### 1.4 API 总览

```ts
// 计算路径（不做 IO）
function getConfigFilePath(source?: ConfigSource): string;       // ~/.nova-code/config.json
function getLogsDirPath(source?: ConfigSource): string;          // ~/.nova-code/logs

// 纯读：磁盘 → PersistedConfig；文件不存在返回 {}；JSON 坏 / 字段类型错抛 ConfigError
async function loadPersistedConfig(source?): Promise<PersistedConfig>;

// 纯写：PersistedConfig → 磁盘；会自动 mkdir -p 父目录
async function savePersistedConfig(config, source?): Promise<void>;

// 纯计算：PersistedConfig + env → ResolvedConfig；apiKey 缺失抛 ConfigError
function resolveConfig(persisted, source?): ResolvedConfig;

// 一站式：loadPersistedConfig + resolveConfig
async function loadConfig(source?): Promise<ResolvedConfig>;
```

**`loadConfig` 是唯一推荐的入口**。其它函数主要给测试与 `nova-code config`（M6+ 规划）用。

### 1.5 `ConfigSource` —— 测试注入

```ts
interface ConfigSource {
  readonly homeDir?: string;                                          // 覆盖 $HOME
  readonly env?: Readonly<Record<string, string | undefined>>;        // 覆盖 process.env
}
```

所有 config 函数都接收可选 `ConfigSource`，缺省走 `homedir()` 和 `process.env`。测试里传入 `{homeDir: tmpDir, env: {NOVA_API_KEY: "sk-test"}}` 即可完全隔离用户环境。

### 1.6 JSON 校验：手写 vs Zod

选型：**手写**。

```ts
function validatePersistedConfig(value: unknown, path: string): PersistedConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`Config at ${path} must be a JSON object, got ${typeName(value)}.`);
  }
  const obj = value as Partial<Record<keyof PersistedConfig, unknown>>;
  const result = { ... };
  if (obj.apiKey !== undefined) {
    if (typeof obj.apiKey !== "string") throw new ConfigError(...);
    result.apiKey = obj.apiKey;
  }
  // ... 每个字段依次校验
  return result;
}
```

理由：

- schema 极小（5 字段），引入 Zod 收益有限。
- 每条错误能拿到原值 + 期望类型，错误消息信息量大于 Zod 默认。
- 零依赖对 CLI 的 bundle 体积友好。

未来 schema 膨胀（接入 MCP 服务器配置、工具白名单等）再考虑 Zod。

---

## 2. 错误层次

### 2.1 5 个错误类

```
Error (内置)
├── AbortError                 src/errors/AbortError.ts
├── ConfigError                src/errors/ConfigError.ts
├── MaxTurnsExceededError      src/errors/MaxTurnsExceededError.ts
├── ToolExecutionError         src/errors/ToolExecutionError.ts
└── LLMApiError                src/services/api/errors.ts
```

为什么 `LLMApiError` 不在 `src/errors/`：它是 API 层专有语义（带 `status`、依赖 SDK 的 `APIError`）。`src/errors/` 保留给领域级错误。

### 2.2 每个错误的定义与用途

#### `AbortError`
```ts
class AbortError extends Error {
  constructor(message = "Operation aborted by user.") { super(message); }
}
```
- **何时抛**：用户 Ctrl+C → agent loop / tool 检查到 `signal.aborted` → 抛此错。SDK 的 `APIUserAbortError` 也会被归一成它。
- **退出码**：`130`（POSIX 惯例：128 + SIGINT=2）。
- **UI 表现**：stderr 一行 `ask: 已中断。`——不打堆栈（用户明知原因）。

#### `ConfigError`
```ts
class ConfigError extends Error { /* 无 extra 字段 */ }
```
- **何时抛**：API key 缺失 / 配置文件非 JSON / 字段类型错误 / 文件 IO 失败。
- **退出码**：`1`（再跑也没用，必须改环境）。
- **UI 表现**：stderr `ask: <message>`，消息自带修复指引（如"Set the NOVA_API_KEY environment variable, or write ..."）。

#### `MaxTurnsExceededError`
```ts
class MaxTurnsExceededError extends Error {
  readonly turns: number;
}
```
- **何时抛**：agent loop 跑到 `turn > maxTurns` 仍未拿到 `end_turn`。
- **退出码**：`2`（需要人工介入，可能要调大 `maxTurns` 或修 prompt）。
- **UI 表现**：`ask: Agent loop exceeded maxTurns=25. The model kept calling tools without producing a final answer.`

#### `ToolExecutionError`
```ts
class ToolExecutionError extends Error {
  readonly toolName: string;
  constructor(toolName, message, options?: { cause?: unknown });
}
```
- **何时抛**：工具内部 `input` 校验失败 / IO 失败 / 命令非法（Bash 硬黑名单）。
- **与 agent loop 的交互**：**不终止 loop**。`QueryEngine::describeToolError` 把 `.message` 取出来作为 `is_error=true` 的 tool_result 喂回模型。
- **退出码**：`2`（若最后从 agent loop 泄漏到 `runAskWithLLM`；正常情况下不会泄漏）。

#### `LLMApiError`
```ts
class LLMApiError extends Error {
  readonly status: number | undefined;
  constructor(message, options?: { status?: number; cause?: unknown });
}
```
- **何时抛**：`QueryEngine::normalizeSdkError` 把 SDK 的 `APIError` / 普通 `Error` 包成它。
- **`status`**：HTTP 状态码，便于 `isRetryableError` 和上层区分 4xx / 5xx。
- **`cause`**：原始 SDK 错误，debug 日志可追溯。
- **退出码**：`2`。`runAskWithLLM` 会额外在消息里带上 `(HTTP xxx)`。

### 2.3 错误 → 退出码矩阵

| 错误 | 退出码 | 含义 | 用户动作 |
|---|---|---|---|
| `AbortError` | `130` | 用户中断 | （自己按的，不需动作） |
| `ConfigError` | `1` | 配置错 | 修配置 / 改 env |
| `MaxTurnsExceededError` | `2` | 失控循环 | 调大 `maxTurns` / 重写 prompt |
| `LLMApiError` | `2` | 网络 / 服务错 | 查网络 / 等服务恢复 / 看 `status` |
| `ToolExecutionError`（若泄漏） | `2` | 工具异常 | 查日志 |
| 其它 `Error` | `2` | 未分类 | 开 `--debug` 查日志 |

映射位点只有一处：[src/commands/AskCommand/runAskWithLLM.ts :: handleAskError](../../src/commands/AskCommand/runAskWithLLM.ts)。新增错误类时同步在此处加分支。

### 2.4 错误归一化路径

```
SDK 层：
  APIError / fetch Error / APIUserAbortError
          ↓ (QueryEngine::normalizeSdkError)
  AbortError / LLMApiError

tool 层：
  ToolExecutionError / 任意 Error
          ↓ (QueryEngine::describeToolError)
  string → is_error=true 的 tool_result → 喂回模型

config 层：
  FS error / JSON.parse error
          ↓ (config.ts 自行抛)
  ConfigError

agent loop 层：
  turn > maxTurns
          ↓
  MaxTurnsExceededError

命令层：
  所有上面的错误
          ↓ (runAskWithLLM 的 try/catch)
  console.error + 退出码
```

---

## 3. "为什么不用错误码字符串 / 数字 code"

看起来更"专业"的做法：

```ts
class LLMApiError extends Error {
  readonly code: "RATE_LIMIT" | "OVERLOADED" | "TIMEOUT" | ...;
}
```

没这么做的原因：

1. **`instanceof` 足够清晰**：当前错误类数量少（5 个），`instanceof` 分支可读性比 switch(code) 好。
2. **HTTP `status` 就是现成的 code**：429 vs 503 已经表达了"是什么错"，不用再造一层。
3. **新增错误场景时加类而非加 code**：类的边界让重构更安全（TS 能全局查引用）。

---

## 4. 依赖关系

```
config/config.ts      ← errors/ConfigError.ts
                      ← errors/index.ts（聚合 re-export）
                      ← Node 标准库（fs/os/path）

errors/*              （零业务依赖）
errors/index.ts       ← 聚合 re-export

services/api/errors.ts （零依赖，除 Error）
```

`errors/` 和 `services/api/errors.ts` 是**叶子层**——整棵依赖图的根。任何层都可以 import 它们，它们不依赖任何其它业务模块。

---

## 5. 新增一个配置字段的 4 步

假设要加 `readonly temperature?: number;`：

1. `src/config/config.ts`：
   - `PersistedConfig` 加字段
   - `ResolvedConfig` 加字段（如果有默认值，类型写成必填 + 默认值；纯可选就 `number | undefined`）
   - `resolveConfig` 合并 env / persisted / default
   - `validatePersistedConfig` 加校验分支
2. 消费方（如 `QueryEngine.ts` 调 SDK 时）加读取
3. env 变量：`ENV_TEMPERATURE = "NOVA_TEMPERATURE"` + `resolveConfig` 里读
4. 测试：`src/config/config.test.ts` 加三个用例（env 覆盖 / 文件 / 默认）

---

## 6. 新增一个错误类的 3 步

1. `src/errors/FooError.ts`：
   ```ts
   export class FooError extends Error {
     override readonly name = "FooError";
     readonly fooField: string;
     constructor(fooField: string, message: string) {
       super(message);
       this.fooField = fooField;
     }
   }
   ```
2. `src/errors/index.ts`：`export { FooError } from "./FooError.ts";`
3. `src/index.ts`：在"错误体系"段里 `FooError` 加入 re-export（对外库用户可见）
4. `src/commands/AskCommand/runAskWithLLM.ts :: handleAskError`：加 `instanceof FooError` 分支 → 决定退出码与 stderr 输出

测试：对应抛错位点加用例即可；不必单测错误类本身（无逻辑可测）。
