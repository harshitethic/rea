import { expect, it } from "vitest";
import {
  scenarioCaptureFixture,
  scenarioCaptureEvidence,
} from "../../fixtures/browserScenarioCapture.js";
import { sanitizeBrowserUrl } from "../../../src/domain/browserObservation.js";
import { browserScenarioCaptureSchema } from "../../../src/domain/browserScenarioCapture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { serveCli } from "./cliServeHarness.js";

it.each([
  { url: "data:text/plain,no-origin", usable: false, control: false },
  { url: "file:///public/example.txt", usable: false, control: false },
  { url: "blob:https://example.test/resource", usable: false, control: false },
  { url: "not a url", usable: false, control: false },
  { url: "https://example.test/api/control", usable: true, control: false },
  { url: "data:text/plain,no-origin", usable: false, control: true },
])(
  "CLI counts only usable scenario requests: $url (control: $control)",
  async ({ url, usable, control }) => {
    const original = scenarioCaptureFixture([
      { method: "GET", url: "/api/control" },
      ...(control ? [{ method: "GET", url: "/api/other" }] : []),
    ]);
    let firstRequest = true;
    const capture = browserScenarioCaptureSchema.parse({
      ...original,
      events: {
        ...original.events,
        items: original.events.items.map((event) => {
          if (event.kind !== "request" || !firstRequest) return event;
          firstRequest = false;
          return { ...event, url: sanitizeBrowserUrl(url) };
        }),
      },
    });
    const response = await serveCli([
      "inspect-analysis-view",
      JSON.stringify({
        source: { kind: "inline", evidence: scenarioCaptureEvidence(capture) },
        view: { kind: "environment-manifest" },
      }),
      "--json",
    ]);
    expect(response.exitCode).toBe(0);
    const result = parseEvidence(JSON.parse(response.stdout))
      .normalized_result as {
      records: unknown[];
      limitations: string[];
    };
    const represented = Number(usable) + Number(control);
    expect(result.records).toHaveLength(represented);
    const bodyLimitations = result.limitations.filter((limitation) =>
      limitation.includes("retained no response body"),
    );
    expect(bodyLimitations).toEqual(
      represented === 0
        ? []
        : [
            `${String(represented)} of ${String(represented)} scenario transactions with a usable request line retained no response body; tools citing them replay only the recorded status and content type, either of which may be absent.`,
          ],
    );
    expect(
      result.limitations.includes(
        "1 retained records without a usable request line are not represented in the manifest.",
      ),
    ).toBe(!usable);
  },
);
