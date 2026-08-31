import { arithmeticMean, quantile, slowestPercentLowFps } from "../analytics/statistics.js";
import type { CollectorResult, MetricMeasurement, MetricSample } from "../types.js";
import type { PresentMonFrameSample } from "./presentmon.js";

export function presentMonFramesToCollector(
  frames: readonly PresentMonFrameSample[],
  measuredDurationMs: number,
  frameBudgetMs: number,
): CollectorResult {
  const selected = selectPrimarySwapChain(frames);
  const intervals = selected.filter((frame) => frame.frameTimeMs !== undefined && frame.frameTimeMs > 0);
  if (intervals.length === 0) {
    return {
      collector: "presentmon",
      status: "partial",
      samples: [],
      metrics: {
        "frame.cadence.interval_ms.p95": unavailable("ms", "PresentMon reported no positive FrameTime or MsBetweenPresents samples"),
      },
      artifacts: [],
      warnings: [{ code: "PRESENTMON_NO_FRAMES", message: "PresentMon reported no positive frame interval samples for the primary swap chain" }],
      errors: [],
    };
  }

  const values = intervals.map((frame) => frame.frameTimeMs!);
  const metrics: Record<string, MetricMeasurement> = {};
  const samples: MetricSample[] = [];
  const coverageRatio = Math.min(1, values.reduce((sum, value) => sum + value, 0) / measuredDurationMs);
  addCadenceMetrics(metrics, "frame.cadence", values, frameBudgetMs, coverageRatio);
  addCadenceMetrics(metrics, "frame.present", values, frameBudgetMs, coverageRatio);

  addSeries(metrics, "gpu.frame_time_ms", intervals.flatMap((frame) => frame.gpuTimeMs === undefined ? [] : [frame.gpuTimeMs]), "ms", coverageRatio);
  addSeries(metrics, "frame.present.cpu_busy_ms", intervals.flatMap((frame) => frame.cpuBusyMs === undefined ? [] : [frame.cpuBusyMs]), "ms", coverageRatio);
  addSeries(metrics, "frame.present.cpu_wait_ms", intervals.flatMap((frame) => frame.cpuWaitMs === undefined ? [] : [frame.cpuWaitMs]), "ms", coverageRatio);
  addSeries(metrics, "frame.present.display_latency_ms", intervals.flatMap((frame) => frame.displayLatencyMs === undefined ? [] : [frame.displayLatencyMs]), "ms", coverageRatio);
  const dropped = selected.filter((frame) => frame.dropped === true).length;
  measured(metrics, "frame.present.dropped_count", dropped, "count", selected.length, coverageRatio);
  measured(metrics, "frame.present.dropped_ratio", selected.length === 0 ? 0 : dropped / selected.length, "ratio", selected.length, coverageRatio);

  let elapsed = 0;
  for (const frame of intervals) {
    elapsed += frame.frameTimeMs!;
    const tMs = frame.timestampSeconds === undefined ? elapsed : (frame.timestampSeconds - (intervals[0]!.timestampSeconds ?? frame.timestampSeconds)) * 1000;
    samples.push({
      tMs,
      metric: "frame.cadence.interval_ms",
      value: frame.frameTimeMs!,
      unit: "ms",
      source: "presentmon",
      ...(frame.processId === undefined ? {} : { pid: frame.processId }),
      tags: {
        ...(frame.swapChainAddress === undefined ? {} : { swapChain: frame.swapChainAddress }),
        ...(frame.presentMode === undefined ? {} : { presentMode: frame.presentMode }),
        ...(frame.dropped === undefined ? {} : { dropped: frame.dropped }),
      },
    });
    if (frame.gpuTimeMs !== undefined) samples.push({ tMs, metric: "gpu.frame_time_ms", value: frame.gpuTimeMs, unit: "ms", source: "presentmon", ...(frame.processId === undefined ? {} : { pid: frame.processId }) });
  }

  return {
    collector: "presentmon",
    status: coverageRatio >= 0.8 ? "completed" : "partial",
    samples,
    metrics,
    artifacts: [],
    warnings: coverageRatio >= 0.8
      ? []
      : [{ code: "PRESENTMON_LOW_COVERAGE", message: `Primary swap-chain coverage was ${(coverageRatio * 100).toFixed(1)}%` }],
    errors: [],
  };
}

function selectPrimarySwapChain(frames: readonly PresentMonFrameSample[]): PresentMonFrameSample[] {
  const groups = new Map<string, PresentMonFrameSample[]>();
  for (const frame of frames) {
    const key = `${frame.processId ?? "unknown"}:${frame.swapChainAddress ?? "default"}`;
    const group = groups.get(key) ?? [];
    group.push(frame);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => {
    const usable = (group: PresentMonFrameSample[]) => group.filter((frame) => frame.frameTimeMs !== undefined && frame.frameTimeMs > 0).length;
    return usable(right) - usable(left);
  })[0] ?? [];
}

function addCadenceMetrics(metrics: Record<string, MetricMeasurement>, prefix: string, values: readonly number[], frameBudgetMs: number, coverageRatio: number): void {
  measured(metrics, `${prefix}.fps_mean`, 1000 / arithmeticMean(values), "fps", values.length, coverageRatio);
  for (const [suffix, probability] of [["p50", 0.5], ["p90", 0.9], ["p95", 0.95], ["p99", 0.99]] as const) {
    measured(metrics, `${prefix}.interval_ms.${suffix}`, quantile(values, probability), "ms", values.length, coverageRatio);
  }
  measured(metrics, `${prefix}.interval_ms.max`, Math.max(...values), "ms", values.length, coverageRatio);
  measured(metrics, `${prefix}.fps_1pct_low`, slowestPercentLowFps(values, 0.01), "fps", values.length, coverageRatio);
  measured(metrics, `${prefix}.fps_0_1pct_low`, slowestPercentLowFps(values, 0.001), "fps", values.length, coverageRatio);
  measured(metrics, `${prefix}.deadline_miss_ratio`, values.filter((value) => value > frameBudgetMs).length / values.length, "ratio", values.length, coverageRatio);
  measured(metrics, `${prefix}.long_frame_50ms_count`, values.filter((value) => value > 50).length, "count", values.length, coverageRatio);
  measured(metrics, `${prefix}.long_frame_100ms_count`, values.filter((value) => value > 100).length, "count", values.length, coverageRatio);
  measured(metrics, `${prefix}.stutter_episode_count`, stutterEpisodes(values, Math.max(frameBudgetMs * 2, 50)), "count", values.length, coverageRatio);
  measured(metrics, `${prefix}.sample_count`, values.length, "count", values.length, coverageRatio);
  measured(metrics, `${prefix}.coverage_ratio`, coverageRatio, "ratio", values.length, coverageRatio);
}

function addSeries(metrics: Record<string, MetricMeasurement>, prefix: string, values: readonly number[], unit: string, coverageRatio: number): void {
  if (values.length === 0) {
    metrics[`${prefix}.p95`] = unavailable(unit, `${prefix} was not present in the selected PresentMon CSV columns`);
    return;
  }
  measured(metrics, `${prefix}.mean`, arithmeticMean(values), unit, values.length, coverageRatio);
  measured(metrics, `${prefix}.p50`, quantile(values, 0.5), unit, values.length, coverageRatio);
  measured(metrics, `${prefix}.p95`, quantile(values, 0.95), unit, values.length, coverageRatio);
  measured(metrics, `${prefix}.p99`, quantile(values, 0.99), unit, values.length, coverageRatio);
  measured(metrics, `${prefix}.max`, Math.max(...values), unit, values.length, coverageRatio);
}

function measured(metrics: Record<string, MetricMeasurement>, id: string, value: number, unit: string, sampleCount: number, coverageRatio: number): void {
  metrics[id] = { status: "measured", value, unit, sampleCount, source: "presentmon", comparable: true, coverageRatio };
}

function unavailable(unit: string, reason: string): MetricMeasurement {
  return { status: "unavailable", unit, sampleCount: 0, source: "presentmon", comparable: false, reason };
}

function stutterEpisodes(values: readonly number[], threshold: number): number {
  let episodes = 0;
  let inside = false;
  for (const value of values) {
    if (value > threshold && !inside) episodes += 1;
    inside = value > threshold;
  }
  return episodes;
}
