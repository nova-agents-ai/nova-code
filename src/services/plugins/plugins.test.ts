import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPluginCommand } from "../../commands/PluginCommand/PluginCommand.ts";
import { loadPersistedConfig, savePersistedConfig } from "../../config/config.ts";
import { loadPluginCatalog, resolvePluginSlashInvocation } from "./index.ts";

let workDir: string;
let homeDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nova-plugins-work-"));
  homeDir = await mkdtemp(join(tmpdir(), "nova-plugins-home-"));
  await writeDemoPlugin(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
});

describe("plugin catalog", () => {
  test("discoveries are inert until trusted/enabled, then disappear after disable", async () => {
    const initial = await loadPluginCatalog({ cwd: workDir, homeDir });
    expect(initial.plugins.map((plugin) => plugin.name)).toEqual(["demo"]);
    expect(initial.plugins[0]?.enabled).toBe(false);
    expect(initial.skillRoots).toEqual([]);
    expect(initial.slashCommands).toEqual([]);
    expect(initial.ruleContributions).toEqual([]);

    const options = commandOptions();
    const enabled = await runPluginCommand(["enable", "demo", "--yes"], options);
    expect(enabled).toBe(0);

    const active = await loadPluginCatalog({ cwd: workDir, homeDir });
    expect(active.plugins[0]?.enabled).toBe(true);
    expect(active.skillRoots).toEqual([join(workDir, ".nova-code", "plugins", "demo", "skills")]);
    expect(active.slashCommands.map((command) => command.name)).toEqual(["demo:review"]);
    expect(active.slashCommands[0]?.body).toContain("PLUGIN_COMMAND_MARKER");
    expect(active.hooks.PostToolUse?.[0]?.hooks[0]?.command).toContain(
      join(workDir, ".nova-code", "plugins", "demo", "hook.ts"),
    );
    expect(Object.keys(active.mcpServers)).toEqual(["demo_echo"]);
    expect(active.ruleContributions[0]?.rulesPath).toBe(
      join(workDir, ".nova-code", "plugins", "demo", "rules"),
    );

    const disabled = await runPluginCommand(["disable", "demo"], options);
    expect(disabled).toBe(0);
    const inactive = await loadPluginCatalog({ cwd: workDir, homeDir });
    expect(inactive.plugins[0]?.enabled).toBe(false);
    expect(inactive.skillRoots).toEqual([]);
    expect(inactive.slashCommands).toEqual([]);
    expect(inactive.hooks).toEqual({});
    expect(inactive.mcpServers).toEqual({});
    expect(inactive.ruleContributions).toEqual([]);
  });

  test("enable requires explicit trust confirmation", async () => {
    const io = makeIO();
    const exitCode = await runPluginCommand(["enable", "demo"], {
      ...commandOptions(),
      io: io.io,
    });

    expect(exitCode).toBe(1);
    expect(io.stderr.join("")).toContain("untrusted");
    const config = await loadPersistedConfig({ homeDir });
    expect(config.plugins?.["demo"]).toBeUndefined();
  });

  test("trust invalidates when plugin path drifts (e.g. globally-trusted name reused elsewhere)", async () => {
    await runPluginCommand(["enable", "demo", "--yes"], commandOptions());
    const stored = await loadPersistedConfig({ homeDir });
    expect(stored.plugins?.["demo"]?.path).toBe(join(workDir, ".nova-code", "plugins", "demo"));

    // Simulate another project (different absolute path) reusing the name.
    await savePersistedConfig(
      {
        plugins: {
          demo: {
            ...stored.plugins?.["demo"],
            path: "/some/other/project/.nova-code/plugins/demo",
          },
        },
      },
      { homeDir },
    );

    const drifted = await loadPluginCatalog({ cwd: workDir, homeDir });
    expect(drifted.plugins[0]?.trusted).toBe(false);
    expect(drifted.plugins[0]?.enabled).toBe(false);
    expect(drifted.warnings.some((line) => line.includes("path-changed"))).toBe(true);
  });

  test("trust invalidates when manifest version drifts after enable", async () => {
    await runPluginCommand(["enable", "demo", "--yes"], commandOptions());

    // Author bumps manifest version after the user trusted v1.0.0.
    await Bun.write(
      join(workDir, ".nova-code", "plugins", "demo", "plugin.json"),
      JSON.stringify({ name: "demo", version: "2.0.0", description: "Demo plugin" }, null, 2),
    );

    const drifted = await loadPluginCatalog({ cwd: workDir, homeDir });
    expect(drifted.plugins[0]?.trusted).toBe(false);
    expect(drifted.warnings.some((line) => line.includes("version-changed"))).toBe(true);
  });

  test("$NOVA_PLUGIN_ROOT respects identifier word boundary in hook command", async () => {
    const pluginDir = join(workDir, ".nova-code", "plugins", "demo");
    await Bun.write(
      join(pluginDir, "hooks", "hooks.json"),
      JSON.stringify({
        PostToolUse: [
          {
            matcher: "FileRead",
            hooks: [
              {
                type: "command",
                // `$NOVA_PLUGIN_ROOTSUFFIX` must NOT be replaced — it's a different
                // (unrelated) identifier that happens to share a prefix.
                command:
                  "echo $" +
                  "{NOVA_PLUGIN_ROOT}/braced && echo $NOVA_PLUGIN_ROOT/bare && echo $NOVA_PLUGIN_ROOTSUFFIX",
              },
            ],
          },
        ],
      }),
    );

    await runPluginCommand(["enable", "demo", "--yes"], commandOptions());
    const catalog = await loadPluginCatalog({ cwd: workDir, homeDir });
    const command = catalog.hooks.PostToolUse?.[0]?.hooks[0]?.command ?? "";
    expect(command).toContain(`${pluginDir}/braced`);
    expect(command).toContain(`${pluginDir}/bare`);
    // The unrelated identifier must remain literal.
    expect(command).toContain("$NOVA_PLUGIN_ROOTSUFFIX");
    expect(command).not.toContain(`${pluginDir}SUFFIX`);
  });

  test("plugin slash command always replaces $ARGUMENTS, even when args is empty", async () => {
    await runPluginCommand(["enable", "demo", "--yes"], commandOptions());
    const catalog = await loadPluginCatalog({ cwd: workDir, homeDir });
    const noArgs = resolvePluginSlashInvocation("/demo:review", catalog.slashCommands);
    expect(noArgs?.prompt ?? "").toContain("PLUGIN_COMMAND_MARKER ");
    expect(noArgs?.prompt ?? "").not.toContain("$ARGUMENTS");

    const withArgs = resolvePluginSlashInvocation("/demo:review src/a.ts", catalog.slashCommands);
    expect(withArgs?.prompt ?? "").toContain("PLUGIN_COMMAND_MARKER src/a.ts");
  });
});

function commandOptions() {
  return {
    cwd: workDir,
    configSource: { homeDir },
    io: makeIO().io,
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

async function writeDemoPlugin(cwd: string): Promise<void> {
  const pluginDir = join(cwd, ".nova-code", "plugins", "demo");
  await mkdir(join(pluginDir, "skills", "demo-skill"), { recursive: true });
  await mkdir(join(pluginDir, "commands"), { recursive: true });
  await mkdir(join(pluginDir, "hooks"), { recursive: true });
  await mkdir(join(pluginDir, "rules"), { recursive: true });
  await Bun.write(
    join(pluginDir, "plugin.json"),
    JSON.stringify(
      {
        name: "demo",
        version: "1.0.0",
        description: "Demo plugin",
        mcpServers: {
          echo: { command: "bun", args: ["$" + "{NOVA_PLUGIN_ROOT}/mcp.ts"] },
        },
      },
      null,
      2,
    ),
  );
  await Bun.write(
    join(pluginDir, "skills", "demo-skill", "SKILL.md"),
    "---\ndescription: Demo plugin skill.\n---\nPLUGIN_SKILL_BODY_MARKER\n",
  );
  await Bun.write(
    join(pluginDir, "commands", "review.md"),
    "---\ndescription: Review with demo plugin.\n---\nPLUGIN_COMMAND_MARKER $ARGUMENTS\n",
  );
  await Bun.write(
    join(pluginDir, "hooks", "hooks.json"),
    JSON.stringify({
      PostToolUse: [
        {
          matcher: "FileRead",
          hooks: [{ type: "command", command: "bun $" + "{NOVA_PLUGIN_ROOT}/hook.ts" }],
        },
      ],
    }),
  );
  await Bun.write(join(pluginDir, "hook.ts"), "console.log('ok')\n");
  await Bun.write(
    join(pluginDir, "rules", "typescript.md"),
    '---\npaths: ["src/**/*.ts"]\n---\nPLUGIN_RULE_MARKER\n',
  );
}
