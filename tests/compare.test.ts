import assert from "node:assert/strict";
import test from "node:test";
import { compareMetricValues, compareRuns } from "../src/analytics/compare.js";
import type { MetricMeasurement, RunResult } from "../src/types.js";
import { SCHEMA_VERSION } from "../src/types.js";

test("lower-is-better paired improvement passes a percent regression gate", () => {
  const result = compareMetricValues(
    {
      metric: "frame.present.interval_ms.p95",
      before: [20, 21, 19, 20, 20],
      after: [18, 19, 17, 18, 18],
      unit: "ms",
      source: "presentmon",
      gate: { metric: "frame.present.interval_ms.p95", maxRegressionPercent: 5 },
    },
    { iterations: 2_000, seed: 7 },
  );
  assert.equal(result.verdict, "improved");
  assert.equal(result.gate.passed, true);
  assert.equal(result.paired?.deltaAbsolute, -2);
  assert.ok((result.paired?.improvementPercent ?? 0) > 9);
});

test("higher-is-better regression fails when its confidence interval clears the threshold", () => {
  const result = compareMetricValues(
    {
      metric: "frame.present.fps_1pct_low",
      before: [60, 61, 59, 60, 60],
      after: [50, 51, 49, 50, 50],
      unit: "fps",
      source: "presentmon",
      gate: { metric: "frame.present.fps_1pct_low", maxRegressionPercent: 5 },
    },
    { iterations: 2_000, seed: 7 },
  );
  assert.equal(result.verdict, "regressed");
  assert.equal(result.gate.passed, false);
});

test("fewer than five pairs is descriptive and inconclusive", () => {
  const result = compareMetricValues({
    metric: "cpu.process_tree.core_percent.mean",
    before: [50, 51, 49],
    after: [40, 41, 39],
    unit: "percent",
    source: "process-tree",
    gate: { metric: "cpu.process_tree.core_percent.mean", maxRegressionPercent: 10 },
  });
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.gate.passed, undefined);
});

test("a zero baseline preserves absolute delta but makes percentage gates inconclusive", () => {
  const result = compareMetricValues(
    {
      metric: "custom.counter",
      before: [0, 0, 0, 0, 0],
      after: [0, 1, 0, 0, 0],
      unit: "count",
      source: "custom",
      direction: "lower",
      gate: { metric: "custom.counter", maxRegressionPercent: 5 },
    },
    { iterations: 500, seed: 5 },
  );
  assert.equal(result.paired?.deltaPercent, undefined);
  assert.equal(result.paired?.ratio, undefined);
  assert.equal(result.verdict, "inconclusive");
});

test("zero-direction hard invariants fail when any candidate run is nonzero", () => {
  const result = compareMetricValues(
    {
      metric: "stability.crash_count",
      before: [0, 0, 0, 0, 0],
      after: [0, 0, 1, 0, 0],
      unit: "count",
      source: "runner",
      gate: { metric: "stability.crash_count", maxAbsolute: 0 },
    },
    { iterations: 500, seed: 5 },
  );
  assert.equal(result.verdict, "regressed");
  assert.equal(result.gate.passed, false);
});

test("compareRuns pairs by index, preserves target sources, and honors explicit comparability", () => {
  const before = [0, 1, 2, 3, 4].map((index) => run("three", index, "frame.present.interval_ms.p95", 20 + index * 0.1));
  const after = [4, 2, 0, 3, 1].map((index) => run("unity", index, "frame.present.interval_ms.p95", 18 + index * 0.1));
  const result = compareRuns(before, after, {
    createdAt: "2026-08-31T00:00:00.000Z",
    iterations: 1_000,
    seed: 11,
    gates: [{ metric: "frame.present.interval_ms.p95", maxRegressionPercent: 5 }],
  });
  assert.equal(result.pairCount, 5);
  assert.equal(result.verdict, "pass");
  assert.equal(result.metrics["frame.present.interval_ms.p95"]?.verdict, "improved");

  const crossSource = after.map((value) =>
    run("unity", value.index, "frame.present.interval_ms.p95", 18 + value.index * 0.1, "normalized-cadence"));
  const crossSourceResult = compareRuns(before, crossSource, {
    iterations: 500,
    seed: 3,
    gates: [{ metric: "frame.present.interval_ms.p95", maxRegressionPercent: 5 }],
  });
  assert.equal(crossSourceResult.metrics["frame.present.interval_ms.p95"]?.before?.source, "presentmon");
  assert.equal(crossSourceResult.metrics["frame.present.interval_ms.p95"]?.after?.source, "normalized-cadence");

  const nonComparable = after.map((value) =>
    run("unity", value.index, "frame.present.interval_ms.p95", 18, "unity-probe", false));
  const unavailable = compareRuns(before, nonComparable, {
    gates: [{ metric: "frame.present.interval_ms.p95", required: true }],
  });
  assert.equal(unavailable.metrics["frame.present.interval_ms.p95"]?.verdict, "unavailable");
  assert.equal(unavailable.verdict, "inconclusive");
});

function measurement(value: number, source = "presentmon", comparable = true): MetricMeasurement {
  return {
    status: "measured",
    value,
    unit: "ms",
    sampleCount: 1_000,
    source,
    comparable,
    coverageRatio: 1,
  };
}

function run(
  targetId: string,
  index: number,
  metric: string,
  value: number,
  source = "presentmon",
  comparable = true,
): RunResult {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: `${targetId}-${index}`,
    targetId,
    targetRuntime: targetId === "three" ? "web" : "unity",
    targetVariant: targetId === "three" ? "threejs-original" : "unity-native-assets",
    index,
    order: index,
    status: "completed",
    startedAt: "2026-08-31T00:00:00.000Z",
    endedAt: "2026-08-31T00:01:00.000Z",
    durationMs: 60_000,
    metrics: { [metric]: measurement(value, source, comparable) },
    artifacts: [],
    warnings: [],
    errors: [],
  };
}
