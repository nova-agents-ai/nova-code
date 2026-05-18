import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPersistedConfig } from "../../config/config.ts";
import { runPluginCommand } from "./PluginCommand.ts";

let workDir: string;
let homeDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nova-plugin-command-work-"));
  homeDir = await mkdtemp(join(tmpdir(), "nova-plugin-command-home-"));
  await writePlugin(workDir, "demo");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
});

describe("plugin command", () => {
  test("list/validate/enable/disable/reload manage plugin state", async () => {
    const io = makeIO();
    const options = commandOptions(io);

    expect(await runPluginCommand(["list"], options)).toBe(0);
    expect(io.stdout.join("")).toContain("demo\tuntrusted\t0.1.0");

    expect(await runPluginCommand(["validate", "demo"], options)).toBe(0);
    expect(io.stdout.join("")).toContain("Valid plugin demo v0.1.0");

    expect(await runPluginCommand(["enable", "demo", "--yes"], options)).toBe(0);
    let config = await loadPersistedConfig({ homeDir });
    expect(config.plugins?.["demo"]?.enabled).toBe(true);
    expect(config.plugins?.["demo"]?.trusted).toBe(true);

    expect(
      await runPluginCommand(["reload"], {
        ...options,
        now: () => new Date("2026-05-18T00:00:00.000Z"),
      }),
    ).toBe(0);
    config = await loadPersistedConfig({ homeDir });
    expect(config.plugins?.["demo"]?.lastReloadedAt).toBe("2026-05-18T00:00:00.000Z");

    expect(await runPluginCommand(["disable", "demo"], options)).toBe(0);
    config = await loadPersistedConfig({ homeDir });
    expect(config.plugins?.["demo"]?.enabled).toBe(false);
  });

  test("validate accepts a plugin directory path", async () => {
    const io = makeIO();
    const pluginPath = join(workDir, ".nova-code", "plugins", "demo");

    const exitCode = await runPluginCommand(["validate", pluginPath], commandOptions(io));

    expect(exitCode).toBe(0);
    expect(io.stdout.join("")).toContain(`Valid plugin demo v0.1.0 at ${pluginPath}`);
  });
});

function commandOptions(io: ReturnType<typeof makeIO>) {
  return {
    cwd: workDir,
    configSource: { homeDir },
    io: io.io,
  };
}

function makeIO(): {
  readonly io: { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void };
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

async function writePlugin(cwd: string, name: string): Promise<void> {
  const pluginDir = join(cwd, ".nova-code", "plugins", name);
  await mkdir(pluginDir, { recursive: true });
  await Bun.write(
    join(pluginDir, "plugin.json"),
    JSON.stringify({ name, version: "0.1.0", description: "Plugin command fixture" }, null, 2),
  );
}
