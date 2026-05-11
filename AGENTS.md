# nova-code 仓库约定（给 AI 协作者看的指南）

本文件给 AI 编码助手（Codex / Cursor / Copilot 等）阅读，目的是让你在改动本仓库时**保持一致性、避免破坏既有约定**。
人类开发者请优先看 [README.md](./README.md)。

---

## 1. 项目定位

- 一个基于 **Bun + TypeScript** 的 CLI 程序，命名 `nova-code`，目标是做一个 Code Agent。
- 当前阶段：**最小骨架**——参数解析 + 命令分发 + 几个示例命令（`hello` / `echo` / `ask`）。
- 仓库内的 `Codex/` 目录是**外部参考代码**（在 `.gitignore` 中且 `tsconfig.json` `exclude` 中），**禁止**修改、禁止 import、不计入 typecheck 范围。

## 2. 目录约定

```
bin/nova-code.ts    CLI 可执行入口，shebang `#!/usr/bin/env bun`，只做参数转发
src/index.ts        库入口，只做 re-export，不写业务
src/cli.ts          CLI 主流程：参数解析、--help/--version、命令分发、错误兜底
src/commands.ts     所有内置子命令的实现集合
biome.json          Biome lint+format 配置（项目唯一的 linter）
tsconfig.json       TS 严格模式 + bun 类型；include 限定为 bin/src，exclude Codex
```

新增文件时遵循"一个文件一个主要实体"，工具函数按职责拆到独立模块，不要堆 `utils.ts` 大杂烩。

## 3. 运行时与工具链（Bun 优先，硬性约束）

- 用 `bun <file>` 而非 `node <file>` / `ts-node <file>`。
- 用 `bun install` / `bun add` / `bun add -D`，**禁止**使用 `npm` / `yarn` / `pnpm`。
- 用 `bun run <script>` / `bunx`。
- 用 `bun test` 跑测试，文件名 `*.test.ts`。
- 用 `bun build` 打包/编译，**禁止**引入 webpack / esbuild / tsup / rollup。
- Bun 自动加载 `.env`，**禁止**引入 `dotenv`。
- 优先用 Bun 原生 API，禁止引入对应的 npm 包：
  - `Bun.file` / `Bun.write` 替代 `node:fs` 的 readFile/writeFile
  - `<code>`Bun.$&#96;ls&#96;`</code>` 替代 `execa` / `child_process`
  - `Bun.serve()` 替代 `express` / `koa`
  - `bun:sqlite` 替代 `better-sqlite3`
  - `Bun.redis` 替代 `ioredis`
  - `Bun.sql` 替代 `pg` / `postgres.js`
  - 全局 `WebSocket` 替代 `ws`

更多 Bun API：`node_modules/bun-types/docs/**.mdx`。

## 4. 代码风格（必须遵守）

完整规范在 `~/.agents/skills/typescript-javascript-best-practices/SKILL.md`，本仓库的关键摘要：

- **TS 严格模式全开**：`strict` + `noUncheckedIndexedAccess` + `noPropertyAccessFromIndexSignature` + `noUnusedLocals/Parameters`。
- **禁止 `any`**，用 `unknown` + 类型收窄。**禁止 `!`** 非空断言，用早 return / 类型守卫。
- **禁止 default export**，统一 named export。
- **禁止 `==`**，用 `===`。**禁止 `var`**，用 `const`/`let`。
- **公共 API（导出函数）必须显式返回类型**；内部函数可推断。
- **`import type`** 导入纯类型，便于 tree-shaking。
- **守卫子句优先 / 早 return**，最大嵌套不超过 3 层。
- **函数 ≤ 30 行（硬限 50）**，参数 ≤ 3 个，超出用对象参数 + 接口定义。
- **错误处理**：`catch(error)` 中 `error` 是 `unknown`，必须先用 `error instanceof Error` 收窄；禁止空 catch；禁止 `throw "string"`。
- **不可变性**：默认 `const`、`readonly`、`spread` 创建新对象，不要原地修改。
- **注释解释 WHY**，不解释 WHAT；禁止保留被注释掉的代码；禁止 `TODO` 注释（如必须保留，需关联 issue 编号）。

## 5. CLI 扩展规范

新增子命令的标准流程（**只改 `src/commands.ts` 一个文件**）：

1. 定义一个 `CommandDefinition`：`{ name, description, usage, run }`，`run` 返回 `number | Promise<number>`（exit code）。
2. 把它加入 `builtinCommands` 数组。
3. `--help` 会自动展示，无需在 `cli.ts` 注册任何东西。

`cli.ts` 的职责仅限于：参数解析、`--help` / `--version`、命令查找、统一异常兜底。**不要**在 `cli.ts` 里写业务逻辑。

## 6. 提交前以及每一次代码改动后校验（必跑）

```bash
bun run typecheck          # tsc --noEmit
bun run check              # biome lint + format 检查
bun test                   # 跑 *.test.ts 用例（无用例时 0 退出）
```

`prepublishOnly` 钩子会强制跑 `typecheck && check`，不通过则发布失败。

## 7. 测试

用 `bun:test`，文件名 `<name>.test.ts`，与被测文件同目录。

```ts
// src/cli.test.ts
import { describe, expect, test } from "bun:test";
import { runCli } from "./cli.ts";

describe("runCli", () => {
  test("无参数返回 0 并打印 help", async () => {
    expect(await runCli({ argv: [] })).toBe(0);
  });
});
```

## 8. 这个仓库 **不是** Web/前端项目

- **禁止**引入 React / Vue / Tailwind / Vite。
- **禁止**新增 `.html` / `.tsx` / `.css` 文件。
- 如确需 Web UI，请先与维护者讨论，再独立放到 `web/` 子目录，避免污染 CLI 主项目。
