import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSkillCommand } from "./SkillCommand.ts";

interface Capture {
  readonly stdout: string[];
  readonly stderr: string[];
}

let tempDir: string;
let home: string;
let capture: Capture;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nova-skill-command-"));
  home = join(tempDir, "home");
  capture = { stdout: [], stderr: [] };
  await writeSkill("java", "Java JVM review skill.");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("skill command", () => {
  test("list 输出已加载 skill", async () => {
    const exitCode = await runSkillCommand(["list"], commandOptions());

    expect(exitCode).toBe(0);
    expect(stdout()).toContain("java");
    expect(stdout()).toContain("Java JVM review skill.");
  });

  test("show 输出 skill 详情", async () => {
    const exitCode = await runSkillCommand(["show", "java"], commandOptions());

    expect(exitCode).toBe(0);
    expect(stdout()).toContain("Name: java");
    expect(stdout()).toContain("Prefer checked exceptions guidance.");
  });

  test("match 输出自动激活结果", async () => {
    const exitCode = await runSkillCommand(
      ["match", "review", "java", "service"],
      commandOptions(),
    );

    expect(exitCode).toBe(0);
    expect(stdout()).toContain("java\tkeyword");
  });

  test("未知 action 返回 1", async () => {
    const exitCode = await runSkillCommand(["nope"], commandOptions());

    expect(exitCode).toBe(1);
    expect(stderr()).toContain("expected list, show, or match");
  });
});

function commandOptions(): Parameters<typeof runSkillCommand>[1] {
  return {
    cwd: tempDir,
    homeDir: home,
    io: {
      stdout: (text) => capture.stdout.push(text),
      stderr: (text) => capture.stderr.push(text),
    },
  };
}

function stdout(): string {
  return capture.stdout.join("");
}

function stderr(): string {
  return capture.stderr.join("");
}

async function writeSkill(name: string, description: string): Promise<void> {
  const dir = join(home, ".agents", "skills", name);
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}
Prefer checked exceptions guidance.
`,
  );
}
