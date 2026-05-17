import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatSkillInstructions,
  loadSkillCatalog,
  parseSkillDocument,
  resolveSkillRoots,
  selectSkills,
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
  test("按 root 加载 SKILL.md 并识别 manual-only", async () => {
    const home = join(tempDir, "home");
    const skillDir = join(home, ".agents", "skills", "gstack");
    await mkdir(skillDir, { recursive: true });
    await Bun.write(
      join(skillDir, "SKILL.md"),
      `---
name: gstack
description: MANUAL TRIGGER ONLY: invoke only when user types /gstack.
---
# GStack
Only explicit activation.
`,
    );

    const catalog = await loadSkillCatalog({ cwd: tempDir, homeDir: home });

    expect(catalog.warnings).toEqual([]);
    expect(catalog.skills).toHaveLength(1);
    expect(catalog.skills[0]?.name).toBe("gstack");
    expect(catalog.skills[0]?.metadata.manualOnly).toBe(true);
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

describe("skill matching and prompt", () => {
  test("manual-only skill 只响应显式 /name 触发", async () => {
    const home = join(tempDir, "home");
    await writeSkill(home, "gstack", "MANUAL TRIGGER ONLY: invoke only by /gstack.");
    const catalog = await loadSkillCatalog({ cwd: tempDir, homeDir: home });

    expect(selectSkills({ skills: catalog.skills, query: "please use gstack browser" })).toEqual(
      [],
    );
    const explicit = selectSkills({ skills: catalog.skills, query: "/gstack open the page" });
    expect(explicit[0]?.skill.name).toBe("gstack");
    expect(explicit[0]?.reason).toBe("explicit");
  });

  test("关键词激活非 manual-only skill 并格式化 prompt", async () => {
    const home = join(tempDir, "home");
    await writeSkill(home, "java", "Java concurrency review for JVM services.");
    const catalog = await loadSkillCatalog({ cwd: tempDir, homeDir: home });

    const activations = selectSkills({
      skills: catalog.skills,
      query: "review this Java concurrency code",
    });
    const prompt = formatSkillInstructions(activations);

    expect(activations[0]?.skill.name).toBe("java");
    expect(prompt).toContain("## Skill: java");
    expect(prompt).toContain("Always check thread safety.");
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
