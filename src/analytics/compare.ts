import { getMetricDefinition, metricDirection } from "../metrics.js";
import type {
  BenchmarkTarget,
  ComparisonResult,
  GateEvaluation,
  MetricComparison,
  MetricDirection,
  MetricGate,
  MetricMeasurement,
  MetricVerdict,
  RunResult,
  StructuredIssue,
  TargetMetricSummary,
} from "../types.js";
import { SCHEMA_VERSION } from "../types.js";
import {
  bootstrapMedianConfidenceInterval,
  type BootstrapOptions,
  median,
  pairedDifferences,
  pairedPercentChanges,
  pairedRatios,
  summarize,
} from "./statistics.js";

export interface CompareOptions extends BootstrapOptions {
  comparisonId?: string;
  createdAt?: string;
  gates?: readonly MetricGate[];
  minimumPairsForInference?: number;
}

export interface CompareMetricValuesInput {
  metric: string;
  before: readonly number[];
  after: readonly number[];
  unit: string;
  source?: string;
  beforeSource?: string;
  afterSource?: string;
  direction?: MetricDirection;
  gate?: MetricGate;
  expectedPairCount?: number;
  sampleCounts?: readonly number[];
  coverageRatios?: readonly (number | undefined)[];
}

interface MetricPairs {
  before: number[];
  after: number[];
  sampleCounts: number[];
  coverageRatios: Array<number | undefined>;
  unit?: string;
  beforeSource?: string;
  afterSource?: string;
  incompatibleReason?: string;
}

interface GateDecision {
  evaluation: GateEvaluation;
  verdict: "pass" | "regression" | "inconclusive";
}

const DEFAULT_MINIMUM_PAIRS = 5;

export function compareMetricValues(
  input: CompareMetricValuesInput,
  options: CompareOptions = {},
): MetricComparison {
  if (input.before.length === 0 || input.before.length !== input.after.length) {
    return unavailableMetric(input, "Before and after require at least one aligned value.");
  }
  if (input.before.some((value) => !Number.isFinite(value))
    || input.after.some((value) => !Number.isFinite(value))) {
    return unavailableMetric(input, "Before and after values must be finite.");
  }

  const direction = input.direction ?? metricDirection(input.metric);
  const beforeSource = input.beforeSource ?? input.source;
  const afterSource = input.afterSource ?? input.source;
  if (beforeSource === undefined || afterSource === undefined) {
    return unavailableMetric(input, "Before and after metric sources are required.");
  }
  const beforeSummary = targetSummary(input.before, input.unit, beforeSource);
  const afterSummary = targetSummary(input.after, input.unit, afterSource);
  const differences = pairedDifferences(input.before, input.after);
  const percentChanges = pairedPercentChanges(input.before, input.after);
  const ratios = pairedRatios(input.before, input.after);
  const improvementValues = percentChanges === undefined
    ? undefined
    : direction === "lower"
      ? percentChanges.map((value) => -value)
      : direction === "higher"
        ? percentChanges
        : undefined;
  const confidenceValues = improvementValues ?? differences;
  const confidence95 = bootstrapMedianConfidenceInterval(confidenceValues, options);
  const paired = {
    count: input.before.length,
    deltaAbsolute: median(differences),
    ...(percentChanges === undefined ? {} : { deltaPercent: median(percentChanges) }),
    ...(ratios === undefined ? {} : { ratio: median(ratios) }),
    ...(improvementValues === undefined ? {} : { improvementPercent: median(improvementValues) }),
    confidenceBasis: improvementValues === undefined ? "deltaAbsolute" as const : "improvementPercent" as const,
    confidence95,
  };

  const minimumPairs = options.minimumPairsForInference ?? DEFAULT_MINIMUM_PAIRS;
  if (!Number.isInteger(minimumPairs) || minimumPairs <= 0) {
    throw new Error("minimumPairsForInference must be a positive integer.");
  }
  const expectedPairCount = input.expectedPairCount ?? input.before.length;
  const qualityReason = qualityProblem(input, expectedPairCount);
  if (qualityReason !== undefined) {
    return {
      metric: input.metric,
      unit: input.unit,
      direction,
      before: beforeSummary,
      after: afterSummary,
      paired,
      verdict: "inconclusive",
      gate: qualityGate(input.gate, qualityReason),
    };
  }

  const gateDecision = evaluateGate(
    input.metric,
    direction,
    input.after,
    improvementValues,
    confidence95,
    input.gate,
    input.before.length,
    minimumPairs,
    options,
  );
  const verdict = gateDecision.evaluation.configured
    ? gateVerdict(gateDecision.verdict, direction, confidence95, input.before.length, minimumPairs)
    : descriptiveVerdict(direction, confidence95, input.before.length, minimumPairs);

  return {
    metric: input.metric,
    unit: input.unit,
    direction,
    before: beforeSummary,
    after: afterSummary,
    paired,
    verdict,
    gate: gateDecision.evaluation,
  };
}

export function compareRuns(
  beforeRuns: readonly RunResult[],
  afterRuns: readonly RunResult[],
  options: CompareOptions = {},
): ComparisonResult {
  if (beforeRuns.length === 0 || afterRuns.length === 0) {
    throw new Error("compareRuns requires at least one before run and one after run.");
  }
  const beforeTargetId = oneTargetId(beforeRuns, "before");
  const afterTargetId = oneTargetId(afterRuns, "after");
  const pairs = pairCompletedRuns(beforeRuns, afterRuns);
  const gateMap = makeGateMap(options.gates ?? []);
  const metricIds = new Set<string>(gateMap.keys());
  for (const pair of pairs) {
    for (const id of Object.keys(pair.before.metrics)) metricIds.add(id);
    for (const id of Object.keys(pair.after.metrics)) metricIds.add(id);
  }

  const metrics: Record<string, MetricComparison> = {};
  const warnings: StructuredIssue[] = [];
  if (pairs.length < Math.min(beforeRuns.length, afterRuns.length)) {
    warnings.push({
      code: "UNPAIRED_RUNS",
      message: `Only ${pairs.length} completed run index pairs could be compared.`,
      scope: "comparison",
    });
  }

  for (const metricId of [...metricIds].sort()) {
    const collected = collectMetricPairs(pairs, metricId);
    const gate = gateMap.get(metricId);
    if (collected.incompatibleReason !== undefined
      || collected.before.length === 0
      || collected.unit === undefined
      || collected.beforeSource === undefined
      || collected.afterSource === undefined) {
      metrics[metricId] = unavailableMetric(
        {
          metric: metricId,
          unit: collected.unit ?? getMetricDefinition(metricId)?.unit ?? "unknown",
          ...(gate === undefined ? {} : { gate }),
        },
        collected.incompatibleReason ?? "No comparable measured pairs were available.",
      );
      continue;
    }
    metrics[metricId] = compareMetricValues(
      {
        metric: metricId,
        before: collected.before,
        after: collected.after,
        unit: collected.unit,
        beforeSource: collected.beforeSource,
        afterSource: collected.afterSource,
        direction: metricDirection(metricId),
        expectedPairCount: pairs.length,
        sampleCounts: collected.sampleCounts,
        coverageRatios: collected.coverageRatios,
        ...(gate === undefined ? {} : { gate }),
      },
      options,
    );
  }

  const gated = Object.values(metrics).filter((result) => result.gate.configured);
  const hasComparableMetric = Object.values(metrics).some((result) => result.verdict !== "unavailable");
  const verdict = gated.some((result) => result.gate.passed === false)
    ? "regression"
    : pairs.length === 0 || !hasComparableMetric
      ? "inconclusive"
      : gated.some((result) => result.gate.passed === undefined)
      ? "inconclusive"
      : "pass";

  return {
    schemaVersion: SCHEMA_VERSION,
    comparisonId: options.comparisonId ?? `${beforeTargetId}-vs-${afterTargetId}`,
    createdAt: options.createdAt ?? new Date().toISOString(),
    beforeTargetId,
    afterTargetId,
    pairCount: pairs.length,
    verdict,
    metrics,
    warnings,
    errors: [],
  };
}

/** Convenience wrapper for callers that retain the configured target objects. */
export function compareTargetRuns(
  beforeTarget: BenchmarkTarget,
  afterTarget: BenchmarkTarget,
  beforeRuns: readonly RunResult[],
  afterRuns: readonly RunResult[],
  options: CompareOptions = {},
): ComparisonResult {
  if (beforeRuns.some((run) => run.targetId !== beforeTarget.id)
    || afterRuns.some((run) => run.targetId !== afterTarget.id)) {
    throw new Error("Run target ids do not match the supplied targets.");
  }
  return compareRuns(beforeRuns, afterRuns, options);
}

export const compare = compareRuns;

function unavailableMetric(
  input: Pick<CompareMetricValuesInput, "metric" | "unit" | "direction" | "gate">,
  reason: string,
): MetricComparison {
  return {
    metric: input.metric,
    unit: input.unit,
    direction: input.direction ?? metricDirection(input.metric),
    verdict: "unavailable",
    gate: input.gate === undefined
      ? { configured: false, reason }
      : input.gate.required === false
        ? { configured: true, passed: true, reason: `Optional metric unavailable: ${reason}` }
        : { configured: true, reason },
  };
}

function qualityGate(gate: MetricGate | undefined, reason: string): GateEvaluation {
  if (gate === undefined) return { configured: false, reason };
  if (gate.required === false) {
    return { configured: true, passed: true, reason: `Optional metric skipped: ${reason}` };
  }
  return { configured: true, reason };
}

function targetSummary(values: readonly number[], unit: string, source: string): TargetMetricSummary {
  return { ...summarize(values), unit, source };
}

function descriptiveVerdict(
  direction: MetricDirection,
  confidence: { low: number; high: number },
  pairCount: number,
  minimumPairs: number,
): MetricVerdict {
  if (pairCount < minimumPairs || direction === "informational") return "inconclusive";
  if (direction === "zero") {
    if (confidence.low === 0 && confidence.high === 0) return "neutral";
    return confidence.low > 0 ? "regressed" : "inconclusive";
  }
  if (confidence.low > 0) return "improved";
  if (confidence.high < 0) return "regressed";
  return "neutral";
}

function gateVerdict(
  gate: GateDecision["verdict"],
  direction: MetricDirection,
  confidence: { low: number; high: number },
  pairCount: number,
  minimumPairs: number,
): MetricVerdict {
  if (gate === "regression") return "regressed";
  if (gate === "inconclusive") return "inconclusive";
  const descriptive = descriptiveVerdict(direction, confidence, pairCount, minimumPairs);
  return descriptive === "regressed" ? "neutral" : descriptive;
}

function evaluateGate(
  metricId: string,
  direction: MetricDirection,
  after: readonly number[],
  improvementValues: readonly number[] | undefined,
  confidence: { low: number; high: number },
  gate: MetricGate | undefined,
  pairCount: number,
  minimumPairs: number,
  options: BootstrapOptions,
): GateDecision {
  if (gate === undefined) {
    return { evaluation: { configured: false, reason: "No gate configured." }, verdict: "pass" };
  }

  const hardInvariant = direction === "zero" || metricId.startsWith("stability.");
  if (gate.maxAbsolute !== undefined && hardInvariant) {
    if (after.some((value) => value > (gate.maxAbsolute as number))) {
      return {
        evaluation: { configured: true, passed: false, reason: `At least one run exceeded maxAbsolute ${gate.maxAbsolute}.` },
        verdict: "regression",
      };
    }
  }
  if (gate.minAbsolute !== undefined && hardInvariant) {
    if (after.some((value) => value < (gate.minAbsolute as number))) {
      return {
        evaluation: { configured: true, passed: false, reason: `At least one run was below minAbsolute ${gate.minAbsolute}.` },
        verdict: "regression",
      };
    }
  }

  if (pairCount < minimumPairs && !hardInvariant) {
    return {
      evaluation: { configured: true, reason: `At least ${minimumPairs} pairs are required for an inferential gate.` },
      verdict: "inconclusive",
    };
  }

  const decisions: Array<"pass" | "regression" | "inconclusive"> = [];
  const reasons: string[] = [];
  if (gate.maxRegressionPercent !== undefined || gate.minImprovementPercent !== undefined) {
    if (improvementValues === undefined) {
      return {
        evaluation: { configured: true, reason: "Percent gates are unavailable when a before value is zero or the metric has no improvement direction." },
        verdict: "inconclusive",
      };
    }
    const thresholds = [
      ...(gate.maxRegressionPercent === undefined ? [] : [-gate.maxRegressionPercent]),
      ...(gate.minImprovementPercent === undefined ? [] : [gate.minImprovementPercent]),
    ];
    for (const threshold of thresholds) {
      const decision = thresholdDecision(confidence, threshold);
      decisions.push(decision);
      reasons.push(`Improvement CI [${confidence.low}, ${confidence.high}] versus minimum ${threshold}%.`);
    }
  }

  if (!hardInvariant && (gate.maxAbsolute !== undefined || gate.minAbsolute !== undefined)) {
    const absoluteConfidence = bootstrapMedianConfidenceInterval(after, options);
    if (gate.maxAbsolute !== undefined) {
      const decision = maximumDecision(absoluteConfidence, gate.maxAbsolute);
      decisions.push(decision);
      reasons.push(`After median CI [${absoluteConfidence.low}, ${absoluteConfidence.high}] versus maximum ${gate.maxAbsolute}.`);
    }
    if (gate.minAbsolute !== undefined) {
      const decision = minimumDecision(absoluteConfidence, gate.minAbsolute);
      decisions.push(decision);
      reasons.push(`After median CI [${absoluteConfidence.low}, ${absoluteConfidence.high}] versus minimum ${gate.minAbsolute}.`);
    }
  }

  if (decisions.length === 0) {
    return {
      evaluation: { configured: true, passed: true, reason: "Required metric was available." },
      verdict: "pass",
    };
  }
  if (decisions.includes("regression")) {
    return {
      evaluation: { configured: true, passed: false, reason: reasons.join(" ") },
      verdict: "regression",
    };
  }
  if (decisions.includes("inconclusive")) {
    return {
      evaluation: { configured: true, reason: reasons.join(" ") },
      verdict: "inconclusive",
    };
  }
  return {
    evaluation: { configured: true, passed: true, reason: reasons.join(" ") },
    verdict: "pass",
  };
}

function thresholdDecision(
  confidence: { low: number; high: number },
  minimum: number,
): "pass" | "regression" | "inconclusive" {
  if (confidence.low >= minimum) return "pass";
  if (confidence.high < minimum) return "regression";
  return "inconclusive";
}

function maximumDecision(
  confidence: { low: number; high: number },
  maximum: number,
): "pass" | "regression" | "inconclusive" {
  if (confidence.high <= maximum) return "pass";
  if (confidence.low > maximum) return "regression";
  return "inconclusive";
}

function minimumDecision(
  confidence: { low: number; high: number },
  minimum: number,
): "pass" | "regression" | "inconclusive" {
  if (confidence.low >= minimum) return "pass";
  if (confidence.high < minimum) return "regression";
  return "inconclusive";
}

function qualityProblem(input: CompareMetricValuesInput, expectedPairCount: number): string | undefined {
  if (input.before.length !== expectedPairCount) {
    return `Only ${input.before.length} of ${expectedPairCount} run pairs contained comparable measurements.`;
  }
  if (input.gate?.minSampleCount !== undefined) {
    if (input.sampleCounts === undefined || input.sampleCounts.length !== input.before.length) {
      return "Sample counts required by the metric gate were unavailable.";
    }
    if (input.sampleCounts.some((count) => count < (input.gate?.minSampleCount as number))) {
      return `At least one run was below minSampleCount ${input.gate.minSampleCount}.`;
    }
  }
  if (input.gate?.minCoverageRatio !== undefined) {
    if (input.coverageRatios === undefined
      || input.coverageRatios.length !== input.before.length
      || input.coverageRatios.some((ratio) => ratio === undefined)) {
      return "Coverage ratios required by the metric gate were unavailable.";
    }
    if (input.coverageRatios.some((ratio) => (ratio as number) < (input.gate?.minCoverageRatio as number))) {
      return `At least one run was below minCoverageRatio ${input.gate.minCoverageRatio}.`;
    }
  }
  return undefined;
}

function oneTargetId(runs: readonly RunResult[], label: string): string {
  const ids = new Set(runs.map((run) => run.targetId));
  if (ids.size !== 1) throw new Error(`${label} runs must all belong to one target.`);
  return runs[0]?.targetId as string;
}

function pairCompletedRuns(
  beforeRuns: readonly RunResult[],
  afterRuns: readonly RunResult[],
): Array<{ before: RunResult; after: RunResult }> {
  const beforeByIndex = indexRuns(beforeRuns, "before");
  const afterByIndex = indexRuns(afterRuns, "after");
  return [...beforeByIndex.keys()]
    .filter((index) => afterByIndex.has(index))
    .sort((left, right) => left - right)
    .map((index) => ({
      before: beforeByIndex.get(index) as RunResult,
      after: afterByIndex.get(index) as RunResult,
    }));
}

function indexRuns(runs: readonly RunResult[], label: string): Map<number, RunResult> {
  const indexed = new Map<number, RunResult>();
  for (const run of runs) {
    if (run.status !== "completed") continue;
    if (indexed.has(run.index)) throw new Error(`${label} runs contain duplicate index ${run.index}.`);
    indexed.set(run.index, run);
  }
  return indexed;
}

function makeGateMap(gates: readonly MetricGate[]): Map<string, MetricGate> {
  const map = new Map<string, MetricGate>();
  for (const gate of gates) {
    if (map.has(gate.metric)) throw new Error(`Duplicate metric gate '${gate.metric}'.`);
    map.set(gate.metric, gate);
  }
  return map;
}

function collectMetricPairs(
  pairs: readonly { before: RunResult; after: RunResult }[],
  metricId: string,
): MetricPairs {
  const result: MetricPairs = { before: [], after: [], sampleCounts: [], coverageRatios: [] };
  for (const pair of pairs) {
    const before = pair.before.metrics[metricId];
    const after = pair.after.metrics[metricId];
    if (!isComparableMeasurement(before) || !isComparableMeasurement(after)) continue;
    if (before.unit !== after.unit) {
      result.incompatibleReason = `Metric units differ: '${before.unit}' versus '${after.unit}'.`;
      return result;
    }
    if ((result.unit !== undefined && result.unit !== before.unit)
      || (result.beforeSource !== undefined && result.beforeSource !== before.source)
      || (result.afterSource !== undefined && result.afterSource !== after.source)) {
      result.incompatibleReason = "Metric unit or a target's source changed between run pairs.";
      return result;
    }
    result.unit = before.unit;
    result.beforeSource = before.source;
    result.afterSource = after.source;
    result.before.push(before.value as number);
    result.after.push(after.value as number);
    result.sampleCounts.push(Math.min(before.sampleCount, after.sampleCount));
    result.coverageRatios.push(minimumDefined(before.coverageRatio, after.coverageRatio));
  }
  return result;
}

function isComparableMeasurement(value: MetricMeasurement | undefined): value is MetricMeasurement & { value: number } {
  return value !== undefined
    && value.status === "measured"
    && value.comparable
    && typeof value.value === "number"
    && Number.isFinite(value.value);
}

function minimumDefined(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined || right === undefined ? undefined : Math.min(left, right);
}
