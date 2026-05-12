# nova-code

> 一个全新的 Code Agent CLI，基于 [Bun](https://bun.sh) + TypeScript 构建。

[![CI](https://github.com/dinglevin/nova-code/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dinglevin/nova-code/actions/workflows/ci.yml)
[![CodeQL](https://github.com/dinglevin/nova-code/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/dinglevin/nova-code/actions/workflows/codeql.yml)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.3.0-black?logo=bun)](https://bun.sh)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](./LICENSE)

`nova-code` 旨在做一个开放、可扩展的 Code Agent 框架。当前仓库提供了最小可用的命令分发骨架（`hello` / `ask` / `chat`），后续会逐步接入更丰富的模型调用与代码工具能力。

本仓库**同时是 CLI 也是库**：
- 终端用户可以直接 `nova-code <command>` 使用；
- 上层应用可以 `import { runCli, builtinCommands } from "nova-code"`，把 CLI 能力嵌入自己的程序。

---

## 安装

需要先安装 [Bun](https://bun.sh) `>= 1.3.0`。

### 从源码运行

```bash
git clone https://github.com/dinglevin/nova-code.git
cd nova-code
bun install
bun run start            # 等价于 bun run bin/nova-code.ts
```

### 全局安装（npm 发布后）

```bash
bun add -g nova-code
nova-code --help
```

### 使用预编译二进制

`bun run build:all` 可一键产出全平台单文件可执行（无需 Bun 运行时）。产物在 `dist/` 下，可直接 `./dist/nova-code-macos-arm64 hello world` 运行。

### 作为库安装

```bash
bun add nova-code
```

详见下方 [作为库使用](#作为库使用) 章节。

---

## 使用

```bash
nova-code                 # 等价于 nova-code --help
nova-code --help          # 打印帮助
nova-code --version       # 打印版本号

nova-code hello [name]    # 向 [name] 打招呼，缺省为 world
nova-code ask             # 从 stdin 读取一行问题并回显
```

### 命令一览

| 命令 | 描述 | 用法 |
|------|------|------|
| `hello` | 向指定的人打招呼，默认对象是 `world` | `nova-code hello [name]` |
| `ask` | 通过标准输入读取一行问题并原样回显 | `nova-code ask` |

---

## 开发

### 目录结构

```
nova-code/
├── bin/
│   └── nova-code.ts        # CLI 可执行入口（带 shebang），仅做参数转发
├── src/
│   ├── index.ts            # 库入口，re-export 公共 API
│   ├── cli.ts              # CLI 主流程：参数解析、命令分发、错误兜底
│   ├── cli.test.ts         # cli 单元测试
│   ├── commands.ts         # 内置子命令实现集合
│   └── commands.test.ts    # commands 单元测试
├── dist/lib/               # tsc 产出的 lib 编译产物（.js + .d.ts），供 Node 用户消费
├── biome.json              # Biome lint + format 配置
├── tsconfig.json           # 开发期 TS 配置（严格模式 + bun 类型）
├── tsconfig.build.json     # lib 构建专用配置（产 .js + .d.ts 到 dist/lib）
├── package.json
└── README.md
```

### 常用脚本

| 脚本 | 作用 |
|------|------|
| `bun run dev` | `bun --watch` 模式跑 CLI，改代码即时生效 |
| `bun run start` | 跑一次 CLI（不带 watch） |
| `bun run typecheck` | `tsc --noEmit` 类型检查 |
| `bun run lint` / `lint:fix` | Biome 静态检查（含自动修复） |
| `bun run format` / `format:check` | Biome 格式化（含只读检查） |
| `bun run check` / `check:fix` | Biome 一次性跑 lint + format |
| `bun test` / `test:watch` | 运行 `bun:test` 用例 |
| `bun run clean` | 清空 `dist/` |
| `bun run build` | 当前平台编译为单文件可执行（`dist/nova-code`） |
| `bun run build:linux-x64` 等 | 跨平台编译（详见 `package.json`） |
| `bun run build:all` | 一次性编译全部支持平台 |
| `bun run build:lib` | 用 `tsc` 编译 lib 产物到 `dist/lib/`（`.js` + `.d.ts`，供 Node 用户 import） |

### 添加一个新命令

1. 在 `src/commands.ts` 中创建一个 `CommandDefinition` 对象：

   ```ts
   const greetCommand: CommandDefinition = {
     name: "greet",
     description: "用礼貌的方式打招呼",
     usage: "nova-code greet <name>",
     run: (args) => {
       const name = args[0];
       if (name === undefined) {
         console.error("greet: 必须提供姓名");
         return 1;
       }
       console.log(`Good to see you, ${name}.`);
       return 0;
     },
   };
   ```

2. 把它加入 `builtinCommands` 数组：

   ```ts
   export const builtinCommands: readonly CommandDefinition[] = [
     helloCommand,
     echoCommand,
     askCommand,
     greetCommand, // ← 新增
   ];
   ```

3. 完成。`--help` 会自动列出该命令，无需其他注册。

---

## 作为库使用

`nova-code` 通过 `package.json` 的 [conditional exports](https://nodejs.org/api/packages.html#conditional-exports) 同时支持 **Bun 直接消费 TS 源码** 和 **Node 消费编译后的 JS + .d.ts**：

- Bun 用户：走 `bun` 条件，直接加载 `src/index.ts`，零编译开销；
- Node 用户：走 `import` / `default` 条件，加载 `dist/lib/index.js`（带 `.d.ts`）。

### 安装

```bash
bun add nova-code            # Bun
npm install nova-code        # Node 18+
```

> ⚠️ `ask` 命令在内部使用 `Bun.stdin`，**仅在 Bun 运行时可用**。其它命令（`hello`、`echo`）以及 `runCli`、`findCommand`、自定义命令等**所有 API 在 Node 下都能正常工作**。

### 公共 API

全部从统一入口 `nova-code` 导入：

| 导出 | 类型 | 用途 |
|------|------|------|
| `runCli` | `(options?: RunCliOptions) => Promise<number>` | 编程式调用 CLI 主流程，返回 exit code |
| `RunCliOptions` | `interface` | `runCli` 的入参类型，详见下表 |
| `builtinCommands` | `readonly CommandDefinition[]` | 内置命令清单 |
| `findCommand` | `(name, commands?) => CommandDefinition \| undefined` | 在指定命令集中按名查找命令；`commands` 省略时使用 `builtinCommands` |
| `CommandDefinition` | `interface` | 命令定义类型，自定义命令需实现 |
| `CommandHandler` | `type` | 命令 `run` 函数的签名：`(args: readonly string[]) => number \| Promise<number>` |

`RunCliOptions` 字段：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `argv` | `readonly string[]` | `process.argv.slice(2)` | 透传的参数列表 |
| `commands` | `readonly CommandDefinition[]` | `builtinCommands` | 可调度的命令集合，**传入时完全替换默认命令集**（不合并） |
| `name` | `string` | `"nova-code"` | CLI 显示名（用于 `--help` 与错误提示） |
| `version` | `string` | `"1.0.0"` | CLI 版本号（用于 `--version`） |
| `description` | `string` | 内置文案 | CLI 描述（用于 `--help` 标题行） |

### 示例 1：以代码方式触发内置 CLI

```ts
import { runCli } from "nova-code";

const exitCode = await runCli({ argv: ["hello", "alice"] });
// exitCode === 0，stdout 输出：Hello, alice!
```

### 示例 2：枚举所有内置命令（如自动生成文档）

```ts
import { builtinCommands } from "nova-code";

for (const command of builtinCommands) {
  console.log(`- **${command.name}**: ${command.description}`);
  console.log(`  - usage: \`${command.usage}\``);
}
```

### 示例 3：直接执行单个命令而不走主流程

```ts
import { findCommand } from "nova-code";

const echo = findCommand("echo");
if (echo) {
  const exitCode = await echo.run(["hello", "world"]);
  // 控制台输出：hello world
}
```

### 示例 4：基于 `nova-code` 框架构建你自己的 CLI

`runCli` 接受 `commands`、`name`、`version`、`description`，可以注入完全自定义的命令集，把 `nova-code` 当作一个 CLI 框架使用：

```ts
import { runCli, type CommandDefinition } from "nova-code";

const myCommands: CommandDefinition[] = [
  {
    name: "ping",
    description: "回复 pong",
    usage: "my-app ping",
    run: () => {
      console.log("pong");
      return 0;
    },
  },
  {
    name: "greet",
    description: "礼貌地打招呼",
    usage: "my-app greet <name>",
    run: (args) => {
      const name = args[0];
      if (name === undefined) {
        console.error("greet: 必须提供姓名");
        return 1;
      }
      console.log(`Good to see you, ${name}.`);
      return 0;
    },
  },
];

const exitCode = await runCli({
  name: "my-app",
  version: "0.1.0",
  description: "我的自定义 CLI",
  commands: myCommands,
});
process.exit(exitCode);
```

执行 `my-app --help` 时输出：

```
my-app v0.1.0 - 我的自定义 CLI

用法:
  my-app <command> [args...]
  my-app [-h | --help]
  my-app [-v | --version]

可用命令:
  ping     回复 pong
  greet    礼貌地打招呼

示例:
  my-app ping
  my-app greet <name>
```

### 示例 5：在内置命令基础上扩展

`commands` 是完全替换语义。如果想保留内置命令并叠加自己的：

```ts
import { runCli, builtinCommands, type CommandDefinition } from "nova-code";

const extra: CommandDefinition = {
  name: "ping",
  description: "回复 pong",
  usage: "nova-code ping",
  run: () => {
    console.log("pong");
    return 0;
  },
};

await runCli({
  commands: [...builtinCommands, extra],
});
```

---

## 构建与发布

### 本地构建

- **CLI 二进制**：`bun run build`（产物 `dist/nova-code`，已 minify + sourcemap）。
- **跨平台 CLI**：`bun run build:all` 会产出 `linux-x64`、`linux-arm64`、`macos-x64`、`macos-arm64`、`windows-x64` 五份独立二进制。
- **Lib 产物**：`bun run build:lib`（用 `tsc` 编译到 `dist/lib/`，包含 `.js` + `.d.ts` + sourcemap），供 Node 用户 import。
- **发布到 npm**：`prepublishOnly` 钩子会强制跑 `typecheck` + `biome check` + `bun test` + `build:lib`，全绿后才允许发布；`prepack` 钩子会自动跑 `build:lib` 确保打包时 `dist/lib/` 一定是最新的。

> ⚠️ `bin/nova-code.ts` 使用 `#!/usr/bin/env bun` shebang，作为 CLI 全局安装时**用户必须有 Bun 运行时**。如希望支持纯 Node 用户使用 CLI，请直接发布预编译二进制（`build:all` 产物）。Node 用户**仅作为库 import 时**完全无需 Bun。

### 自动化（GitHub Actions）

仓库已配置完整的 CI/CD 与安全自动化：

| 工作流 | 触发 | 作用 |
|--------|------|------|
| [`ci.yml`](.github/workflows/ci.yml) | push/PR to `main` | typecheck + biome check + 跨 OS 测试 + 跨平台编译 |
| [`release.yml`](.github/workflows/release.yml) | 推送 `v*` tag | 校验 tag 与 `package.json` 版本一致 → 全套 quality gate → `build:all` + `bun pm pack` → 创建 GitHub Release 并上传五份二进制、`.tgz` 与 `checksums.txt` |
| [`codeql.yml`](.github/workflows/codeql.yml) | push/PR to `main` + 每周一 | CodeQL 静态安全扫描（`javascript-typescript`，`security-extended` 规则集） |
| [`dependabot.yml`](.github/dependabot.yml) | 每周一 | 自动 PR 升级 npm 依赖（typescript / biome / @types/bun 等）和 GitHub Actions；major 版本默认忽略，留人工评估 |

#### 发版步骤

```bash
# 1. 改 package.json 的 version 字段（必须与即将打的 tag 一致，否则 release.yml 会 fail）
# 2. 提交并打 tag
git add package.json
git commit -m "chore: bump to 1.0.1"
git tag v1.0.1
git push origin main --tags
# 3. release.yml 会自动跑校验、构建、创建 GitHub Release 并上传产物
```

> 💡 tag 形如 `v1.0.1-beta.1` / `v1.0.1-rc.0` 会被自动识别为 prerelease。

---

## License

[GPL-3.0-or-later](./LICENSE) © dinglevin

