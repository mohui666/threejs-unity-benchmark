import type { AggregateStatistics, ConfidenceInterval } from "../types.js";

export interface BootstrapOptions {
  iterations?: number;
  confidenceLevel?: number;
  seed?: number;
}

const DEFAULT_BOOTSTRAP_ITERATIONS = 10_000;
const DEFAULT_CONFIDENCE_LEVEL = 0.95;
const DEFAULT_BOOTSTRAP_SEED = 42;

function requireFiniteValues(values: readonly number[], name: string): void {
  if (values.length === 0) throw new Error(`${name} requires at least one value.`);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${name} accepts finite numbers only.`);
  }
}

export function arithmeticMean(values: readonly number[]): number {
  requireFiniteValues(values, "arithmeticMean");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** R-7 linear interpolation, the default used by many statistical tools. */
export function quantile(values: readonly number[], probability: number): number {
  requireFiniteValues(values, "quantile");
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("quantile probability must be between 0 and 1.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0] as number;
  const position = probability * (sorted.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex] as number;
  const upper = sorted[upperIndex] as number;
  return lower + (upper - lower) * (position - lowerIndex);
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

/** Raw median absolute deviation. It is intentionally not normal-distribution scaled. */
export function medianAbsoluteDeviation(values: readonly number[], center = median(values)): number {
  requireFiniteValues(values, "medianAbsoluteDeviation");
  if (!Number.isFinite(center)) throw new Error("medianAbsoluteDeviation center must be finite.");
  return median(values.map((value) => Math.abs(value - center)));
}

export const mad = medianAbsoluteDeviation;

export function summarize(values: readonly number[]): AggregateStatistics {
  requireFiniteValues(values, "summarize");
  const center = median(values);
  return {
    count: values.length,
    median: center,
    mad: medianAbsoluteDeviation(values, center),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/** Deterministic Mulberry32 PRNG used only for repeatable bootstrap resampling. */
export function createSeededRandom(seed = DEFAULT_BOOTSTRAP_SEED): () => number {
  if (!Number.isFinite(seed)) throw new Error("bootstrap seed must be finite.");
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function resolveBootstrapOptions(options: BootstrapOptions): Required<BootstrapOptions> {
  const iterations = options.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
  const confidenceLevel = options.confidenceLevel ?? DEFAULT_CONFIDENCE_LEVEL;
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("bootstrap iterations must be a positive integer.");
  }
  if (!Number.isFinite(confidenceLevel) || confidenceLevel <= 0 || confidenceLevel >= 1) {
    throw new Error("bootstrap confidenceLevel must be between 0 and 1.");
  }
  if (!Number.isFinite(seed)) throw new Error("bootstrap seed must be finite.");
  return { iterations, confidenceLevel, seed };
}

export function bootstrapMedianConfidenceInterval(
  values: readonly number[],
  options: BootstrapOptions = {},
): ConfidenceInterval {
  requireFiniteValues(values, "bootstrapMedianConfidenceInterval");
  const resolved = resolveBootstrapOptions(options);
  const random = createSeededRandom(resolved.seed);
  const estimates = new Array<number>(resolved.iterations);
  const sample = new Array<number>(values.length);
  for (let iteration = 0; iteration < resolved.iterations; iteration += 1) {
    for (let index = 0; index < values.length; index += 1) {
      sample[index] = values[Math.floor(random() * values.length)] as number;
    }
    estimates[iteration] = median(sample);
  }
  const tail = (1 - resolved.confidenceLevel) / 2;
  return {
    low: quantile(estimates, tail),
    high: quantile(estimates, 1 - tail),
    level: resolved.confidenceLevel,
  };
}

export function pairedDifferences(before: readonly number[], after: readonly number[]): number[] {
  requirePairedValues(before, after, "pairedDifferences");
  return before.map((value, index) => (after[index] as number) - value);
}

export function pairedRatios(before: readonly number[], after: readonly number[]): number[] | undefined {
  requirePairedValues(before, after, "pairedRatios");
  if (before.some((value) => value === 0)) return undefined;
  return before.map((value, index) => (after[index] as number) / value);
}

export function pairedPercentChanges(before: readonly number[], after: readonly number[]): number[] | undefined {
  const ratios = pairedRatios(before, after);
  return ratios?.map((ratio) => (ratio - 1) * 100);
}

export function requirePairedValues(
  before: readonly number[],
  after: readonly number[],
  name = "paired statistic",
): void {
  requireFiniteValues(before, name);
  requireFiniteValues(after, name);
  if (before.length !== after.length) {
    throw new Error(`${name} requires before and after arrays of equal length.`);
  }
}

export function pairedBootstrapMedianDifference(
  before: readonly number[],
  after: readonly number[],
  options: BootstrapOptions = {},
): ConfidenceInterval {
  return bootstrapMedianConfidenceInterval(pairedDifferences(before, after), options);
}

export function slowestPercentLowFps(frameIntervalsMs: readonly number[], slowestFraction: number): number {
  requireFiniteValues(frameIntervalsMs, "slowestPercentLowFps");
  if (!Number.isFinite(slowestFraction) || slowestFraction <= 0 || slowestFraction > 1) {
    throw new Error("slowestFraction must be greater than 0 and at most 1.");
  }
  const count = Math.max(1, Math.ceil(frameIntervalsMs.length * slowestFraction));
  const slowest = [...frameIntervalsMs].sort((left, right) => right - left).slice(0, count);
  return 1000 / arithmeticMean(slowest);
}
