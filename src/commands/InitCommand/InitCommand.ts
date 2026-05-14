/** `nova-code init`：在当前项目生成一份最小 CLAUDE.md。 */

import { join } from "node:path";
import type { CommandDefinition } from "../types.ts";

interface InitCommandIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface RunInitCommandOptions {
  readonly cwd?: string;
  readonly io?: InitCommandIO;
}

export const initCommand: CommandDefinition = {
  name: "init",
  description: "在当前目录生成 CLAUDE.md 项目指令模板",
  usage: "nova-code init [--force]",
  run: (args) => runInitCommand(args),
};

/** 测试友好的 init 命令入口。 */
export async function runInitCommand(
  args: readonly string[],
  options: RunInitCommandOptions = {},
): Promise<number> {
  const io = options.io ?? defaultIO();
  const flags = parseInitArgs(args);
  if (flags.ok === false) {
    io.stderr(`init: ${flags.message}\n`);
    return 1;
  }

  const cwd = options.cwd ?? process.cwd();
  const path = join(cwd, "CLAUDE.md");
  const file = Bun.file(path);
  if ((await file.exists()) && !flags.force) {
    io.stderr("init: CLAUDE.md already exists. Use --force to overwrite.\n");
    return 1;
  }

  await Bun.write(path, buildClaudeMdTemplate());
  io.stdout(`Created ${path}\n`);
  return 0;
}

type ParseInitArgsResult =
  | { readonly ok: true; readonly force: boolean }
  | { readonly ok: false; readonly message: string };

function parseInitArgs(args: readonly string[]): ParseInitArgsResult {
  let force = false;
  for (const arg of args) {
    if (arg === "--force") {
      force = true;
      continue;
    }
    return { ok: false, message: `unknown argument ${arg}` };
  }
  return { ok: true, force };
}

function buildClaudeMdTemplate(): string {
  return [
    "# CLAUDE.md",
    "",
    "This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.",
    "",
    "## Project instructions",
    "",
    "- Prefer the package manager and scripts already defined by this repository.",
    "- Before handing off code changes, run the repository's typecheck, test, and lint/check commands.",
    "- Keep this file concise; move long references into separate docs and reference them with @path.",
    "",
  ].join("\n");
}

function defaultIO(): InitCommandIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}
