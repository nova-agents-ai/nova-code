# 07 · Testing —— 测试策略与 LLM Mock

> 对应文件：`src/**/*.test.ts`（14 个测试文件，总计 ~4500 行）+ [scripts/mock-anthropic.ts](../../scripts/mock-anthropic.ts)

---

## 1. 测试全景

```
src/
├── cli.test.ts                        340 行   runCli 分发 / --help / --version / 未知命令
├── commands.test.ts                   221 行   builtinCommands / findCommand / parseAskFlags / debug sink
├── tools.test.ts                       98 行   builtinTools / findTool 注册表
│
├── QueryEngine.test.ts                502 行   agent loop 主循环（mock SDK）
├── integration.test.ts                818 行   agent loop × 真工具 × 真文件系统
│
├── config/config.test.ts              236 行   load / save / resolve 三层优先级
├── services/api/withRetry.test.ts     228 行   退避 / Retry-After / signal / 分类
│
└── tools/<X>/<X>.test.ts            合计 ~2000 行   单工具行为
```

**测试金字塔（由下到上，数量递减）**：

```
       ┌────────────────────┐
       │  integration.test  │   1 份，跨工具 + agent loop + 真 IO
       ├────────────────────┤
       │  module tests      │   cli / commands / QueryEngine / config / withRetry
       ├────────────────────┤
       │  tool unit tests   │   7 份，每工具覆盖正常 / 截断 / 失败 / abort
       └────────────────────┘
```

每层都遵循同一准则：**外部依赖只 mock 一层**。`QueryEngine.test.ts` mock SDK；`integration.test.ts` mock SDK + 真文件系统；工具单测不 mock（直接跑 tmp 目录）。

---

## 2. 运行命令

```bash
# 全量
bun test

# 单文件
bun test src/QueryEngine.test.ts

# 按名字筛选
bun test -t "maxTurns"

# Watch 模式
bun run test:watch
```

**三绿门槛**（CI 起步卡的最低线）：

```bash
bun run typecheck      # tsc --noEmit
bun run check          # biome check .
bun test
```

pre-publish 钩子 `prepublishOnly` 会串起这三条 + build。

---

## 3. Mock LLM 的两条路径

### 3.1 单测路径：`FakeClient`（进程内对象 mock）

```ts
interface ScriptedTurn {
  readonly textChunks: readonly string[];        // 流式 text_delta 的每一片
  readonly toolUses?: readonly {                 // 本轮产生的 tool_use 块
    readonly id: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
  }[];
  readonly stopReason: SdkMessage["stop_reason"];  // "end_turn" / "tool_use" / ...
}

function makeFakeClient(turns: readonly ScriptedTurn[]): {
  client: Anthropic;
  calls: FakeStreamCall[];
};
```

**形状**：冒充 SDK 的 `.messages.stream(...)`，返回对象同时实现 `[Symbol.asyncIterator]` 和 `finalMessage()`。

**调用方式**：`runAgentLoop({..., client: fakeHandle.client})`——通过 `AgentLoopParams.client` 的 DI 入口直接替换。

**用途**：

- 验证多轮循环、事件顺序、tool_use 分发、maxTurns 边界（`QueryEngine.test.ts`）
- 验证 7 工具在真 FS 上的串联（`integration.test.ts`）

**优点**：

- 零进程启动开销（全在 bun test 主进程）
- 完全控制 turn 序列
- 触发错误场景直接 `throw`（不必造真实网络错）

**约束**：

- 不走真实 SSE / HTTP，不能验证 SDK 自身行为（SDK 版本锁在 `package.json` 里）
- 不能用于跨进程场景（`cli.test.ts` 起子进程的部分不适用）

### 3.2 集成路径：`scripts/mock-anthropic.ts`（本地 HTTP 服务器）

```
bun run mock                                              # 默认 0.0.0.0:8787

另一终端：
NOVA_API_KEY=anything NOVA_BASE_URL=http://localhost:8787 \
  bun run start -- ask --debug "hi"
```

真 HTTP + SSE 流，SDK 走正常代码路径（包括重试、超时、错误分类）。

**剧本通过 query 参数选择**：
- `?scenario=simple`（默认）：单轮 `end_turn`，纯文本答复
- `?scenario=tool`：首轮返回 `tool_use(LS)`；收到 `tool_result` 后再返回 `end_turn`
- `?scenario=edit-loop`：Grep → FileEdit → Bash → end_turn 的完整写权闭环。
  - 工作目录由环境变量 `MOCK_EDIT_WORKDIR` 指定

**自动轮次判断**：通过对话历史中是否已出现 `tool_result` 块判断"第几轮请求"，调用方不必显式切换 scenario。

**不做**：鉴权、真实 usage 统计、多模态、非流式。nova-code 只走 stream 路径。

**用途**：

- 手动端到端冒烟
- CI 中可选作 smoke test（当前未接入 CI，开发手动跑）
- 未来回归真实二进制 / 真实 SDK 升级的验证点

---

## 4. 测试范式

### 4.1 `runAgentLoop` 的标准消费

```ts
const events: AgentEvent[] = [];
const generator = runAgentLoop({ config, userPrompt, tools, client });
let final: NovaMessage | undefined;
while (true) {
  const { value, done } = await generator.next();
  if (done) { final = value; break; }
  events.push(value);
}

// 断言事件顺序
expect(events.map(e => e.type)).toEqual([
  "turn_start",
  "text_delta", "text_delta",
  "turn_end",
  "tool_call",
  "tool_result",
  "turn_start",
  "text_delta",
  "turn_end",
  "done",
]);

// 断言最终 message
expect(final?.role).toBe(MessageRoleEnum.ASSISTANT);
```

### 4.2 `withRetry` 的零等待测试

```ts
const sleeps: number[] = [];
const fn = jest.fn()
  .mockRejectedValueOnce(new LLMApiError("rate limit", { status: 429 }))
  .mockResolvedValueOnce("ok");

const result = await withRetry(fn, {
  sleep: async (ms) => { sleeps.push(ms); },
});

expect(result).toBe("ok");
expect(fn).toHaveBeenCalledTimes(2);
expect(sleeps[0]).toBeGreaterThanOrEqual(375);  // 500 ±25%
expect(sleeps[0]).toBeLessThanOrEqual(625);
```

关键是 `sleep` 注入——让"等 500ms"在测试里变成"记下 500"。

### 4.3 `config` 的隔离测试

```ts
const tmpHome = await mkdtemp(join(tmpdir(), "nova-cfg-"));
try {
  await savePersistedConfig({ apiKey: "sk-test" }, { homeDir: tmpHome });
  const resolved = await loadConfig({
    homeDir: tmpHome,
    env: { NOVA_MODEL: "claude-haiku" },  // 覆盖文件里的 model
  });
  expect(resolved.apiKey).toBe("sk-test");
  expect(resolved.model).toBe("claude-haiku");
} finally {
  await rm(tmpHome, { recursive: true, force: true });
}
```

`ConfigSource` 的 DI 让测试完全不碰 `$HOME`。

### 4.4 工具单测在 tmpdir 中跑真 IO

```ts
let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "nova-tool-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

test("FileEdit: old_string 唯一时执行替换", async () => {
  const path = join(workdir, "a.txt");
  await writeFile(path, "foo\nbar\nfoo2\n");
  const result = await FileEditTool.execute(
    { path, old_string: "bar", new_string: "BAR" },
    { signal: new AbortController().signal },
  );
  expect(result).toContain("1 replacement");
  expect(await readFile(path, "utf8")).toBe("foo\nBAR\nfoo2\n");
});
```

**约束**：

- 每个测试独立 `mkdtemp`，避免并发串扰
- `afterEach` 清理 tmp；用 `{ force: true }` 忽略"已被测试自己删掉"的情况
- 涉及 `BashTool` 的超时用例传入较短 timeout（如 `timeout_ms: 1000`）避免慢测试

### 4.5 `runCli` 的跨进程测试

```ts
import { $ } from "bun";
const proc = await $`bun run bin/nova-code.ts hello dinglevin`.quiet();
expect(proc.exitCode).toBe(0);
expect(proc.stdout.toString()).toContain("Hello, dinglevin!");
```

或 progamtic：

```ts
const exitCode = await runCli({
  argv: ["hello", "dinglevin"],
  commands: builtinCommands,
});
expect(exitCode).toBe(0);
```

progamtic 更快；跨进程仅用于验证真实二进制 / stdio 语义。

---

## 5. 测试文件速览

| 文件 | 行数 | 关键用例 |
|---|---|---|
| `cli.test.ts` | 340 | 无参 / --help / --version / 未知命令 / 命令抛错兜底 |
| `commands.test.ts` | 221 | builtinCommands 内容 / findCommand / parseAskFlags 分支 / debugSink 文件名 + pretty 格式 |
| `tools.test.ts` | 98 | builtinTools 长度与顺序 / findTool 命中与未命中 |
| `QueryEngine.test.ts` | 502 | turn_start/end/done 顺序 / tool_use 并发 / tool 抛错 → is_error / abort / maxTurns / SDK APIError 归一 |
| `integration.test.ts` | 818 | edit-loop 4 轮 / LS+FileRead / Bash / Grep / Glob 各一用例 |
| `config/config.test.ts` | 236 | 三层优先级 / JSON 坏 / 类型错 / 新建 config dir |
| `services/api/withRetry.test.ts` | 228 | 成功立即返回 / 可重试 / 不可重试 / abort / Retry-After / maxAttempts 耗尽 / computeDelayMs |
| `tools/BashTool/BashTool.test.ts` | 321 | 正常执行 / 硬黑名单 / 软警告 / 超时三段式 / cwd 5 分支 / 大输出截断 |
| `tools/FileEditTool/FileEditTool.test.ts` | 604 | old_string 唯一 / N=0 拒绝 / N>1 拒绝 / replace_all / no-op 拒绝 / 原子写 / hunks 截断 |
| `tools/FileWriteTool/FileWriteTool.test.ts` | 302 | 创建成功 / 已存在拒绝 / 上限 / 自动 mkdir / abort |
| `tools/FileReadTool/FileReadTool.test.ts` | 64 | 正常读 / 截断 / 非文件 / 不存在 |
| `tools/LSTool/LSTool.test.ts` | 68 | 正常列 / 上限 / 非目录 / 不存在 |
| `tools/GrepTool/GrepTool.test.ts` | 391 | rg 可用 / rg fallback / 黑名单 / 单行截断 / 匹配数截断 |
| `tools/GlobTool/GlobTool.test.ts` | 314 | 模式匹配 / 黑名单跳过 / mtime 排序 / 结果上限 |

---

## 6. 知识缺口 / 坑位

### 6.1 `BashTool` 软警告 flaky
M1 残留。`BashTool` 的"软警告前缀严格匹配且仅出现一次"用例在 `bun test` 全量跑时偶发 5000 ms timeout，但单跑 `bun test src/tools/BashTool/BashTool.test.ts` 稳过。
**策略**：在 [docs/design/M1.5-refactor.md §7](../design/M1.5-refactor.md) 登记为残债，M1.5 未修。

### 6.2 `FakeClient` 当前在两处各复制一份
- `QueryEngine.test.ts` 与 `integration.test.ts` 各实现了等价的 `makeFakeClient` / `makeFakeStream`。
- 两份形状相同但 scripted turn 详细度不同。未来可以抽到 `src/test-helpers/fakeClient.ts`（目前不做，避免引入仅测试用的共享代码）。

### 6.3 `scripts/mock-anthropic.ts` 未进 CI
目前只供手动冒烟。若要在 CI 跑，需在 workflow 中 `bun run mock &` + 等端口 ready 后再跑 `bun test`。

### 6.4 没有覆盖率门槛
bun test 支持 `--coverage`，但当前没卡门槛。引入时建议：line coverage ≥ 80%，但不把覆盖率当成目标（会诱导写无意义测试）。

---

## 7. 写新测试的清单

1. **找合适的测试文件**：新增的是工具行为 → `src/tools/<X>/<X>.test.ts`；跨工具/agent 交互 → `src/integration.test.ts`；agent loop 自身 → `src/QueryEngine.test.ts`。
2. **不 mock 自己改的那层**：改工具的测不要 mock 工具；改 agent loop 的测不要 mock agent loop。mock SDK / mock 文件系统在边界上做。
3. **tmpdir 要清理**：`afterEach` 固定套一层 `rm -rf` + `{ force: true }`。
4. **avoid 时间依赖**：`withRetry` 类测试用 `sleep` 注入；涉及 `Date.now()` 的用 `Bun.now` + mock（或直接传入参数）。
5. **先写失败用例**：修 bug / 加功能前先写一个会 fail 的测试；修好后看它变绿，再补其他用例。

---

## 8. 调试技巧

### 8.1 `--debug` 模式读 agent loop 日志
```bash
NOVA_API_KEY=... bun run start -- ask --debug-pretty "你的问题"
# stderr 会打印 [debug] log file: /Users/.../ask-2026-05-04T15-11-23-42649.log
```

日志里能看到每一轮的 `config_loaded` / `turn_start` / `text_delta` / `tool_call` / `tool_result` / `turn_end` / `done`，结合 `docs/architecture/agent-loop.md` 的事件表定位问题。

### 8.2 `scripts/mock-anthropic.ts` 定位真实链路问题
如果怀疑某个 bug 只在真实 HTTP 路径触发，起 mock 服务器后跑 `ask`——既能复现又无需真实 API key。

### 8.3 `bun test --timeout 30000`
某些工具测试（Bash 超时、rg 子进程）默认 5000 ms 不够。本仓库单测里已手动配置了 timeout 的地方就近，全量跑时如偶发 flaky 可临时提高。

---

以上构成 nova-code 当前（M1.5 完成后）的完整测试体系。配合 [overview.md](./overview.md) 的调用链图，能够在任意修改后快速定位需要加 / 改的测试。
