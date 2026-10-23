import { expect, it } from "vitest";
import { serveCli } from "./cliServeHarness.js";

it.each(["symbols", "file_headers", "section_headers"])(
  "identifies a rejected symbol for objdump %s before target admission",
  async (operation) => {
    const result = await serveCli([
      "inspect-with-objdump",
      "/nonexistent/rea-input.bin",
      operation,
      "--symbol",
      "private-selector",
      "--json",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      retryable: false,
      details: {
        operation: "inspect_with_objdump",
        issues: [{ path: ["symbol"], reason: "unknown_argument" }],
      },
    });
    expect(result.stdout).not.toContain("private-selector");
  },
);
