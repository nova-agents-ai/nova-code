import { describe, expect, test } from "bun:test";
import type { LoadedSkill } from "../../services/skills/index.ts";
import { createSkillTool } from "./SkillTool.ts";

const javaSkill: LoadedSkill = {
  name: "java",
  description: "Java JVM backend skill.",
  path: "/tmp/java/SKILL.md",
  directory: "/tmp/java",
  body: "# Java\nUse JVM guidance. $ARGUMENTS",
  metadata: {
    name: "java",
    description: "Java JVM backend skill.",
    disableModelInvocation: false,
    manualOnly: false,
  },
};

describe("SkillTool", () => {
  test("loads skill body on invocation", async () => {
    const tool = createSkillTool([javaSkill]);

    const result = await tool?.execute(
      { skill: "/java", args: "review service" },
      newAbortContext(),
    );

    expect(result).toContain("Base directory for this skill: /tmp/java");
    expect(result).toContain("Use JVM guidance. review service");
  });

  test("returns undefined when all skills disable model invocation", () => {
    const tool = createSkillTool([
      {
        ...javaSkill,
        metadata: { ...javaSkill.metadata, disableModelInvocation: true },
      },
    ]);

    expect(tool).toBeUndefined();
  });
});

function newAbortContext(): { readonly signal: AbortSignal } {
  return { signal: new AbortController().signal };
}
