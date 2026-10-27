import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "Antigravity setup does not make the shared Gemini parent evidence of Gemini CLI",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-antigravity-not-gemini-");
    const run = (args: readonly string[]) =>
      cli.run({
        arguments: ["setup", ...args, "--skill=false", "--json"],
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          TMPDIR: home,
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_DATA_HOME: join(home, "data"),
          XDG_CACHE_HOME: join(home, "cache"),
          XDG_STATE_HOME: join(home, "state"),
        },
        timeoutMs: 20_000,
      });
    const configured = await run(["--client", "antigravity", "--yes"]);
    expect(configured.exitCode, configured.stderr).toBe(0);
    await expect(
      access(join(home, ".gemini/settings.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    const broad = await run(["--all-detected", "--dry-run"]);
    expect(broad.exitCode, broad.stderr).toBe(0);
    const broadPlan = JSON.parse(broad.stdout) as {
      plannedActions: Array<{ id: string }>;
      clientStates: Array<{ client: { name: string }; detected: boolean }>;
    };
    expect(broadPlan.plannedActions).not.toContainEqual({
      id: "configure_client:gemini_cli",
    });
    expect(broadPlan.clientStates).toContainEqual(
      expect.objectContaining({
        client: expect.objectContaining({ name: "gemini_cli" }),
        detected: false,
      }),
    );
    await mkdir(join(home, ".gemini"), { recursive: true });
    await writeFile(join(home, ".gemini/settings.json"), "{}");
    const withGemini = await run(["--all-detected", "--dry-run"]);
    expect(withGemini.exitCode, withGemini.stderr).toBe(0);
    const geminiPlan = JSON.parse(withGemini.stdout) as {
      clientStates: Array<{ client: { name: string }; detected: boolean }>;
    };
    expect(geminiPlan.clientStates).toContainEqual(
      expect.objectContaining({
        client: expect.objectContaining({ name: "gemini_cli" }),
        detected: true,
      }),
    );
  },
);
