# M10 使用手册 — Hooks 系统

> 面向终端用户 / 新人上手。M10 支持在工具调用前后执行本地 command hook，用于审计、策略阻断、输入改写与结果改写。

---

## 1. 前置条件

- Bun >= 1.3；
- 已配置 `NOVA_API_KEY`，或用 `NOVA_TRANSPORT=mock` 做本地验证；
- 能编辑 `~/.nova-code/config.json`。

M10 hooks 会执行本地命令。只配置你信任的脚本；不要把项目中不可信的脚本直接放进 hooks。

---

## 2. 最小配置

创建一个 PreToolUse hook，记录所有 Bash 调用：

```bash
mkdir -p ~/.nova-code/hooks
cat > ~/.nova-code/hooks/log-pre.ts <<'TS'
const input = await new Response(Bun.stdin.stream()).json();
await Bun.write(
  `${process.env.HOME}/.nova-code/hook-pre.log`,
  `${JSON.stringify(input)}\n`,
);
TS
```

编辑 `~/.nova-code/config.json`：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "bun run ~/.nova-code/hooks/log-pre.ts" }
        ]
      }
    ]
  }
}
```

> 注意：shell 是否展开 `~` 取决于平台与 shell。若遇到路径问题，建议写绝对路径。

---

## 3. 阻断工具调用

hook 退出码为 `2` 会阻断工具执行：

```ts
// ~/.nova-code/hooks/block-force-push.ts
const input = await new Response(Bun.stdin.stream()).json();
const command = input.tool_input?.command ?? "";
if (typeof command === "string" && command.includes("push --force")) {
  console.error("force push is blocked by local hook policy");
  process.exit(2);
}
```

配置：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "bun run /ABS/PATH/block-force-push.ts" }
        ]
      }
    ]
  }
}
```

模型会收到 `is_error=true` 的 tool_result，内容类似：

```text
Hook blocked: force push is blocked by local hook policy
```

---

## 4. 改写工具输入

PreToolUse 可通过 stdout JSON 返回 `updatedInput`：

```ts
const input = await new Response(Bun.stdin.stream()).json();
if (input.tool_name === "Bash" && input.tool_input?.command === "git status") {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { command: "git status --short" }
    }
  }));
}
```

改写后的输入会继续进入权限系统，因此 hook 不能绕过 M3 的危险命令拦截。

---

## 5. 改写工具结果

PostToolUse 可返回 `updatedOutput`：

```ts
const input = await new Response(Bun.stdin.stream()).json();
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    updatedOutput: `[audited]\n${input.tool_response}`
  }
}));
```

或追加 `additionalContext`：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Local policy: tool result was audited."
  }
}
```

---

## 6. Matcher 与 timeout

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|FileEdit", "hooks": [{ "type": "command", "command": "..." }] },
      { "matcher": "^MCP__.*", "hooks": [{ "type": "command", "command": "...", "timeout": 3 }] },
      { "matcher": "*", "hooks": [{ "type": "command", "command": "...", "if": "Bash(git *)" }] }
    ]
  }
}
```

- `timeout` 单位是秒；默认 30 秒；
- `if` 是轻量过滤，适合避免不必要的进程启动；
- 同一工具匹配到的 hooks 串行执行，保证改写结果确定。

---

## 7. 端到端可复制验证脚本

```bash
set -euo pipefail
TMP_HOME="$(mktemp -d)"
mkdir -p "$TMP_HOME/.nova-code/hooks"

cat > "$TMP_HOME/.nova-code/hooks/pre.ts" <<'TS'
const input = await new Response(Bun.stdin.stream()).json();
await Bun.write(`${process.env.HOME}/pre.json`, JSON.stringify(input, null, 2));
TS

cat > "$TMP_HOME/.nova-code/hooks/post.ts" <<'TS'
const input = await new Response(Bun.stdin.stream()).json();
await Bun.write(`${process.env.HOME}/post.json`, JSON.stringify(input, null, 2));
console.log(JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PostToolUse",
  updatedOutput: "HOOKED_TODO_OUTPUT"
}}));
TS

cat > "$TMP_HOME/.nova-code/config.json" <<JSON
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "TodoWrite", "hooks": [{ "type": "command", "command": "bun run $TMP_HOME/.nova-code/hooks/pre.ts" }] }
    ],
    "PostToolUse": [
      { "matcher": "TodoWrite", "hooks": [{ "type": "command", "command": "bun run $TMP_HOME/.nova-code/hooks/post.ts" }] }
    ]
  }
}
JSON

HOME="$TMP_HOME" USERPROFILE="$TMP_HOME" \
  NOVA_API_KEY=sk-mock \
  NOVA_TRANSPORT=mock \
  NOVA_MOCK_SCENARIO=todo-loop \
  nova-code ask "use todo write"

grep PreToolUse "$TMP_HOME/pre.json"
grep PostToolUse "$TMP_HOME/post.json"
rm -rf "$TMP_HOME"
```

---

## 8. 提交前校验矩阵

```bash
bun run typecheck
bun test
bun run check
```

M10 重点测试可单独运行：

```bash
bun test src/services/hooks/hooks.test.ts
bun test src/QueryEngine.test.ts
bun test src/m10-e2e-hooks.test.ts
```

---

## 9. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| hook 没运行 | matcher 不匹配工具名 | 用 `matcher: "*"` 先验证；工具名区分大小写 |
| hook 阻断了调用 | 脚本退出码为 2 或 stdout JSON 返回 block/deny | 检查 stderr 与 debug log |
| hook warning 但工具继续 | 脚本退出码非 0 且非 2 | 修复脚本；这是 M10 的 fail-open 行为 |
| JSON 输出无效 | stdout 以 `{` 开头但不是合法协议 | 改为合法 JSON，或不要在 stdout 打 `{...}` |
| 路径找不到 | shell 没按预期展开 `~` 或相对路径 | 使用绝对路径 |

---

## 10. 交叉引用

- [M10 设计文档](../design/M10-hooks.md)
- [M10 架构文档](../architecture/M10-architecture.md)
- [Roadmap](../roadmap.md)
