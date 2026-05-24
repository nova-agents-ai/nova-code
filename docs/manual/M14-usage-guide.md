# M14 使用手册：Prompt 附件与 @-mention

> 适用版本：M14 Attachments 之后
>
> 面向对象：希望在 ask/chat 中显式引用文件、目录、glob 或 MCP resource 的 nova-code 用户。

---

## 1. 前置与安装

```bash
bun install
bun run typecheck
bun test
bun run check
```

M14 不新增 npm 依赖；文件读取使用 Bun API，MCP resource 读取复用 M8 MCP 配置。

---

## 2. 命令总览

M14 不新增顶层命令，而是增强现有入口：

```bash
nova-code ask "请重构 @src/cli.ts 并遵守相关规则"
nova-code chat
```

ask 与 chat 使用同一个 attachment resolver；chat 中每一轮普通用户输入都会解析附件。斜杠命令优先执行：skill/plugin slash command 本地展开后，再解析展开后的 prompt。

---

## 3. @-mention 语法

### 3.1 文件

```bash
nova-code ask "解释 @src/QueryEngine.ts 的主循环"
nova-code ask "解释 @file:src/QueryEngine.ts"
nova-code ask "解释 @file(src/QueryEngine.ts)"
```

文件内容会被注入为 text attachment。若该路径命中 `.claude/rules` 的 `paths`，对应规则会在第一轮 system prompt 中生效。

### 3.2 目录摘要

```bash
nova-code ask "根据 @dir:src/services/attachments 给我模块说明"
nova-code ask "根据 @dir(src/services/attachments) 给我模块说明"
```

目录附件只注入直接子项摘要，不递归读取所有文件。摘要最多 120 项，超出会标记 truncated。

### 3.3 Glob

```bash
nova-code ask "总结 @glob:src/services/attachments/*.ts 的职责"
nova-code ask "总结 @glob(src/services/**/*.ts) 的分层"
nova-code ask "检查 @src/**/*.test.ts 的测试风格"
```

glob 会列出匹配摘要，并读取去重后的前 20 个文件。重复引用同一文件只注入一次。

### 3.4 图片文件

```bash
nova-code ask "看看 @assets/screenshot.png 里有什么问题"
```

支持 `.jpg` / `.jpeg` / `.png` / `.gif` / `.webp`，最大 5MB。当前 CLI 不做富媒体渲染，只把图片作为 Anthropic-compatible `image` content block 传给模型。

### 3.5 MCP resource

配置 MCP server 后可引用 resource：

```bash
nova-code ask "结合 @MCP__docs__doc://intro 回答这个问题"
```

格式为：

```text
@MCP__<serverName>__<resourceUri>
```

`serverName` 可使用原始 server 名或 `MCP__server__tool` 中同样的 sanitize 形式。若 MCP server 未连接或 resource 读取失败，CLI 会在 stderr 打 `[attachment] ...` warning，并继续执行本轮请求。

---

## 4. 与 path-scoped rules 的联动

示例：

```bash
mkdir -p .claude/rules src
cat > .claude/rules/typescript.md <<'RULE'
---
paths: ["src/**/*.ts"]
---
所有 TypeScript 修改必须使用 named export，并避免 default export。
RULE

cat > src/a.ts <<'TS'
export const a = 1;
TS

nova-code ask "请重构 @src/a.ts"
```

M14 之前，prompt 中的 `@src/a.ts` 只是普通文本，M12 rule 不会激活；M14 之后，附件 resolver 在首轮请求前调用 `activateForPath`，所以模型第一轮就能看到这条 TypeScript rule。

---

## 5. 端到端可复制验证脚本

在 nova-code 仓库根目录执行：

```bash
set -euo pipefail

TMP_DIR="$(mktemp -d)"
BIN_PATH="$PWD/bin/nova-code.ts"
LOG_FILE="$TMP_DIR/mock-requests.jsonl"
cd "$TMP_DIR"

git init -q
mkdir -p src .claude/rules
printf "export const marker = 'M14_FILE_MARKER';\n" > src/a.ts
cat > .claude/rules/typescript.md <<'RULE'
---
paths: ["src/**/*.ts"]
---
M14_RULE_MARKER
RULE

HOME="$TMP_DIR" \
USERPROFILE="$TMP_DIR" \
NOVA_API_KEY="sk-mock" \
NOVA_TRANSPORT="mock" \
NOVA_MOCK_SCENARIO="chat" \
NOVA_MOCK_LOG_FILE="$LOG_FILE" \
NOVA_WEB_PROXY="" \
NOVA_WEB_PROXY_DOMAINS="" \
bun "$BIN_PATH" ask "请重构 @src/a.ts 并遵守相关规则"

cat "$LOG_FILE"
grep -q "M14_FILE_MARKER" "$LOG_FILE"
grep -q "M14_RULE_MARKER" "$LOG_FILE"
echo "M14 attachment e2e OK"
```

---

## 6. 提交前校验矩阵

| 命令 | 必须通过 | 说明 |
|---|---|---|
| `bun run typecheck` | ✅ | 校验 `NovaContentBlock`、MCP resource 类型与 resolver API |
| `bun test` | ✅ | 包含 M14 unit/e2e 与既有 M2/M4/M8/M12/M13 回归 |
| `bun run check` | ✅ | Biome lint + format |

---

## 7. 故障排查

| 现象 | 可能原因 | 处理方式 |
|---|---|---|
| stderr 出现 `[attachment] ... not found` | 路径相对当前 cwd 不存在 | 用 `pwd` 确认 cwd，或改用绝对路径 |
| glob 没有注入任何文件 | pattern 未匹配文件，或写法被 shell 预展开 | 给 prompt 加引号；使用 `@glob:src/**/*.ts` |
| `[attachment] ... refused: bare home-directory` | 写了裸 `@~` | 改成 `@~/some/path` 显式指明子路径 |
| `[attachment] ... refused: glob patterns must be relative` | 用了 `@glob:/abs/...` 或 `@glob:~/...` | 改用相对当前 cwd 的 pattern；跨目录请用多个 `@file:` |
| `[binary file omitted]` 出现在 prompt | 文件 head 4KB 内有 NUL byte，被识别为二进制 | 二进制文件本来就不应直接进 prompt；如必要请压缩/转 base64 后用别的工具传 |
| path-scoped rule 没出现 | rule `paths` 与实际文件相对路径不匹配 | 确认 `.claude/rules/*.md` frontmatter 与 cwd |
| 图片在 chat session 文件里 | `/save` 会把 user message 的 image base64 一起落到 JSONL | 长会话定期 `/clear` 或避免反复粘贴大图 |
| MCP resource 失败 | MCP server 未配置/未连接/不支持 `resources/read` | 先跑 `nova-code mcp list` / `nova-code mcp tools` 检查 server |
| 图片没有进入模型 | 扩展名不在支持列表或超过 5MB | 转成 png/jpg/webp 或压缩图片 |

---

## 8. 交叉引用

- [M14 设计文档](../design/M14-attachments.md)
- [M14 架构文档](../architecture/M14-architecture.md)
- [Roadmap](../roadmap.md)
