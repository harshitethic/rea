import { expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "trace-native-values rejects an explicit empty procedure before opening a target",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: [
        "trace-native-values",
        "/missing/rea-fixture",
        "",
        "--format",
        "json",
      ],
      timeoutMs: 10_000,
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stdout).toContain("procedure");
    expect(result.stdout).not.toContain("Target path");
  },
);

cliTest(
  "trace-native-values exposes the nonempty procedure contract",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: ["trace-native-values", "--schema", "--json"],
      timeoutMs: 10_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      args?: { properties?: { procedure?: { minLength?: number } } };
    };
    expect(parsed.args?.properties?.procedure?.minLength).toBe(1);
  },
);
