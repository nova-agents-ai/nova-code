/**
 * nova-code CLI 主流程。
 *
 * 设计为框架式：
 * - 命令集（commands）可以注入，未传入时使用 builtinCommands；
 * - CLI 元信息（name/version/description）可以注入，未传入时使用 nova-code 自身的默认值；
 * - 不再硬依赖 package.json 文件，避免编译产物因相对路径丢失版本号。
 *
 * 这样上层应用可以基于本框架构建自己的 CLI（不同名字、不同命令集），无需 fork。
 */

import type { CommandDefinition } from "./commands.ts";
import { builtinCommands as defaultCommands, findCommand } from "./commands.ts";

/** 默认 CLI 元信息，仅在 runCli 调用方未传入时使用。 */
const DEFAULT_META = {
  name: "nova-code",
  version: "1.0.0",
  description: "一个全新的 Code Agent CLI",
} as const;

export interface RunCliOptions {
  /** 透传的参数列表，默认为 `process.argv.slice(2)`。 */
  readonly argv?: readonly string[];
  /** 可调度的命令集合，默认为 `builtinCommands`。传入时**完全替换**默认命令集。 */
  readonly commands?: readonly CommandDefinition[];
  /** CLI 显示名（用于 help 与错误提示），默认为 `"nova-code"`。 */
  readonly name?: string;
  /** CLI 版本号（用于 `--version`），默认为 `"1.0.0"`。 */
  readonly version?: string;
  /** CLI 描述（用于 help 标题），默认为内置文案。 */
  readonly description?: string;
}

export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const commands = options.commands ?? defaultCommands;
  const name = options.name ?? DEFAULT_META.name;
  const version = options.version ?? DEFAULT_META.version;
  const description = options.description ?? DEFAULT_META.description;

  const first = argv[0];

  // 无参数时打印帮助。first 在此条件下为 undefined。
  if (first === undefined) {
    printHelp({ name, version, description, commands });
    return 0;
  }

  // 顶层选项优先于子命令处理。
  if (first === "-h" || first === "--help") {
    printHelp({ name, version, description, commands });
    return 0;
  }
  if (first === "-v" || first === "--version") {
    console.log(`${name} v${version}`);
    return 0;
  }

  const command = findCommand(first, commands);
  if (!command) {
    console.error(`未知命令: ${first}`);
    console.error(`运行 \`${name} --help\` 查看可用命令。`);
    return 1;
  }

  const rest = argv.slice(1);
  try {
    return await command.run(rest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`命令 \`${command.name}\` 执行失败: ${message}`);
    return 1;
  }
}

interface PrintHelpContext {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly commands: readonly CommandDefinition[];
}

function printHelp(context: PrintHelpContext): void {
  const { name, version, description, commands } = context;
  const lines: string[] = [];
  lines.push(`${name} v${version} - ${description}`);
  lines.push("");
  lines.push("用法:");
  lines.push(`  ${name} <command> [args...]`);
  lines.push(`  ${name} [-h | --help]`);
  lines.push(`  ${name} [-v | --version]`);
  lines.push("");

  if (commands.length === 0) {
    lines.push("（当前命令集为空）");
    console.log(lines.join("\n"));
    return;
  }

  lines.push("可用命令:");
  const nameColumnWidth = Math.max(...commands.map((command) => command.name.length));
  for (const command of commands) {
    const paddedName = command.name.padEnd(nameColumnWidth, " ");
    lines.push(`  ${paddedName}    ${command.description}`);
  }

  lines.push("");
  lines.push("示例:");
  for (const command of commands) {
    lines.push(`  ${command.usage}`);
  }

  console.log(lines.join("\n"));
}
