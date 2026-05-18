# M12 使用手册：`.claude/rules` 项目指令

> 适用版本：M12 `.claude/rules` 之后
>
> 面向对象：终端用户、项目维护者、新加入仓库的工程师。

---

## 1. 前置与安装

```bash
bun install
bun run typecheck
bun test
bun run check
```

M12 不新增 npm 依赖；glob 匹配使用 Bun 内置 `Bun.Glob`。

---

## 2. 目录与文件格式

在仓库任意目录层级创建 `.claude/rules/*.md` 或子目录下的 `*.md`：

```text
.claude/rules/
├── general.md          # 无 paths，启动即加载
└── typescript.md       # 带 paths，命中文件后加载
```

### 2.1 全局项目规则

```md
# General rules
Keep changes small and run the full Bun validation trio before handoff.
```

### 2.2 路径级规则

```md
---
paths: ["src/**/*.ts", "bin/**/*.ts"]
---
For TypeScript files, use named exports, avoid `any`, and prefer Bun APIs.
```

支持的 `paths` 写法：

```md
---
paths: "src/**/*.ts"
---
```

```md
---
paths:
  - "src/**/*.ts"
  - "*.test.ts"
---
```

---

## 3. 什么时候生效

| 场景 | 是否加载无 `paths` rule | 是否加载带 `paths` rule |
|---|---:|---:|
| 启动 `nova-code ask/chat` | 是 | 否 |
| `FileRead { path: "src/a.ts" }` 命中 `src/**/*.ts` | 已加载 | 是，下一轮 LLM 可见 |
| `FileEdit { path: "src/a.ts" }` 命中 `src/**/*.ts` | 已加载 | 是，下一轮 LLM 可见 |
| `FileWrite { path: "src/a.ts" }` 命中 `src/**/*.ts` | 已加载 | 是，下一轮 LLM 可见 |
| 只在 prompt 里写 `@src/a.ts` | 已加载 | M14 前不会触发 |

---

## 4. 端到端验证脚本

以下脚本可复制粘贴到任意临时目录；它使用 mock LLM，不会访问真实 API：

```bash
set -euo pipefail

TMP_DIR="$(mktemp -d)"
cd "$TMP_DIR"

git init -q
mkdir -p src .claude/rules
printf 'export const a = 1;\n' > src/a.ts
cat > .claude/rules/typescript.md <<'RULE'
---
paths: ["src/**/*.ts"]
---
M12_TS_RULE_MARKER
Only applies to TypeScript source files.
RULE

NOVA_API_KEY=sk-mock \
NOVA_TRANSPORT=mock \
NOVA_MOCK_SCENARIO=rules-loop \
NOVA_MOCK_LOG_FILE="$TMP_DIR/mock.jsonl" \
MOCK_RULES_FILE_PATH=src/a.ts \
bun /ABS/PATH/TO/nova-code/bin/nova-code.ts ask "read src/a.ts"

printf '\n--- mock requests ---\n'
cat "$TMP_DIR/mock.jsonl"
```

把 `/ABS/PATH/TO/nova-code` 替换为本仓库绝对路径。预期：mock log 第一条 request 的 `systemSnippet` 不含 `M12_TS_RULE_MARKER`，第二条 request 包含该 marker。

---

## 5. InstructionsLoaded hook

配置示例：

```json
{
  "hooks": {
    "InstructionsLoaded": [
      {
        "matcher": "path_glob_match|session_start|include",
        "hooks": [
          {
            "type": "command",
            "command": "bun run scripts/audit-instructions-loaded.ts"
          }
        ]
      }
    ]
  }
}
```

hook stdin 会包含 `file_path`、`memory_type`、`load_reason`、`globs`、`trigger_file_path` 等字段。该 hook 用于审计，不建议依赖它改变运行结果。

---

## 6. 提交前校验矩阵

| 命令 | 必须通过 | 说明 |
|---|---:|---|
| `bun run typecheck` | 是 | TS 严格模式 |
| `bun test` | 是 | 含 M12 unit + e2e |
| `bun run check` | 是 | Biome lint/format |

---

## 7. 故障排查

| 现象 | 常见原因 | 处理 |
|---|---|---|
| 带 `paths` 的 rule 没出现 | 本轮还没通过 FileRead/FileEdit/FileWrite 处理匹配文件 | 先让模型读取目标文件，或等 M14 @-mention 支持 |
| glob 不匹配 | `paths` 相对的是包含 `.claude` 的目录 | 调整为相对该目录的路径，如 `src/**/*.ts` |
| frontmatter 出现在模型上下文 | rule 没有以首行 `---` 开始或缺少结束 `---` | 修正 frontmatter 块 |
| hook 未触发 | matcher 不匹配 `load_reason` | matcher 用 `session_start|path_glob_match|include` |

---

## 8. 交叉引用

- [M12 设计文档](../design/M12-rules.md)
- [M12 架构文档](../architecture/M12-architecture.md)
- [Roadmap](../roadmap.md)
