import {
  arithmeticMean,
  quantile,
  slowestPercentLowFps,
} from "../analytics/statistics.js";
import type {
  CollectorResult,
  MetricMeasurement,
  MetricSample,
  StructuredIssue,
} from "../types.js";
import type { WebCollectionResult } from "./web.js";

export function webResultToCollector(
  result: WebCollectionResult,
  frameBudgetMs: number,
  scenarioRequired: boolean,
): CollectorResult {
  const metrics: Record<string, MetricMeasurement> = {};
  const samples: MetricSample[] = [];
  const intervals = result.probe.frameIntervalsMs.filter((value) => Number.isFinite(value) && value > 0);
  const coverage = Math.min(1, intervals.reduce((sum, value) => sum + value, 0) / result.durationMs);

  if (intervals.length > 0) {
    add(metrics, "web.raf.fps_mean", 1000 / arithmeticMean(intervals), "fps", intervals.length, "web-probe", true, coverage);
    for (const [suffix, probability] of [["p50", 0.5], ["p90", 0.9], ["p95", 0.95], ["p99", 0.99]] as const) {
      add(metrics, `web.raf.interval_ms.${suffix}`, quantile(intervals, probability), "ms", intervals.length, "web-probe", true, coverage);
    }
    add(metrics, "web.raf.interval_ms.max", Math.max(...intervals), "ms", intervals.length, "web-probe", true, coverage);
    add(metrics, "web.raf.fps_1pct_low", slowestPercentLowFps(intervals, 0.01), "fps", intervals.length, "web-probe", true, coverage);
    add(metrics, "web.raf.fps_0_1pct_low", slowestPercentLowFps(intervals, 0.001), "fps", intervals.length, "web-probe", true, coverage);
    add(metrics, "web.raf.deadline_miss_ratio", intervals.filter((value) => value > frameBudgetMs).length / intervals.length, "ratio", intervals.length, "web-probe", true, coverage);
    add(metrics, "web.raf.long_frame_50ms_count", intervals.filter((value) => value > 50).length, "count", intervals.length, "web-probe", true, coverage);
    add(metrics, "web.raf.long_frame_100ms_count", intervals.filter((value) => value > 100).length, "count", intervals.length, "web-probe", true, coverage);
    add(metrics, "web.raf.stutter_episode_count", stutterEpisodes(intervals, Math.max(frameBudgetMs * 2, 50)), "count", intervals.length, "web-probe", true, coverage);
    add(metrics, "web.raf.sample_count", intervals.length, "count", intervals.length, "web-probe", true, coverage);
    add(metrics, "web.raf.coverage_ratio", coverage, "ratio", intervals.length, "web-probe", true, coverage);

    let elapsed = 0;
    for (const value of intervals) {
      elapsed += value;
      samples.push({ tMs: elapsed, metric: "web.raf.interval_ms", value, unit: "ms", source: "web-probe" });
    }
  } else {
    metrics["web.raf.interval_ms.p95"] = unavailable("ms", "web-probe", "No requestAnimationFrame samples were captured");
  }

  const longTaskDuration = result.probe.longTasks.reduce((sum, task) => sum + task.duration, 0);
  add(metrics, "web.long_task.count", result.probe.longTasks.length, "count", result.probe.longTasks.length, "web-probe", true);
  add(metrics, "web.long_task.duration_ms", longTaskDuration, "ms", result.probe.longTasks.length, "web-probe", true);
  add(metrics, "web.long_task.max_ms", result.probe.longTasks.length > 0 ? Math.max(...result.probe.longTasks.map((task) => task.duration)) : 0, "ms", result.probe.longTasks.length, "web-probe", true);
  for (const task of result.probe.longTasks) samples.push({ tMs: task.startTime, metric: "web.long_task.duration_ms", value: task.duration, unit: "ms", source: "web-probe" });

  add(metrics, "web.resource.request_count", result.network.requestCount, "count", result.network.requestCount, "playwright-network", true);
  add(metrics, "web.resource.transfer_bytes", result.network.responseBodyBytes + result.network.responseHeadersBytes, "byte", result.network.requestCount, "playwright-network", true);
  add(metrics, "web.resource.decoded_body_bytes", sumResourceField(result.probe.resources, "decodedBodySize"), "byte", result.probe.resources.length, "web-performance", true);

  const navigation = result.probe.navigation;
  navigationMetric(metrics, navigation, "domContentLoadedEventEnd", "web.navigation.dom_content_loaded_ms");
  navigationMetric(metrics, navigation, "loadEventEnd", "web.navigation.load_ms");
  const fcp = result.probe.paints["first-contentful-paint"];
  if (fcp !== undefined) add(metrics, "web.navigation.fcp_ms", fcp, "ms", 1, "web-performance", true);
  else metrics["web.navigation.fcp_ms"] = unavailable("ms", "web-performance", "First Contentful Paint was not reported");
  if (result.probe.largestContentfulPaintMs !== null) add(metrics, "web.navigation.lcp_ms", result.probe.largestContentfulPaintMs, "ms", 1, "web-performance", true);
  else metrics["web.navigation.lcp_ms"] = unavailable("ms", "web-performance", "Largest Contentful Paint was not reported");
  add(metrics, "web.layout_shift.cumulative", result.probe.cumulativeLayoutShift, "score", 1, "web-performance", true);

  if (result.probe.memory.status === "measured") {
    add(metrics, "web.memory.user_agent_bytes", result.probe.memory.bytes, "byte", 1, "measureUserAgentSpecificMemory", true);
  } else {
    metrics["web.memory.user_agent_bytes"] = unavailable("byte", "measureUserAgentSpecificMemory", result.probe.memory.reason);
  }

  addCdpMetrics(metrics, result);
  addCustomMetrics(metrics, samples, result);

  const scenarioCompleted = scenarioRequired
    ? result.scenario.completed === true || result.probe.checkpoints.some((checkpoint) => checkpoint.name === "scenario-complete" && checkpoint.value !== false)
    : true;
  add(metrics, "stability.scenario_completed", scenarioCompleted ? 1 : 0, "boolean", 1, "scenario", true);
  add(metrics, "stability.browser_console_error_count", result.consoleErrors.length, "count", result.consoleErrors.length, "playwright", true);
  add(metrics, "stability.browser_page_error_count", result.pageErrors.length, "count", result.pageErrors.length, "playwright", true);

  const warnings: StructuredIssue[] = result.warnings.map((message) => ({ code: "WEB_COLLECTOR_WARNING", message }));
  return {
    collector: result.collector,
    status: "completed",
    samples,
    metrics,
    artifacts: [],
    warnings,
    errors: [],
  };
}

function addCdpMetrics(metrics: Record<string, MetricMeasurement>, result: WebCollectionResult): void {
  const deltaNames: Record<string, string> = {
    TaskDuration: "web.cdp.task_duration_ms",
    ScriptDuration: "web.cdp.script_duration_ms",
    LayoutDuration: "web.cdp.layout_duration_ms",
    RecalcStyleDuration: "web.cdp.recalc_style_duration_ms",
    V8CompileDuration: "web.cdp.v8_compile_duration_ms",
    LayoutCount: "web.cdp.layout_count",
    RecalcStyleCount: "web.cdp.recalc_style_count",
  };
  for (const [sourceName, metricName] of Object.entries(deltaNames)) {
    const value = result.cdp.delta[sourceName];
    if (value === undefined) {
      metrics[metricName] = unavailable(sourceName.endsWith("Duration") ? "ms" : "count", "cdp-performance", `${sourceName} was not reported by Chromium`);
    } else {
      add(metrics, metricName, sourceName.endsWith("Duration") ? value * 1000 : value, sourceName.endsWith("Duration") ? "ms" : "count", 1, "cdp-performance", true);
    }
  }
  const pointNames: Record<string, { id: string; unit: string }> = {
    JSHeapUsedSize: { id: "web.js_heap.used_bytes.end", unit: "byte" },
    JSHeapTotalSize: { id: "web.js_heap.total_bytes.end", unit: "byte" },
    Nodes: { id: "web.dom.node_count.end", unit: "count" },
    Documents: { id: "web.dom.document_count.end", unit: "count" },
    JSEventListeners: { id: "web.dom.event_listener_count.end", unit: "count" },
  };
  for (const [sourceName, definition] of Object.entries(pointNames)) {
    const value = result.cdp.end[sourceName];
    if (value !== undefined) add(metrics, definition.id, value, definition.unit, 1, "cdp-performance", true);
    else metrics[definition.id] = unavailable(definition.unit, "cdp-performance", `${sourceName} was not reported by Chromium`);
  }
}

function addCustomMetrics(metrics: Record<string, MetricMeasurement>, samples: MetricSample[], result: WebCollectionResult): void {
  for (const [name, points] of Object.entries(result.probe.customMetrics)) {
    if (points.length === 0) continue;
    const values = points.map((point) => point.value);
    const first = points[0]!;
    add(metrics, name, arithmeticMean(values), first.unit, values.length, "web-custom", true);
    add(metrics, `${name}.p95`, quantile(values, 0.95), first.unit, values.length, "web-custom", true);
    add(metrics, `${name}.peak`, Math.max(...values), first.unit, values.length, "web-custom", true);
    for (const point of points) samples.push({ tMs: point.atMs, metric: name, value: point.value, unit: point.unit, source: "web-custom" });
  }
}

function navigationMetric(metrics: Record<string, MetricMeasurement>, navigation: Record<string, number | string> | null, sourceName: string, metricName: string): void {
  const value = navigation?.[sourceName];
  if (typeof value === "number" && value > 0) add(metrics, metricName, value, "ms", 1, "web-performance", true);
  else metrics[metricName] = unavailable("ms", "web-performance", `${sourceName} was not reported`);
}

function sumResourceField(resources: Array<Record<string, number | string>>, field: string): number {
  return resources.reduce((sum, resource) => sum + (typeof resource[field] === "number" ? resource[field] : 0), 0);
}

function stutterEpisodes(intervals: readonly number[], threshold: number): number {
  let count = 0;
  let inside = false;
  for (const interval of intervals) {
    if (interval > threshold && !inside) count += 1;
    inside = interval > threshold;
  }
  return count;
}

function add(
  metrics: Record<string, MetricMeasurement>,
  id: string,
  value: number,
  unit: string,
  sampleCount: number,
  source: string,
  comparable: boolean,
  coverageRatio?: number,
): void {
  metrics[id] = {
    status: "measured",
    value,
    unit,
    sampleCount,
    source,
    comparable,
    ...(coverageRatio === undefined ? {} : { coverageRatio }),
  };
}

function unavailable(unit: string, source: string, reason: string): MetricMeasurement {
  return { status: "unavailable", unit, sampleCount: 0, source, comparable: false, reason };
}
