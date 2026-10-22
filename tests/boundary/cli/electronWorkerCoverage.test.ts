import { expect, it } from "vitest";
import { JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE } from "../../../src/contracts/javascript/javascriptRuntimeReconciliationExample.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "../../../src/domain/javascript/javascriptApplicationGraph.js";
import { createJavaScriptSemanticGraph } from "../../../src/domain/javascript/javascriptSemanticGraph.js";
import { electronPageInspectionSchema } from "../../../src/domain/javascript/electronObservation.js";
import { javascriptRuntimeReconciliationResultSchema } from "../../../src/domain/javascript/javascriptRuntimeReconciliationSchemas.js";
import { serveCli } from "./cliServeHarness.js";

const application = () => {
  const evidence =
    JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE.static_layers[0]!.analysis;
  const result = javascriptApplicationAnalysisResultSchema.parse(
    evidence.normalized_result,
  );
  const asset = result.graph.nodes[0]!;
  const worker = createJavaScriptApplicationNode({
    kind: asset.kind,
    identity: {
      strategy: "content-digest",
      stability: "global-exact",
      sha256: "9".repeat(64),
    },
    observations: asset.observations.map((observation) => ({
      label: "worker.js",
      properties: { path: "worker.js", bytes: 1 },
      evidence: {
        ...observation.evidence,
        artifact: {
          available: true,
          artifact_id: `art_${"9".repeat(64)}`,
          sha256: "9".repeat(64),
        },
        location: {
          available: true,
          value: { kind: "artifact-path", path: "worker.js" },
        },
      },
    })),
  });
  const graph = createJavaScriptApplicationGraph({
    schema: result.graph.schema,
    root_node_ids: result.graph.root_node_ids,
    edges: result.graph.edges,
    coverage: result.graph.coverage,
    limitations: result.graph.limitations,
    nodes: [...result.graph.nodes, worker],
  });
  const { graph_id: _graphId, ...semantic } = result.semantic_graph;
  return {
    workerId: worker.node_id,
    analysis: createEvidence(
      {
        path: result.input_path,
        sha256: result.root_artifact_sha256,
        format: result.format,
      },
      evidence.provider,
      {
        predicateType: evidence.predicate_type,
        operation: evidence.operation,
        parameters: evidence.parameters,
        authority: evidence.authority,
        confidence: evidence.confidence,
        result: {
          ...result,
          graph,
          semantic_graph: createJavaScriptSemanticGraph({
            ...semantic,
            application_graph_id: graph.graph_id,
          }),
        },
      },
    ),
  };
};

it.each([
  "complete",
  "workers-unavailable",
  "workers-truncated",
  "workers-attach-limited",
  "scripts-unavailable",
] as const)(
  "CLI preserves uncertainty and positive matches for %s Electron captures",
  async (coverage) => {
    const { analysis, workerId } = application();
    const evidence =
      JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE.runtime_observations[0]!;
    const inspection = electronPageInspectionSchema.parse(
      evidence.normalized_result,
    );
    const section = coverage === "scripts-unavailable" ? "scripts" : "workers";
    const truncated = coverage === "workers-truncated";
    const runtime = createEvidence(undefined, evidence.provider, {
      predicateType: evidence.predicate_type,
      operation: evidence.operation,
      parameters: evidence.parameters,
      authority: evidence.authority,
      confidence: evidence.confidence,
      result: {
        ...inspection,
        completeness:
          coverage === "complete"
            ? inspection.completeness
            : {
                ...inspection.completeness,
                status: truncated ? "truncated" : "attach_limited",
                conditions: [truncated ? "truncated" : "attach_limited"],
                truncated_sections: truncated ? [section] : [],
                attach_limited_sections: truncated ? [] : [section],
                unavailable_sections: coverage.endsWith("unavailable")
                  ? [section]
                  : [],
              },
      },
    });
    const response = await serveCli([
      "reconcile-javascript-runtime",
      JSON.stringify({
        static_layers: [{ analysis }],
        runtime_observations: [runtime],
      }),
      "--json",
    ]);
    expect(response.exitCode).toBe(0);
    const result = javascriptRuntimeReconciliationResultSchema.parse(
      parseEvidence(JSON.parse(response.stdout)).normalized_result,
    );
    const complete = coverage === "complete";
    expect(result.runtime_captures[0]?.scripts_complete_within_scope).toBe(
      complete,
    );
    expect(
      result.static_load_states.find(
        ({ static_node_id }) => static_node_id === workerId,
      ),
    ).toMatchObject({
      status: complete ? "not-observed-in-capture" : "unknown",
      reason: complete
        ? "not-observed-in-bounded-capture"
        : "static-or-runtime-coverage-incomplete",
    });
    expect(result.summary.static_not_observed).toBe(complete ? 1 : 0);
    expect(
      result.static_load_states.some(({ status }) => status === "loaded"),
    ).toBe(true);
  },
);
