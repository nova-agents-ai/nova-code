/** `nova-code skill`：查看与调试 M9 Skills 加载和自动激活。 */

import type { LoadedSkill, SkillEnvironment } from "../../services/skills/index.ts";
import { loadSkillCatalog, selectSkills } from "../../services/skills/index.ts";
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
  description: "查看可用 Skills，并调试按 query 自动激活结果",
  usage:
    "nova-code skill list\n" + "nova-code skill show <name>\n" + "nova-code skill match <query...>",
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

  const catalog = await loadSkillCatalog({
    cwd: options.cwd ?? process.cwd(),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  for (const warning of catalog.warnings) io.stderr(`[skill] ${warning}\n`);

  switch (action.kind) {
    case "list":
      return runList(catalog.skills, io);
    case "show":
      return runShow(catalog.skills, action.name, io);
    case "match":
      return runMatch(catalog.skills, action.query, io);
  }
}

type ParsedAction =
  | { readonly ok: true; readonly kind: "list" }
  | { readonly ok: true; readonly kind: "show"; readonly name: string }
  | { readonly ok: true; readonly kind: "match"; readonly query: string }
  | { readonly ok: false; readonly message: string };

function parseAction(args: readonly string[]): ParsedAction {
  const [kind, first, ...rest] = args;
  if (kind === undefined || kind === "list") return parseList(first, rest);
  if (kind === "show") return parseShow(first, rest);
  if (kind === "match") return parseMatch(first, rest);
  return { ok: false, message: "expected list, show, or match" };
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

function parseMatch(first: string | undefined, rest: readonly string[]): ParsedAction {
  if (first === undefined) return { ok: false, message: "usage: nova-code skill match <query...>" };
  return { ok: true, kind: "match", query: [first, ...rest].join(" ") };
}

function runList(skills: readonly LoadedSkill[], io: SkillCommandIO): number {
  if (skills.length === 0) {
    io.stdout("No skills found.\n");
    return 0;
  }
  for (const skill of skills) {
    io.stdout(`${skill.name}\t${skill.description}\t${skill.path}\n`);
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

function runMatch(skills: readonly LoadedSkill[], query: string, io: SkillCommandIO): number {
  const activations = selectSkills({ skills, query });
  if (activations.length === 0) {
    io.stdout("No skills matched.\n");
    return 0;
  }
  for (const activation of activations) {
    const terms = activation.matchedTerms.length > 0 ? activation.matchedTerms.join(",") : "n/a";
    io.stdout(
      `${activation.skill.name}\t${activation.reason}\tscore=${activation.score}\t${terms}\n`,
    );
  }
  return 0;
}

function findSkill(skills: readonly LoadedSkill[], name: string): LoadedSkill | undefined {
  const normalized = name.toLowerCase();
  return skills.find((skill) => skill.name.toLowerCase() === normalized);
}

function formatSkillDetails(skill: LoadedSkill): string {
  const details = [
    `Name: ${skill.name}`,
    `Description: ${skill.description || "(none)"}`,
    `Manual only: ${skill.metadata.manualOnly ? "yes" : "no"}`,
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
