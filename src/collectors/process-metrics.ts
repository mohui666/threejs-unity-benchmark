import { performance } from "node:perf_hooks";
import { arithmeticMean, quantile } from "../analytics/statistics.js";
import type { CollectorResult, MetricMeasurement, MetricSample } from "../types.js";
import { ProcessTreeCollector, type ProcessTreeSample } from "./process-tree.js";

export class ProcessMonitorSession {
  private readonly collector: ProcessTreeCollector;
  private readonly intervalMs: number;
  private running = false;
  private origin = 0;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private readonly retained: ProcessTreeSample[] = [];

  constructor(rootPid: number, intervalMs: number) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("Process sample interval must be positive");
    this.collector = new ProcessTreeCollector({ rootPid });
    this.intervalMs = intervalMs;
  }

  get startedAtMonotonicMs(): number | undefined {
    return this.origin === 0 ? undefined : this.origin;
  }

  async start(): Promise<void> {
    if (this.running) throw new Error("Process monitor is already running");
    await this.collector.prime();
    this.running = true;
    this.origin = performance.now();
    this.schedule();
  }

  async stop(): Promise<ProcessTreeSample[]> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
    return this.retained.slice();
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.inFlight = this.capture().finally(() => {
        if (this.running) this.schedule();
      });
    }, this.intervalMs);
  }

  private async capture(): Promise<void> {
    const sample = await this.collector.sample();
    this.retained.push({ ...sample, sampledAtMs: performance.now() - this.origin });
  }
}

export function processSamplesToCollector(samples: readonly ProcessTreeSample[], measuredDurationMs: number): CollectorResult {
  const metrics: Record<string, MetricMeasurement> = {};
  const raw: MetricSample[] = [];
  if (samples.length === 0) {
    return {
      collector: "process-tree",
      status: "partial",
      samples: [],
      metrics: {
        "cpu.process_tree.core_percent.mean": unavailable("percent", "No retained process samples were captured"),
        "memory.process_tree.working_set_bytes.peak": unavailable("byte", "No retained process samples were captured"),
      },
      artifacts: [],
      warnings: [{ code: "PROCESS_SAMPLES_EMPTY", message: "No retained process samples were captured" }],
      errors: [],
    };
  }

  const cpu = samples.map((sample) => sample.totalCpuPercent);
  const rss = samples.map((sample) => sample.totalResidentMemoryBytes);
  const virtual = samples.map((sample) => sample.totalVirtualMemoryBytes);
  const processCounts = samples.map((sample) => sample.processCount);
  const logicalProcessors = samples[0]!.logicalProcessorCount;
  const coverageRatio = Math.min(1, ((samples.at(-1)!.sampledAtMs - samples[0]!.sampledAtMs) + estimateInterval(samples)) / measuredDurationMs);

  summary(metrics, "cpu.process_tree.core_percent", cpu, "percent", coverageRatio);
  summary(metrics, "cpu.process_tree.machine_percent", cpu.map((value) => value / logicalProcessors), "percent", coverageRatio);
  summary(metrics, "memory.process_tree.working_set_bytes", rss, "byte", coverageRatio);
  summary(metrics, "memory.process_tree.virtual_bytes", virtual, "byte", coverageRatio);
  summary(metrics, "process.process_count", processCounts, "count", coverageRatio);
  measured(metrics, "memory.process_tree.working_set_bytes.start", rss[0]!, "byte", samples.length, coverageRatio);
  measured(metrics, "memory.process_tree.working_set_bytes.end", rss.at(-1)!, "byte", samples.length, coverageRatio);
  measured(metrics, "cpu.process_tree.time_seconds", integrateCpuSeconds(samples), "s", samples.length, coverageRatio);
  measured(metrics, "stability.sample_gap_count", samples.filter((sample) => !sample.rootFound).length, "count", samples.length, coverageRatio);
  if (measuredDurationMs >= 60_000) {
    measured(metrics, "memory.process_tree.growth_bytes_per_minute", linearSlope(samples.map((sample) => [sample.sampledAtMs, sample.totalResidentMemoryBytes] as const)) * 60_000, "byte/min", samples.length, coverageRatio);
  } else {
    metrics["memory.process_tree.growth_bytes_per_minute"] = unavailable("byte/min", "Measurement duration is shorter than 60 seconds");
  }
  metrics["memory.process_tree.private_bytes.mean"] = unavailable("byte", "systeminformation does not expose portable process private bytes");
  metrics["memory.process_tree.private_bytes.peak"] = unavailable("byte", "systeminformation does not expose portable process private bytes");

  for (const sample of samples) {
    raw.push({ tMs: sample.sampledAtMs, metric: "cpu.process_tree.core_percent", value: sample.totalCpuPercent, unit: "percent", source: "process-tree" });
    raw.push({ tMs: sample.sampledAtMs, metric: "memory.process_tree.working_set_bytes", value: sample.totalResidentMemoryBytes, unit: "byte", source: "process-tree" });
    raw.push({ tMs: sample.sampledAtMs, metric: "memory.process_tree.virtual_bytes", value: sample.totalVirtualMemoryBytes, unit: "byte", source: "process-tree" });
    raw.push({ tMs: sample.sampledAtMs, metric: "process.process_count", value: sample.processCount, unit: "count", source: "process-tree" });
  }

  return {
    collector: "process-tree",
    status: samples.some((sample) => !sample.rootFound) ? "partial" : "completed",
    samples: raw,
    metrics,
    artifacts: [],
    warnings: samples.some((sample) => !sample.rootFound)
      ? [{ code: "PROCESS_ROOT_MISSING", message: "The target root process was absent from one or more samples" }]
      : [],
    errors: [],
  };
}

function summary(metrics: Record<string, MetricMeasurement>, prefix: string, values: readonly number[], unit: string, coverageRatio: number): void {
  measured(metrics, `${prefix}.mean`, arithmeticMean(values), unit, values.length, coverageRatio);
  measured(metrics, `${prefix}.p95`, quantile(values, 0.95), unit, values.length, coverageRatio);
  measured(metrics, `${prefix}.peak`, Math.max(...values), unit, values.length, coverageRatio);
}

function measured(metrics: Record<string, MetricMeasurement>, id: string, value: number, unit: string, sampleCount: number, coverageRatio: number): void {
  metrics[id] = { status: "measured", value, unit, sampleCount, source: "process-tree", comparable: true, coverageRatio };
}

function unavailable(unit: string, reason: string): MetricMeasurement {
  return { status: "unavailable", unit, sampleCount: 0, source: "process-tree", comparable: false, reason };
}

function estimateInterval(samples: readonly ProcessTreeSample[]): number {
  if (samples.length < 2) return 0;
  const gaps = samples.slice(1).map((sample, index) => sample.sampledAtMs - samples[index]!.sampledAtMs);
  return arithmeticMean(gaps);
}

function integrateCpuSeconds(samples: readonly ProcessTreeSample[]): number {
  let total = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    const seconds = (current.sampledAtMs - previous.sampledAtMs) / 1000;
    total += ((previous.totalCpuPercent + current.totalCpuPercent) / 2 / 100) * seconds;
  }
  return total;
}

function linearSlope(points: ReadonlyArray<readonly [number, number]>): number {
  const meanX = arithmeticMean(points.map(([x]) => x));
  const meanY = arithmeticMean(points.map(([, y]) => y));
  let numerator = 0;
  let denominator = 0;
  for (const [x, y] of points) {
    numerator += (x - meanX) * (y - meanY);
    denominator += (x - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}
