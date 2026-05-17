import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatSkillListingInstructions,
  loadSkillCatalog,
  parseSkillDocument,
  resolveSkillRoots,
} from "./index.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nova-skills-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("skills frontmatter", () => {
  test("解析 block scalar 与数组字段", () => {
    const parsed = parseSkillDocument(`---
name: java
version: 1.2.3
description: |
  Java code review skill.
  Prefer concurrency safety.
allowed-tools:
  - Read
  - Grep
preamble-tier: 1
---
# Body
Use this body.
`);

    expect(parsed.frontmatter["name"]).toBe("java");
    expect(parsed.frontmatter["version"]).toBe("1.2.3");
    expect(parsed.frontmatter["description"]).toBe(
      "Java code review skill.\nPrefer concurrency safety.",
    );
    expect(parsed.frontmatter["allowed-tools"]).toEqual(["Read", "Grep"]);
    expect(parsed.frontmatter["preamble-tier"]).toBe(1);
    expect(parsed.body).toContain("Use this body.");
  });
});

describe("skill catalog loading", () => {
  test("按 root 的直接子目录加载 SKILL.md 并识别 manual-only", async () => {
    const home = join(tempDir, "home");
    await writeSkill(home, "gstack", "MANUAL TRIGGER ONLY: invoke only when user types /gstack.");

    const catalog = await loadSkillCatalog({ cwd: tempDir, homeDir: home });

    expect(catalog.warnings).toEqual([]);
    expect(catalog.skills).toHaveLength(1);
    expect(catalog.skills[0]?.name).toBe("gstack");
    expect(catalog.skills[0]?.metadata.manualOnly).toBe(true);
  });

  test("不递归扫描嵌套子目录下的 SKILL.md", async () => {
    const home = join(tempDir, "home");
    const nestedDir = join(home, ".agents", "skills", "parent", "child");
    await mkdir(nestedDir, { recursive: true });
    await Bun.write(
      join(nestedDir, "SKILL.md"),
      `---
name: child
description: Nested skill should not be loaded.
---
# Nested
`,
    );

    const catalog = await loadSkillCatalog({ cwd: tempDir, homeDir: home });

    expect(catalog.skills).toEqual([]);
  });

  test("NOVA_SKILL_DIRS 覆盖默认 roots", () => {
    const roots = resolveSkillRoots({
      cwd: tempDir,
      homeDir: join(tempDir, "home"),
      env: { NOVA_SKILL_DIRS: "./skills-a,~/skills-b" },
    });

    expect(roots).toEqual([join(tempDir, "skills-a"), join(tempDir, "home", "skills-b")]);
  });
});

describe("skill prompt", () => {
  test("模型可见 prompt 只包含 skill 列表，不包含正文", async () => {
    const home = join(tempDir, "home");
    await writeSkill(home, "java", "Java concurrency review for JVM services.");
    const catalog = await loadSkillCatalog({ cwd: tempDir, homeDir: home });

    const prompt = formatSkillListingInstructions(catalog.skills);

    expect(prompt).toContain("The following skills are available");
    expect(prompt).toContain("- java: Java concurrency review for JVM services.");
    expect(prompt).not.toContain("Always check thread safety.");
  });

  test("disable-model-invocation 的 skill 不进入模型可见 listing", async () => {
    const home = join(tempDir, "home");
    await writeSkill(home, "java", "Java concurrency review for JVM services.");
    await writeDisabledSkill(home, "debug", "Debug current session internals.");
    const catalog = await loadSkillCatalog({ cwd: tempDir, homeDir: home });

    const prompt = formatSkillListingInstructions(catalog.skills);

    expect(catalog.skills.map((skill) => skill.name)).toEqual(["debug", "java"]);
    expect(prompt).toContain("- java: Java concurrency review for JVM services.");
    expect(prompt).not.toContain("debug");
    expect(prompt).not.toContain("Debug current session internals.");
  });

  test("只有 disable-model-invocation skill 时不生成 listing", async () => {
    const home = join(tempDir, "home");
    await writeDisabledSkill(home, "debug", "Debug current session internals.");
    const catalog = await loadSkillCatalog({ cwd: tempDir, homeDir: home });

    expect(formatSkillListingInstructions(catalog.skills)).toBeUndefined();
  });
});

async function writeSkill(home: string, name: string, description: string): Promise<void> {
  const dir = join(home, ".agents", "skills", name);
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}
Always check thread safety.
`,
  );
}

async function writeDisabledSkill(home: string, name: string, description: string): Promise<void> {
  const dir = join(home, ".agents", "skills", name);
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
disable-model-invocation: true
---
# ${name}
Disabled skill body.
`,
  );
}
