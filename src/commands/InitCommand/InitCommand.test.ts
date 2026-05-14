import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInitCommand } from "./InitCommand.ts";

interface Capture {
  readonly stdout: string[];
  readonly stderr: string[];
}

async function makeTempDir(): Promise<{
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "nova-init-command-test-"));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function createCapture(): Capture {
  return { stdout: [], stderr: [] };
}

describe("init command", () => {
  test("生成 CLAUDE.md", async () => {
    const { dir, cleanup } = await makeTempDir();
    const capture = createCapture();
    try {
      const exitCode = await runInitCommand([], {
        cwd: dir,
        io: {
          stdout: (text) => capture.stdout.push(text),
          stderr: (text) => capture.stderr.push(text),
        },
      });
      expect(exitCode).toBe(0);
      const content = await Bun.file(join(dir, "CLAUDE.md")).text();
      expect(content).toContain("# CLAUDE.md");
      expect(content).toContain("Project instructions");
    } finally {
      await cleanup();
    }
  });

  test("已有 CLAUDE.md 时拒绝覆盖，--force 允许覆盖", async () => {
    const { dir, cleanup } = await makeTempDir();
    const capture = createCapture();
    try {
      await Bun.write(join(dir, "CLAUDE.md"), "existing");
      const first = await runInitCommand([], {
        cwd: dir,
        io: {
          stdout: (text) => capture.stdout.push(text),
          stderr: (text) => capture.stderr.push(text),
        },
      });
      expect(first).toBe(1);
      expect(await Bun.file(join(dir, "CLAUDE.md")).text()).toBe("existing");

      const second = await runInitCommand(["--force"], {
        cwd: dir,
        io: {
          stdout: (text) => capture.stdout.push(text),
          stderr: (text) => capture.stderr.push(text),
        },
      });
      expect(second).toBe(0);
      expect(await Bun.file(join(dir, "CLAUDE.md")).text()).toContain("# CLAUDE.md");
    } finally {
      await cleanup();
    }
  });
});
