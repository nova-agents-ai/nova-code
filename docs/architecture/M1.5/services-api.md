# 05 · Services API —— LLM 客户端 / 重试 / 错误

> 对应目录：[src/services/api/](../../src/services/api)
>
> 四个文件：[client.ts](../../src/services/api/client.ts)（43 行）/ [errors.ts](../../src/services/api/errors.ts)（22 行）/ [errorUtils.ts](../../src/services/api/errorUtils.ts)（153 行）/ [withRetry.ts](../../src/services/api/withRetry.ts)（177 行）

---

## 1. 职责边界

```
┌────────────────────────────────────────────────────┐
│                  services/api/                     │
│  ─────────────────────────────────────────────     │
│  client.ts      构造 Anthropic SDK 实例            │
│  errors.ts      LLMApiError（SDK 错误的薄包装）    │
│  errorUtils.ts  可重试分类 / Retry-After 解析      │
│  withRetry.ts   指数退避 + 抖动 + Retry-After      │
└────────────────────────────────────────────────────┘
```

**为什么叫 `services/api`**：对齐 claude-code 的 `src/services/api/` 同位命名。nova-code 当前只支持 Anthropic 官方 API，这个目录未来可能扩展出 `bedrock` / `vertex` 等子目录；保留 `api` 作为默认子路径。

**不做什么**（M12+ 多 provider 阶段再加）：
- OAuth 自动刷新
- Bedrock / Vertex / Foundry 适配
- SSL/TLS 错误细分类
- Fast mode cooldown / RL 状态机
- 自定义 headers / session id 注入

---

## 2. `client.ts` —— SDK 薄封装

```ts
const DEFAULT_MAX_RETRIES = 2;         // SDK 内部重试次数
const DEFAULT_TIMEOUT_MS = 600_000;    // 10 分钟（流式够用）

function createAnthropicClient(config: ResolvedConfig): Anthropic {
  const options = {
    apiKey: config.apiKey,
    maxRetries: DEFAULT_MAX_RETRIES,
    timeout: DEFAULT_TIMEOUT_MS,
  };
  if (config.baseURL !== undefined) {
    options.baseURL = config.baseURL;
  }
  return new Anthropic(options);
}
```

几个点：

- **同步函数**：SDK 构造不发起网络请求，不需要 `await`。
- **SDK 自带 2 次重试**：覆盖瞬时抖动。上层如果还要重试，用 `withRetry` 包一层（但要注意双层重试带来的放大效应——见 §5）。
- **`baseURL` 仅在显式配置时传**：默认连 Anthropic 官方；测试或自托管代理时可指向 `scripts/mock-anthropic.ts` 这类 mock server。
- **不注入自定义 headers**：避免泄漏 session id / 用户名等标识符。

---

## 3. `errors.ts` —— `LLMApiError`

```ts
class LLMApiError extends Error {
  override readonly name = "LLMApiError";
  readonly status: number | undefined;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.status = options.status;
  }
}
```

**用法**：当 SDK 抛 `APIError` / 普通 `Error` 时，`QueryEngine.ts::normalizeSdkError` 统一包装成 `LLMApiError`，保留原 `status` 和 `cause`。

上层捕获时可按 `status` 区分 4xx 与 5xx：

```ts
catch (e) {
  if (e instanceof LLMApiError) {
    if (e.status !== undefined && e.status >= 400 && e.status < 500) {
      // 用户问题：API key 失效、模型名错、payload 太大
    } else {
      // 服务端/网络问题：可以让用户重试
    }
  }
}
```

---

## 4. `errorUtils.ts` —— 错误分类

### 4.1 `isAbortLikeError(error)`

判断三种"用户主动中断"：

| 条件 | 含义 |
|---|---|
| `error instanceof AbortError` | nova-code 自己抛的 |
| `error instanceof APIUserAbortError` | SDK 在 `signal.aborted` 时抛的 |
| `error.name === "AbortError"` | Web `AbortController` 原生错误（兜底） |

**中断永远不重试**——否则用户按 Ctrl+C 后还看到重试日志，违反直觉。

### 4.2 `isRetryableError(error)`

分三层判断：

```
abort-like  →  false
LLMApiError  → status ∈ {429, 502, 503, 504, 529} ? true : false
APIError     → 同上
Error with .code ∈ {ECONNRESET, ECONNREFUSED, ETIMEDOUT,
                    ENETUNREACH, EAI_AGAIN, EPIPE} → true
其它          → false
```

**可重试 status 的选择**：

| Code | 含义 | 为什么可重试 |
|---|---|---|
| `429` | Too Many Requests | 通常伴随 `Retry-After`，退避后大概率成功 |
| `502` | Bad Gateway | 上游网关临时故障 |
| `503` | Service Unavailable | 服务端过载 |
| `504` | Gateway Timeout | 上游超时 |
| `529` | Overloaded | Anthropic 专用（claude-code 也纳入） |

**明确不重试**：

| Code | 含义 | 理由 |
|---|---|---|
| `400` | Bad Request | payload 有问题，重试不会变对 |
| `401` | Unauthorized | API key 错 |
| `403` | Forbidden | 权限/配额耗尽 |
| `404` | Not Found | 模型名或 endpoint 错 |

网络层错误（`.code` 属性）走 libuv / OpenSSL 常见异常集合，典型瞬时故障可重试。

### 4.3 `getRetryAfterMs(error)`

从 `Retry-After` 头解析毫秒数：

```
支持：  Retry-After: 120          → 120000 ms
       Retry-After: 0.5           → 500 ms
不支持： Retry-After: Wed, 21 Oct 2015 ...   → undefined (fallback 到指数退避)
```

**两种 headers 格式都认**：

- Web Fetch `Headers` 对象（生产 SDK 用）：`.get("retry-after")`
- `Record<string, string>`（轻量 mock / 单测用）：不区分大小写查找

同时也会从 `LLMApiError.cause`（若 cause 是 `APIError`）上取，一层 unwrap 足够。

---

## 5. `withRetry.ts` —— 指数退避

### 5.1 入口

```ts
function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options?: WithRetryOptions,
): Promise<T>;

interface WithRetryOptions {
  readonly maxAttempts?: number;   // 默认 3
  readonly initialDelayMs?: number; // 默认 500
  readonly maxDelayMs?: number;     // 默认 16_000
  readonly signal?: AbortSignal;
  readonly sleep?: (ms, signal?) => Promise<void>;  // 测试注入
}
```

| 常量 | 值 | 备注 |
|---|---|---|
| `DEFAULT_MAX_ATTEMPTS` | `3` | 第 1 次是原始调用，之后最多再 2 次 |
| `DEFAULT_INITIAL_DELAY_MS` | `500` | attempt=2 前的基准延迟 |
| `DEFAULT_MAX_DELAY_MS` | `16_000` | 指数封顶，避免爆炸 |

### 5.2 主流程

```
for attempt in 1..maxAttempts:
    if signal.aborted: throw AbortError
    try:
        return await fn(attempt)
    catch error:
        lastError = error

        if isAbortLikeError(error):  throw error          # 中断 → 立刻抛
        if !isRetryableError(error): throw error          # 非可重试 → 立刻抛
        if attempt == maxAttempts:   throw error          # 用完重试 → 抛原错

        delay = computeDelayMs({attempt, retryAfterMs: getRetryAfterMs(error), ...})
        await sleep(delay, signal)

        if signal.aborted: throw AbortError               # 等待中被中断
```

关键点：

1. **`retryAfterMs` 优先级最高**：服务端说等多久就等多久（不抖动、不封顶，尊重上游建议）。
2. **否则指数退避**：`initialDelayMs * 2^(attempt-1)`，封顶 `maxDelayMs`，叠加 ±25% 抖动（抵御 thundering herd）。
3. **两次 `signal.aborted` 检查**：一次在 attempt 入口、一次在 `sleep` 后——覆盖等待期被中断的场景。
4. **`sleep` 可注入**：默认 `setTimeout + addEventListener("abort")`；测试时用 `jest.fn` 风格注入同步 resolve，让测试不实际等待。

### 5.3 延迟计算

```ts
function computeDelayMs({ attempt, initialDelayMs, maxDelayMs, retryAfterMs }): number {
  if (retryAfterMs !== undefined) return retryAfterMs;   // 尊重服务端
  const exp = initialDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exp, maxDelayMs);
  const jitter = capped * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.floor(capped + jitter));
}
```

默认参数下的序列（近似，不含抖动）：

| attempt | base delay | 含抖动区间 |
|---|---|---|
| 2 之前 | 500 ms | [375, 625] ms |
| 3 之前 | 1000 ms | [750, 1250] ms |

### 5.4 默认 `sleep`

```ts
function defaultSleep(ms, signal?): Promise<void> {
  return new Promise(resolve => {
    if (ms <= 0) { resolve(); return; }
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); resolve(); };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
```

注意**被 abort 时走 `resolve()` 而非 `reject`**——`withRetry` 内部在 `await sleep(...)` 后会再检查一次 `signal.aborted` 抛 `AbortError`，两边保持"单一抛错位点"，简化控制流。

---

## 6. 当前 `withRetry` 与 QueryEngine 的关系

**M1.5 状态**：`QueryEngine.ts` 的 `client.messages.stream(...)` 没有用 `withRetry` 包装。`createAnthropicClient` 只把 SDK 的 `maxRetries` 设为 2。

**为什么**：

- 流式调用 retry 要求重建 stream 对象，不只是重跑 fn。SDK 已经做了这件事，复用就行。
- 用户感知的"重试时延"已经由 SDK 承担；再套一层会让超时 / Retry-After 判定的定位点模糊。

**`withRetry` 的价值**：

- M2 调度器做批量请求时（如 compact session → summarize），按"会话级"粒度退避。
- 非流式的辅助请求（将来可能有的 embedding / token count）。
- 工具内部做幂等 HTTP 调用（如某些 LSP 工具）。

---

## 7. 双层重试的放大效应

如果未来既用 SDK `maxRetries=2`、又用 `withRetry maxAttempts=3`，则：

```
外层 withRetry:  attempt 1 → SDK 失败 3 次（1 + 2 retry）   → 外层等 500 ms
               attempt 2 → SDK 失败 3 次                   → 外层等 1000 ms
               attempt 3 → SDK 失败 3 次                   → 抛出
总共 9 次实际 HTTP 调用 + 1.5 秒外层等待 + SDK 内部退避时间
```

接入 `withRetry` 时要么把 SDK `maxRetries` 设为 0，要么理解这个放大。

---

## 8. 依赖关系

```
services/api/client.ts       ← config/config.ts
                             ← @anthropic-ai/sdk
services/api/errors.ts       （零依赖，除 Error）
services/api/errorUtils.ts   ← errors/AbortError.ts
                             ← ./errors.ts (LLMApiError)
                             ← @anthropic-ai/sdk (APIError/APIUserAbortError)
services/api/withRetry.ts    ← errors/AbortError.ts
                             ← ./errorUtils.ts
```

`services/api/` 的四个文件 **不依赖** `QueryEngine.ts` / `commands/` / `tools/`——它是纯的"API 层工具箱"，上层按需 import。

---

## 9. 测试

- [withRetry.test.ts](../../src/services/api/withRetry.test.ts)：`sleep` / `signal` / `isRetryableError` 的所有分支、`Retry-After` 头优先级、maxAttempts 边界。
- `errorUtils` 的分类逻辑会在 `QueryEngine.test.ts` / `integration.test.ts` 的 retry 场景中隐式被覆盖。

关键测试范式：注入 mock `sleep` 让测试零等待：

```ts
const sleeps: number[] = [];
await withRetry(fn, {
  sleep: async (ms) => { sleeps.push(ms); },
});
expect(sleeps).toEqual([500, 1000]);  // 忽略抖动用 toBeCloseTo 或 range check
```

见 [testing.md](./testing.md) 获取全面的测试策略。
