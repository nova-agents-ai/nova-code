# M13 使用手册：本地插件系统

> 适用版本：M13 Plugins 之后
>
> 面向对象：想把 skills、slash commands、hooks、MCP server 与 rules 打包复用的 nova-code 用户和插件作者。

---

## 1. 前置与安装

```bash
bun install
bun run typecheck
bun test
bun run check
```

M13 不新增外部依赖；插件系统复用 Bun、M8 MCP、M9 Skills、M10 Hooks 与 M12 Rules。

---

## 2. 插件目录

项目插件：

```text
.nova-code/plugins/<plugin-name>/plugin.json
```

用户插件：

```text
~/.nova-code/plugins/<plugin-name>/plugin.json
```

插件目录推荐结构：

```text
.nova-code/plugins/demo/
├── plugin.json
├── skills/
│   └── demo-skill/
│       └── SKILL.md
├── commands/
│   └── review.md
├── hooks/
│   └── hooks.json
├── hook.ts
├── mcp.json
└── rules/
    └── typescript.md
```

---

## 3. 命令总览

```bash
nova-code plugin list
nova-code plugin enable <name> --yes
nova-code plugin disable <name>
nova-code plugin reload
nova-code plugin validate [name|path]
```

| 命令 | 说明 |
|---|---|
| `list` | 展示发现到的插件、状态、版本、路径 |
| `enable <name> --yes` | 信任并启用插件，记录当前 path / version / 时间戳 |
| `disable <name>` | 禁用插件，贡献项立即不再加载 |
| `reload` | 仅重扫已启用插件并刷新时间戳；不重建运行中会话 |
| `validate [name\|path]` | 校验 manifest |

未启用插件只会出现在 `plugin list`，不会贡献任何运行时能力。

如果插件目录被搬动，或作者升了 manifest `version`，下次启动时 `loadPluginCatalog` 会把它降级为 untrusted 并打印 `path-changed` / `version-changed` warning，必须重跑 `plugin enable <name> --yes` 才能再次启用。

---

## 4. 创建一个最小插件

```bash
mkdir -p .nova-code/plugins/demo/{commands,hooks,rules,skills/demo-skill}
cat > .nova-code/plugins/demo/plugin.json <<'JSON'
{
  "name": "demo",
  "version": "1.0.0",
  "description": "Demo local plugin"
}
JSON
```

### 4.1 添加 skill

```bash
cat > .nova-code/plugins/demo/skills/demo-skill/SKILL.md <<'SKILL'
---
description: Demo plugin skill.
---
# Demo Skill
Use this skill when the user asks for demo-plugin behavior.
SKILL
```

### 4.2 添加 custom slash command

```bash
cat > .nova-code/plugins/demo/commands/review.md <<'CMD'
---
description: Review using demo plugin guidance.
---
Review the target with demo plugin rules.

Arguments: $ARGUMENTS
CMD
```

启用后可用：

```bash
nova-code ask "/demo:review src/a.ts"
```

### 4.3 添加 hook

```bash
cat > .nova-code/plugins/demo/hooks/hooks.json <<'JSON'
{
  "PostToolUse": [
    {
      "matcher": "FileRead",
      "hooks": [
        {
          "type": "command",
          "command": "bun ${NOVA_PLUGIN_ROOT}/hook.ts"
        }
      ]
    }
  ]
}
JSON

cat > .nova-code/plugins/demo/hook.ts <<'TS'
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: "Demo plugin hook observed FileRead."
  }
}));
TS
```

### 4.4 添加 path-scoped rule

```bash
cat > .nova-code/plugins/demo/rules/typescript.md <<'RULE'
---
paths: ["src/**/*.ts"]
---
When working on TypeScript files, prefer named exports and Bun APIs.
RULE
```

### 4.5 启用插件

```bash
nova-code plugin validate demo
nova-code plugin enable demo --yes
nova-code plugin list
```

---

## 5. 端到端可复制验证脚本

在 nova-code 仓库根目录执行：

```bash
set -euo pipefail

TMP_DIR="$(mktemp -d)"
BIN_PATH="$PWD/bin/nova-code.ts"
cd "$TMP_DIR"

git init -q
mkdir -p src .nova-code/plugins/demo/{commands,hooks,rules,skills/demo-skill}
printf 'export const a = 1;\n' > src/a.ts

cat > .nova-code/plugins/demo/plugin.json <<'JSON'
{ "name": "demo", "version": "1.0.0", "description": "Demo plugin" }
JSON

cat > .nova-code/plugins/demo/skills/demo-skill/SKILL.md <<'SKILL'
---
description: Demo plugin skill.
---
PLUGIN_SKILL_BODY_MARKER
SKILL

cat > .nova-code/plugins/demo/commands/review.md <<'CMD'
---
description: Review via demo plugin.
---
PLUGIN_COMMAND_MARKER $ARGUMENTS
CMD

cat > .nova-code/plugins/demo/hooks/hooks.json <<'JSON'
{
  "PostToolUse": [
    {
      "matcher": "FileRead",
      "hooks": [{ "type": "command", "command": "bun ${NOVA_PLUGIN_ROOT}/hook.ts" }]
    }
  ]
}
JSON

cat > .nova-code/plugins/demo/hook.ts <<'TS'
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: "PLUGIN_HOOK_MARKER"
  }
}));
TS

cat > .nova-code/plugins/demo/rules/typescript.md <<'RULE'
---
paths: ["src/**/*.ts"]
---
PLUGIN_RULE_MARKER
RULE

HOME="$TMP_DIR" USERPROFILE="$TMP_DIR" bun "$BIN_PATH" plugin enable demo --yes

HOME="$TMP_DIR" USERPROFILE="$TMP_DIR" \
NOVA_API_KEY=sk-mock \
NOVA_TRANSPORT=mock \
NOVA_MOCK_SCENARIO=rules-loop \
NOVA_MOCK_LOG_FILE="$TMP_DIR/mock.jsonl" \
MOCK_RULES_FILE_PATH=src/a.ts \
bun "$BIN_PATH" ask "read src/a.ts"

cat "$TMP_DIR/mock.jsonl"
```

预期：mock log 中能看到：

- 首轮 system prompt 有 `demo-skill` listing，但没有 `PLUGIN_SKILL_BODY_MARKER`。
- 首轮 system prompt 没有 `PLUGIN_RULE_MARKER`。
- FileRead 后的下一轮 system prompt 有 `PLUGIN_RULE_MARKER`。
- FileRead 的 tool result 中包含 `PLUGIN_HOOK_MARKER`。

---

## 6. 提交前校验矩阵

| 命令 | 必须通过 | 说明 |
|---|---:|---|
| `bun run typecheck` | 是 | TS 严格模式 |
| `bun test` | 是 | 包含 `src/m13-e2e-plugins.test.ts` |
| `bun run check` | 是 | Biome lint + format |

---

## 7. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `plugin list` 看到 `untrusted` | 插件只被发现，尚未信任 | `nova-code plugin enable <name> --yes` |
| 启动时打印 `path-changed` / `version-changed` warning | 之前信任的路径或版本已变 | 复审 manifest 后重跑 `plugin enable <name> --yes` |
| 插件 skill 不出现 | 插件未启用，或 `skills/<name>/SKILL.md` 不存在 | 先 `plugin list`，再检查目录结构 |
| `/demo:review` 未展开 | command 文件不在 `commands/**/*.md`，或插件被禁用 | `plugin validate demo` + `plugin enable demo --yes` |
| hook 没运行 | hook event/matcher 不匹配，或 JSON schema 不合法 | 用 `plugin validate` 与 `--debug` 观察 hook_result |
| MCP 工具名不符合预期 | 插件 server name 会被命名空间化 | 查看工具名形如 `MCP__demo_echo__tool` |
| path rule 首轮没出现 | 这是预期的延迟激活 | 需要 FileRead/FileEdit/FileWrite 命中后下一轮出现 |

---

## 8. 交叉引用

- [M13 设计文档](../design/M13-plugins.md)
- [M13 架构文档](../architecture/M13-architecture.md)
- [Roadmap](../roadmap.md)
