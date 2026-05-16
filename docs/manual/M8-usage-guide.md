# M8 使用手册 — MCP 客户端协议

> 适用版本：nova-code v0.9.0+
>
> 目标用户：希望把 filesystem / git / brave-search 等 MCP server 接入 nova-code 的用户。

---

## 1. 前置条件

- Bun >= 1.3；
- 已配置 `NOVA_API_KEY` 或 `~/.nova-code/config.json` 中的 `apiKey`；
- 本机能运行目标 MCP server 的命令，例如 `bunx` / `uvx` / `npx`。

> 仓库约定禁止 npm/yarn/pnpm；示例优先使用 `bunx` 或 `uvx`。如果某个 MCP server 官方只发布 npx 示例，请先查是否可用 `bunx` 等价运行。

---

## 2. 命令总览

```bash
bun run bin/nova-code.ts mcp list
bun run bin/nova-code.ts mcp add <name> [options] -- <command> [args...]
bun run bin/nova-code.ts mcp add-http <name> [options] <url>   # M8.1+
bun run bin/nova-code.ts mcp remove <name>
bun run bin/nova-code.ts mcp tools
```

`add` 支持：

```bash
--auto-approve        该 server 的 MCP 工具不走权限询问
--timeout-ms <ms>     单次 MCP request 超时，默认 10000
--cwd <dir>           server 工作目录
--env KEY=VALUE       写入 server env；VALUE 可使用 ${ENV_NAME}
```

---

## 3. 配置示例

### 3.1 Filesystem server

```bash
bun run bin/nova-code.ts mcp add filesystem -- \
  bunx @modelcontextprotocol/server-filesystem "$PWD"
```

如果你确认该 server 只允许访问当前项目，且希望 ask/chat 里免审批：

```bash
bun run bin/nova-code.ts mcp add filesystem --auto-approve -- \
  bunx @modelcontextprotocol/server-filesystem "$PWD"
```

### 3.2 Git server

Python 生态的 git MCP server 常见启动方式是 `uvx`：

```bash
bun run bin/nova-code.ts mcp add git -- \
  uvx mcp-server-git --repository "$PWD"
```

### 3.3 Brave Search server

Brave Search 需要 API key。推荐把 secret 留在 shell 环境里：

```bash
export BRAVE_API_KEY="你的 key"

bun run bin/nova-code.ts mcp add brave-search \
  --env BRAVE_API_KEY='${BRAVE_API_KEY}' \
  --auto-approve \
  -- bunx @modelcontextprotocol/server-brave-search
```

运行时 nova-code 会展开 `${BRAVE_API_KEY}`。`config get` 全量输出会把 MCP env 值脱敏为 `****`。

---

## 4. 查看与验证

查看配置：

```bash
bun run bin/nova-code.ts mcp list
```

真实启动 server 并列出 bridge 后的工具名：

```bash
bun run bin/nova-code.ts mcp tools
```

你会看到类似：

```text
MCP__filesystem__read_file    MCP server 'filesystem' tool 'read_file'.
MCP__git__git_status          MCP server 'git' tool 'git_status'.
MCP__brave_search__brave_web_search MCP server 'brave-search' tool 'brave_web_search'.
```

---

## 5. 在 ask/chat 中使用

MCP 工具会和内置工具一起发给模型。模型看到的工具名形如：

```text
MCP__<server>__<tool>
```

示例：

```bash
bun run bin/nova-code.ts ask "用 MCP filesystem 检查 README，然后总结项目入口"
```

chat：

```bash
bun run bin/nova-code.ts chat
```

默认情况下 MCP 工具 `requiresApproval=true`，chat 会弹权限询问。可信只读 server 可在 add 时使用 `--auto-approve`。

---

## 6. 端到端可复制验证脚本

下面脚本不依赖第三方 MCP package，使用仓库自带 fixture：

```bash
set -euo pipefail

TMP_HOME="$(mktemp -d)"
trap 'rm -rf "$TMP_HOME"' EXIT

FIXTURE="$PWD/src/services/mcp/fixtures/stdioEchoServer.ts"

HOME="$TMP_HOME" USERPROFILE="$TMP_HOME" \
  bun run bin/nova-code.ts mcp add fixture --auto-approve -- bun run "$FIXTURE"

HOME="$TMP_HOME" USERPROFILE="$TMP_HOME" \
  bun run bin/nova-code.ts mcp tools

HOME="$TMP_HOME" USERPROFILE="$TMP_HOME" \
NOVA_API_KEY=sk-mock \
NOVA_TRANSPORT=mock \
NOVA_MOCK_SCENARIO=mcp-loop \
MOCK_MCP_TOOL_NAME=MCP__fixture__echo \
NOVA_WEB_PROXY="" \
NOVA_WEB_PROXY_DOMAINS="" \
  bun run bin/nova-code.ts ask "use the configured MCP echo tool"
```

预期输出包含：

```text
MCP__fixture__echo
[tool] MCP__fixture__echo
Done. MCP tool completed.
```

---

## 7. 提交前校验矩阵

```bash
bun run typecheck
bun test
bun run check
```

M8 新增重点用例：

```bash
bun test src/services/mcp/McpStdioClient.test.ts \
  src/services/mcp/mcpToolRegistry.test.ts \
  src/commands/McpCommand/McpCommand.test.ts \
  src/m8-e2e-mcp.test.ts
```

---

## 8. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `mcp tools` 无工具 | server command 不存在或启动失败 | 检查 `mcp list`，直接运行 command 验证 |
| `MCP server ... timed out` | server 启动慢或卡住 | 增大 `--timeout-ms`，检查 stderr |
| ask 中 MCP 工具被 denied | 默认需要审批 | 用 chat 审批、写 permission rule、或可信场景加 `--auto-approve` |
| Brave Search 报 key 缺失 | `BRAVE_API_KEY` 没传入 server env | 用 `--env BRAVE_API_KEY='${BRAVE_API_KEY}'` 重新 add |
| 配置里 env secret 被隐藏 | 这是预期 | `config get` 会脱敏，真实运行仍传给 server |

---

## 9. 交叉引用

- [M8 设计文档](../design/M8-mcp-client.md)
- [M8 架构文档](../architecture/M8-architecture.md)
- [M8.1 使用手册](./M8.1-usage-guide.md)
- [Roadmap](../roadmap.md)
