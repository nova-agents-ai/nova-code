# 会话持久化（sessionId + sessionStore）

对应源文件：[sessionId.ts](src/commands/ChatCommand/sessionId.ts) +
[sessionStore.ts](src/commands/ChatCommand/sessionStore.ts)。

这两个模块承担 M2 的「会话落盘」能力：如何为每一场对话生成稳定 ID，如何把
`ChatSession` 的 `{ meta, messages[] }` 写到 JSONL 又能可靠读回来。

---

## 1. 为什么需要落盘

M2 支持三条恢复路径，全部建立在同一个 JSONL 文件格式之上：

| 触发入口 | 命令 | 文件定位方式 |
|---------|------|--------------|
| REPL 内主动保存 | `/save` 或 `/save <alias>` | 按 sessionId（+ 可选 alias 副本） |
| REPL 内主动加载 | `/load <idOrAlias>` | 按 idOrAlias 匹配文件名 |
| 进程启动时恢复 | `nova-code chat --resume <id|alias>` | 同上 |

目录统一：`~/.nova-code/sessions/*.jsonl`（由 `getSessionsDirPath()` 解析，可被 `ConfigSource` 注入替换）。

---

## 2. sessionId 格式与动机

```
<ISO-YYYY-MM-DDTHH-mm-ss>-<randomHex8>
例：2026-05-04T14-23-07-9a8b4c2d
```

### 2.1 前缀：秒级 ISO 时间

为什么不用 UUID v4？

- **字典序 = 时序**：`ls -1 ~/.nova-code/sessions` 的顺序天然是时间序，
  `| tail` 就能找到最近的几个会话；UUID v4 随机乱序，需要额外 stat 取 mtime 再排序
- **人眼可读**：出错场景用户 `ls` 就能读出"哪个会话是昨天下午的"

### 2.2 后缀：4 字节随机 hex

- 同秒并发（比如脚本连续 `nova-code chat`）不会撞 ID
- 只占 8 字符，不喧宾夺主
- 用 `node:crypto.randomBytes`，不引 uuid 依赖

### 2.3 为什么所有分隔都用 `-`（而非 `:`）

原生 ISO 字符串是 `2026-05-04T14:23:07`，冒号在 shell 里部分场景需要转义、Windows 文件名直接非法。
统一把 `HH:mm:ss` 写成 `HH-mm-ss`，全路径都是「字母数字 + 连字符 + T」，跨平台稳。

### 2.4 依赖注入

```ts
export function generateSessionId(
  now: Date = new Date(),
  random: (size: number) => Buffer = randomBytes,
): string;
```

单测通过传入固定 `now` 和桩 `random` 得到确定性 ID，不需要 fake timer 也不需要 mock 全局。

---

## 3. JSONL 格式

### 3.1 结构约定（对齐设计稿 §7.2）

```
{"kind":"meta","sessionId":"...","model":"...","createdAt":"..."}
{"kind":"msg","role":"user","content":"hello"}
{"kind":"msg","role":"assistant","content":[{"type":"text","text":"..."}]}
{"kind":"msg","role":"user","content":[{"type":"tool_result","tool_use_id":"tu_01","content":"ok"}]}
```

- 首行必须是 `kind:"meta"`，有且仅有一条
- 其余非空行都是 `kind:"msg"`；`role` 只允许 `user` / `assistant`
- 空白行（纯 `\n` 或空格）会被读入时直接跳过 —— 方便 vim 手工编辑后保留视觉间隔
- 文件以 `\n` 结尾（POSIX 工具 cat/tail 的友好约定）

### 3.2 为什么用 `kind` 字段做 discriminator

对照几种备选方案：

| 方案 | 问题 |
|------|------|
| 按行号判 `line === 0 ? meta : msg` | 未来想在中段插入 snapshot/summary marker 无法扩展 |
| meta 和 msg 字段重叠（`role` 可选） | `role` 在 msg 里必填 vs meta 里不存在，意图不清 |
| 分两个文件 `.meta.json` + `.msgs.jsonl` | 破坏「单文件 = 单会话」的心智，丢失原子性 |
| **`kind` 字段 discriminator** | 未来新增 kind 值（如 `summary`、`snapshot`）**不破坏老 reader** |

选后者。discriminator 对 TS 类型守卫也极友好：后续若要做
`type SessionLine = MetaLine | MsgLine | SummaryLine`，`kind` 天然就是 narrowing key。

### 3.3 is_error 的写出语义

msg 的 `content` 是 string 或 NovaContentBlock[]。当 block 是 `tool_result` 时：

```ts
{
  type: "tool_result",
  tool_use_id: event.toolUseId,
  content: event.content,
  ...(event.isError ? { is_error: true } : {}),
}
```

`is_error` 只有在 true 时才写出 —— 保持 NovaMessage 的"缺省即 false"语义，
不污染正常工具结果行的 JSON 结构。

---

## 4. saveSession：覆盖写 + 可选 alias 副本

```ts
export async function saveSession(
  idOrAlias: string,
  snapshot: SessionSnapshot,
  source: ConfigSource = {},
): Promise<string>
```

语义：

1. 先 `assertSafeFileName(idOrAlias)` —— 拒绝路径穿越
2. `mkdirSync(dir, { recursive: true })` —— 首次使用自动建目录
3. 把 meta + 所有 msg 序列化成一整块文本
4. `writeFile(path, ..., "utf8")` —— **覆盖写**，原子替换

### 4.1 为什么用覆盖写而不是 append

M2 目标是最稳的"整份快照"形态。append 协议的问题：

- 断电/abort 时半条 JSONL 会污染文件（下次 load 抛 parse 错）
- 同一会话 meta 不变，每行追加会多个"meta 重复"的历史包袱
- 未来若要做「压缩历史消息」功能，append 很难改成幂等

性能不是瓶颈：单次 write 一份快照的数据量 = 当前对话完整内容，
写盘时间远小于 LLM 一轮耗时。M14 如真要持续 append 再设计增量协议。

### 4.2 alias 副本 = 文件副本（不用 symlink）

`/save main-feature` 会产生两份文件：

```
~/.nova-code/sessions/2026-05-04T14-23-07-9a8b4c2d.jsonl   ← 始终按 sessionId 写
~/.nova-code/sessions/main-feature.jsonl                   ← alias 副本
```

不用 symlink 的原因：

- Windows 需要管理员权限才能建 symlink，跨平台方案优先
- 占空间可忽略（会话 JSONL 通常几 KB ~ 几百 KB）
- 用户手动 `rm` alias 文件不会误伤主文件

alias 文件只在 `/save <alias>` 时更新；之后 `/save`（不带 alias）只写主文件。
想让 alias 跟着走就每次都带 alias 参数。

---

## 5. loadSession：行级容错解析

```ts
export async function loadSession(
  idOrAlias: string,
  source: ConfigSource = {},
): Promise<SessionSnapshot>
```

解析策略：

```
for each line i in file:
  trimmed = line.trim()
  if trimmed === "" → skip            ← 空行容忍
  parsed = JSON.parse(trimmed)
  if parse fails → throw "Invalid JSONL at <path>:<i+1>: <err>"
  switch (parsed.kind):
    case "meta":
      if 已有 meta → throw "Duplicate meta at line ..."
      meta = readMeta(parsed, path, i+1)   ← 校验 sessionId/model/createdAt 非空
    case "msg":
      if 尚未有 meta → throw "Expected first line to be meta ..."
      messages.push(readMessage(parsed, path, i+1))  ← 校验 role + content 类型
    default:
      throw "Unknown kind=<x> at line ..."

if meta === undefined → throw "Empty or meta-less session file"
```

关键设计：

- **所有错误都带 `path:lineNo`**，便于用户 `vim +<lineNo> <path>` 直接跳到出错行
- **校验深度浅**：msg 的 content 不做 block 级递归校验；约定 "写入方（ChatSession）
  只产出合法结构"，读入方只守住外层 shape。这样既抵御人工手改导致的 JSON 损坏，又不过度设计。
  如果 content 结构真有问题，Anthropic SDK 在 request 阶段会给出清晰错误。
- **`noPropertyAccessFromIndexSignature` 规避**：先 cast 为
  `Partial<Record<keyof SessionMeta, unknown>>` 再访问，才能 `known.sessionId`
  而不写 `obj["sessionId"]`；顺便绕过 biome 的 useLiteralKeys 投诉。

---

## 6. assertSafeFileName：防目录穿越

```ts
function assertSafeFileName(name: string): void {
  if (name === "") throw "session id/alias must not be empty";
  if (name.includes("/") || name.includes("\\") || name.includes(".."))
    throw `unsafe session id/alias: ${name} (no path separators allowed)`;
  if (name.startsWith(".")) throw `session id/alias must not start with '.'`;
}
```

三条规则覆盖常见攻击面：

| 规则 | 阻止的输入 |
|------|-----------|
| 无分隔符 | `../../etc/passwd`、`foo/bar`、`C:\Windows` |
| 不以 `.` 开头 | `.ssh`、`.config`、`.` 本身 |
| 非空 | 一个空字符串会被 `join(dir, ".jsonl")` 解析为目录本身 |

调用点：saveSession 和 loadSession 入口各一次，防线前置。

---

## 7. SessionSnapshot 与 ChatSession 的关系

```ts
interface SessionSnapshot {
  readonly meta: SessionMeta;
  readonly messages: readonly NovaMessage[];
}
```

这个类型是 sessionStore 唯一对外暴露的数据结构，串起两条流：

```
/save 路径：
  ChatSession.snapshot() ──► messages[]
  ChatSession.meta       ──► meta
  合并后 → { meta, messages } → saveSession → 落盘

/load 路径：
  loadSession → { meta, messages }
  ChatSession.restore(meta, messages)    ← ChatSession 接管
```

注意 `snapshot.messages` 是 `readonly NovaMessage[]`；ChatSession 在
`restore` 里会 `[...messages]` 拷贝一份，防止外部持有引用后回头改。

---

## 8. --resume 与 /load 的共同路径

两个入口走的 loadSession 完全相同，区别只在时机：

- **--resume**：[ChatCommand.ts#resumeSession](src/commands/ChatCommand/ChatCommand.ts) 在 REPL 启动前调 loadSession，
  把结果直接 `new ChatSession(meta, messages)`
- **/load**：[slash/load.ts](src/commands/ChatCommand/slash/load.ts) 在 REPL 中调 loadSession，再通过
  `session.restore(meta, messages)` 原地替换

`/load` 比 --resume 多一层保险：若当前会话 `messages.length > 0`，会先用
`io.confirm("当前会话将被替换，继续？(y/n)")` 问一遍，防止用户误覆盖正在进行的对话。

---

## 9. 测试覆盖

- [sessionId.test.ts](src/commands/ChatCommand/sessionId.test.ts)：
  - 注入固定 now/random 得到确定性 ID
  - 格式正则断言（`YYYY-MM-DDTHH-mm-ss-<8hex>`）
  - 边界：月/日/时/分/秒的补零
- [sessionStore.test.ts](src/commands/ChatCommand/sessionStore.test.ts)：
  - 往返：save 后 load 得到相同 snapshot
  - alias 写出两份文件
  - 缺 meta 行 / 重复 meta / 未知 kind / 非法 JSON → 抛带行号错
  - assertSafeFileName 的三类拒绝
  - 空白行容忍（读入时跳过）
  - is_error 字段条件写出

---

## 10. 下一步

- 这两份文件是如何被斜杠命令调用的：[slash-commands.md](./slash-commands.md)
- 恢复后 ChatSession 怎么用这些 messages 作为 initialMessages：
  [chat-session.md](./chat-session.md)
