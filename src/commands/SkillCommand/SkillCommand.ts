/** `nova-code skill`：查看 M9 Skills catalog 与 skill 正文。 */

import { loadPluginCatalog } from "../../services/plugins/index.ts";
import type { LoadedSkill, SkillEnvironment } from "../../services/skills/index.ts";
import { loadSkillCatalog } from "../../services/skills/index.ts";
import type { CommandDefinition } from "../types.ts";

interface SkillCommandIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface RunSkillCommandOptions {
  readonly cwd?: string;
  readonly homeDir?: string;
  readonly env?: SkillEnvironment;
  readonly io?: SkillCommandIO;
}

export const skillCommand: CommandDefinition = {
  name: "skill",
  description: "查看可用 Skills 与正文",
  usage: "nova-code skill list\n" + "nova-code skill show <name>",
  run: (args) => runSkillCommand(args),
};

export async function runSkillCommand(
  args: readonly string[],
  options: RunSkillCommandOptions = {},
): Promise<number> {
  const io = options.io ?? defaultIO();
  const action = parseAction(args);
  if (action.ok === false) {
    io.stderr(`skill: ${action.message}\n`);
    return 1;
  }

  const cwd = options.cwd ?? process.cwd();
  const pluginCatalog = await loadPluginCatalog({
    cwd,
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  for (const warning of pluginCatalog.warnings) io.stderr(`[plugin] ${warning}\n`);
  const catalog = await loadSkillCatalog({
    cwd,
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    extraRoots: pluginCatalog.skillRoots,
  });
  for (const warning of catalog.warnings) io.stderr(`[skill] ${warning}\n`);

  switch (action.kind) {
    case "list":
      return runList(catalog.skills, io);
    case "show":
      return runShow(catalog.skills, action.name, io);
  }
}

type ParsedAction =
  | { readonly ok: true; readonly kind: "list" }
  | { readonly ok: true; readonly kind: "show"; readonly name: string }
  | { readonly ok: false; readonly message: string };

function parseAction(args: readonly string[]): ParsedAction {
  const [kind, first, ...rest] = args;
  if (kind === undefined || kind === "list") return parseList(first, rest);
  if (kind === "show") return parseShow(first, rest);
  return { ok: false, message: "expected list or show" };
}

function parseList(extra: string | undefined, rest: readonly string[]): ParsedAction {
  if (extra !== undefined || rest.length > 0) {
    return { ok: false, message: "usage: nova-code skill list" };
  }
  return { ok: true, kind: "list" };
}

function parseShow(name: string | undefined, rest: readonly string[]): ParsedAction {
  if (name === undefined || rest.length > 0) {
    return { ok: false, message: "usage: nova-code skill show <name>" };
  }
  return { ok: true, kind: "show", name };
}

function runList(skills: readonly LoadedSkill[], io: SkillCommandIO): number {
  if (skills.length === 0) {
    io.stdout("No skills found.\n");
    return 0;
  }
  for (const skill of skills) {
    io.stdout(formatSkillListItem(skill));
  }
  return 0;
}

function runShow(skills: readonly LoadedSkill[], name: string, io: SkillCommandIO): number {
  const skill = findSkill(skills, name);
  if (skill === undefined) {
    io.stderr(`skill: not found: ${name}\n`);
    return 1;
  }
  io.stdout(formatSkillDetails(skill));
  return 0;
}

function findSkill(skills: readonly LoadedSkill[], name: string): LoadedSkill | undefined {
  const normalized = name.toLowerCase();
  return skills.find((skill) => skill.name.toLowerCase() === normalized);
}

function formatSkillListItem(skill: LoadedSkill): string {
  const description = formatSkillListValue(skill.description || "(none)");
  const path = formatSkillListValue(skill.path);
  return `${skill.name}:\n${description}\n${path}\n\n`;
}

function formatSkillListValue(value: string): string {
  const [firstLine = "", ...restLines] = value.split(/\r?\n/);
  const lines = [`\t- ${firstLine}`, ...restLines.map((line) => `\t${line}`)];
  return lines.join("\n");
}

function formatSkillDetails(skill: LoadedSkill): string {
  const details = [
    `Name: ${skill.name}`,
    `Description: ${skill.description || "(none)"}`,
    `Manual only: ${skill.metadata.manualOnly ? "yes" : "no"}`,
    `Model invocable: ${skill.metadata.disableModelInvocation ? "no" : "yes"}`,
    `User invocable: ${skill.metadata.userInvocable ? "yes" : "no"}`,
    `Path: ${skill.path}`,
    "",
    skill.body,
  ];
  return `${details.join("\n")}\n`;
}

function defaultIO(): SkillCommandIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}
