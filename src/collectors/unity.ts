import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ArtifactReference,
  CollectorResult,
  MetricMeasurement,
  MetricSample,
  StructuredIssue,
  TargetConfig,
} from "../types.js";

const BRIDGE_PERF_MARKER = "THREE_UNITY_BRIDGE_PERF";
const MEASUREMENT_START_MARKER = "THREE_UNITY_PERF_MEASUREMENT_STARTED";
const RESULT_MARKER = "THREE_UNITY_PERF_RESULT";
const BRIDGE_LOG_INTERVAL_FIXED_TICKS = 120;

export interface UnityCollectionOptions {
  target: TargetConfig;
  warmupMs: number;
  durationMs: number;
  outputDirectory: string;
  runId: string;
  timeoutMs?: number;
  onProcessStarted?: (pid: number) => void | Promise<void>;
  onProcessExited?: () => void | Promise<void>;
}

export interface UnityCollectionResult {
  collector: "unity-probe";
  startedAt: string;
  durationMs: number;
  outputPath: string;
  logPath: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  probe: UnityProbeResult;
  log: UnityLogResult;
  normalized: CollectorResult;
}

export interface UnityProbeResult {
  schemaVersion: string;
  probeVersion: string;
  kind: "unity";
  status: "completed";
  runId: string;
  startedAt: string;
  completedAt: string;
  warmupMs: number;
  requestedDurationMs: number;
  measuredDurationMs: number;
  readyWaitMs: number;
  measuredFrames: number;
  fixedDeltaTimeMs: number;
  unityVersion: string;
  productName: string;
  platform: string;
  operatingSystem: string;
  processorType: string;
  processorCount: number;
  systemMemoryMb: number;
  graphicsDeviceName: string;
  graphicsDeviceType: string;
  graphicsDeviceVersion: string;
  graphicsMemoryMb: number;
  screenWidth: number;
  screenHeight: number;
  targetFrameRate: number;
  vSyncCount: number;
  isBatchMode: boolean;
  metrics: UnityProbeMetricSummary[];
  samples: UnityProbeSample[];
  checkpoints: UnityProbeCheckpoint[];
}

export interface UnityProbeMetricSummary {
  name: string;
  unit: string;
  source: string;
  status: "measured" | "unavailable";
  reason: string;
  sampleCount: number;
  coverageRatio: number;
  sum: number;
  mean: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  last: number;
}

export interface UnityProbeSample {
  tMs: number;
  metric: string;
  value: number;
  unit: string;
  source: string;
}

export interface UnityProbeCheckpoint {
  tMs: number;
  measurementTMs: number;
  phase: "warmup" | "measurement";
  name: string;
  value: boolean;
}

export type BridgePerfValue = string | number | boolean;

export interface BridgePerfRecord {
  lineNumber: number;
  raw: string;
  fields: Record<string, BridgePerfValue>;
}

export interface UnityLogResult {
  bridgePerf: BridgePerfRecord[];
  protocolErrors: number;
  fallbacks: number;
  measurementStartLine: number | null;
  resultLine: number | null;
}

export async function collectUnity(options: UnityCollectionOptions): Promise<UnityCollectionResult> {
  const executable = options.target.executable ?? options.target.launch?.command;
  if (!executable) throw new Error(`Unity target '${options.target.id}' has no executable or launch command.`);

  await mkdir(options.outputDirectory, { recursive: true });
  const fileStem = safeFileStem(options.runId);
  const outputPath = resolve(options.outputDirectory, `${fileStem}.unity-probe.json`);
  const logPath = resolve(options.outputDirectory, `${fileStem}.unity-player.log`);
  const launch = options.target.launch;
  const configuredArgs = launch ? launch.args ?? [] : options.target.args ?? [];
  const args = [
    ...configuredArgs,
    "-logFile",
    logPath,
    "--three-perf-output",
    outputPath,
    "--three-perf-run-id",
    options.runId,
    "--three-perf-warmup-ms",
    String(options.warmupMs),
    "--three-perf-duration-ms",
    String(options.durationMs),
    ...unityReadyArguments(options.target),
  ];
  const cwd = options.target.cwd ?? launch?.cwd ?? process.cwd();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.target.env ?? {}),
    ...(launch?.env ?? {}),
  };
  const timeoutMs = options.timeoutMs
    ?? unityReadyTimeoutMs(options.target) + options.warmupMs + options.durationMs + 30_000;
  const startedAt = new Date().toISOString();
  const child = spawn(executable, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });

  if (child.pid === undefined) {
    throw new Error(`Unity Player '${executable}' did not expose a process ID after launch.`);
  }
  const processCompletion = waitForProcess(child, timeoutMs, executable);
  let processResult: { exitCode: number | null; signal: NodeJS.Signals | null };
  try {
    await options.onProcessStarted?.(child.pid);
    processResult = await processCompletion;
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await processCompletion.catch(() => undefined);
    throw error;
  } finally {
    await options.onProcessExited?.();
  }
  const probeText = await readFile(outputPath, "utf8").catch((error: unknown) => {
    throw new Error(`Unity Player exited without probe output '${outputPath}': ${messageOf(error)}`);
  });
  const logText = await readFile(logPath, "utf8").catch((error: unknown) => {
    throw new Error(`Unity Player did not create log '${logPath}': ${messageOf(error)}`);
  });
  const probe = parseUnityProbeResult(probeText);
  const log = parseUnityLog(logText);
  const normalized = normalizeUnityResult({
    probe,
    log,
    targetId: options.target.id,
    outputPath,
    logPath,
    exitCode: processResult.exitCode,
  });

  return {
    collector: "unity-probe",
    startedAt,
    durationMs: probe.measuredDurationMs,
    outputPath,
    logPath,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    stdout,
    stderr,
    probe,
    log,
    normalized,
  };
}

export function parseUnityProbeResult(text: string): UnityProbeResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid Unity probe JSON: ${messageOf(error)}`);
  }
  if (!isRecord(value)
    || value.kind !== "unity"
    || value.status !== "completed"
    || typeof value.runId !== "string"
    || typeof value.measuredDurationMs !== "number"
    || typeof value.measuredFrames !== "number"
    || !Array.isArray(value.metrics)
    || !Array.isArray(value.samples)
    || !Array.isArray(value.checkpoints)) {
    throw new Error("Invalid Unity probe result: required identity, timing, metrics, or samples are missing.");
  }
  for (const metric of value.metrics) validateProbeMetric(metric);
  for (const sample of value.samples) validateProbeSample(sample);
  for (const checkpoint of value.checkpoints) validateProbeCheckpoint(checkpoint);
  return value as unknown as UnityProbeResult;
}

export function parseBridgePerfLine(line: string, lineNumber = 0): BridgePerfRecord | undefined {
  const markerAt = line.indexOf(BRIDGE_PERF_MARKER);
  if (markerAt < 0) return undefined;
  const fields: Record<string, BridgePerfValue> = {};
  const body = line.slice(markerAt + BRIDGE_PERF_MARKER.length).trim();
  for (const token of body.split(/\s+/u)) {
    const separator = token.indexOf("=");
    if (separator <= 0) continue;
    const name = token.slice(0, separator);
    const rawValue = token.slice(separator + 1);
    fields[name] = parseBridgeValue(rawValue);
  }
  return { lineNumber, raw: line, fields };
}

export function parseBridgePerfLog(text: string): BridgePerfRecord[] {
  return parseUnityLog(text).bridgePerf;
}

export function parseUnityLog(text: string): UnityLogResult {
  const lines = text.split(/\r?\n/u);
  const measurementStart = lines.findIndex((line) => line.includes(MEASUREMENT_START_MARKER));
  const resultLine = lines.findIndex((line, index) =>
    index > measurementStart && line.includes(RESULT_MARKER));
  const start = measurementStart >= 0 ? measurementStart + 1 : 0;
  const end = resultLine >= 0 ? resultLine : lines.length;
  const bridgePerf: BridgePerfRecord[] = [];
  let protocolErrors = 0;
  let fallbacks = 0;
  for (let index = start; index < end; index++) {
    const line = lines[index]!;
    const bridge = parseBridgePerfLine(line, index + 1);
    if (bridge) bridgePerf.push(bridge);
    if (line.includes("THREE_UNITY_LOGIC_PROTOCOL_ERROR")) protocolErrors++;
    if (line.includes("THREE_UNITY_LOGIC_FALLBACK")) fallbacks++;
  }
  return {
    bridgePerf,
    protocolErrors,
    fallbacks,
    measurementStartLine: measurementStart >= 0 ? measurementStart + 1 : null,
    resultLine: resultLine >= 0 ? resultLine + 1 : null,
  };
}

export function normalizeUnityResult(input: {
  probe: UnityProbeResult;
  log: UnityLogResult;
  targetId: string;
  outputPath: string;
  logPath: string;
  exitCode: number | null;
}): CollectorResult {
  const metrics: Record<string, MetricMeasurement> = {};
  const summaries = new Map(input.probe.metrics.map((metric) => [metric.name, metric]));

  mapSummary(metrics, summaries, "unity.frame.cpu_ms.p95", "unity.frame.cpu_ms", "p95", "ms");
  mapSummary(metrics, summaries, "unity.frame.gpu_ms.p95", "unity.frame.gpu_ms", "p95", "ms");
  mapSummary(metrics, summaries, "unity.main_thread_ms.p95", "unity.main_thread_ms", "p95", "ms");
  mapSummary(metrics, summaries, "unity.render_thread_ms.p95", "unity.render_thread_ms", "p95", "ms");
  mapSummary(metrics, summaries, "unity.wait_for_present_ms.p95", "unity.wait_for_present_ms", "p95", "ms");
  mapSummary(metrics, summaries, "unity.gc.alloc_bytes_per_frame.mean", "unity.gc.alloc_bytes_per_frame", "mean", "byte/frame");
  mapRate(metrics, summaries, input.probe);
  mapSummary(metrics, summaries, "unity.gc.used_bytes.peak", "unity.gc.used_bytes", "max", "byte");
  mapSummary(metrics, summaries, "unity.gc.reserved_bytes.peak", "unity.gc.reserved_bytes", "max", "byte");
  mapSummary(metrics, summaries, "render.unity.draw_calls", "render.unity.draw_calls_per_frame", "mean", "count/frame");
  mapSummary(metrics, summaries, "render.unity.batches", "render.unity.batches_per_frame", "mean", "count/frame");
  mapSummary(metrics, summaries, "render.unity.triangles", "render.unity.triangles_per_frame", "mean", "count/frame");

  const bridgeSamples = normalizeBridgeMetrics(metrics, input.log, input.probe);
  metrics["stability.nonzero_exit_count"] = measured(
    input.exitCode === null || input.exitCode === 0 ? 0 : 1,
    "count",
    1,
    "unity-runner",
    true,
    1,
  );
  const scenarioCheckpoint = [...input.probe.checkpoints]
    .reverse()
    .find((checkpoint) => checkpoint.name === "scenario-complete");
  metrics["stability.scenario_completed"] = scenarioCheckpoint === undefined
    ? unavailable(
      "boolean",
      "unity-probe:checkpoint",
      "The scenario did not emit ThreeUnityPerformance.Checkpoint(\"scenario-complete\").",
      true,
    )
    : measured(scenarioCheckpoint.value ? 1 : 0, "boolean", 1, "unity-probe:checkpoint", true, 1);

  const unavailableNames = Object.entries(metrics)
    .filter(([, metric]) => metric.status !== "measured")
    .map(([name]) => name);
  const warnings: StructuredIssue[] = [];
  if (unavailableNames.length > 0) {
    warnings.push({
      code: "UNITY_METRICS_UNAVAILABLE",
      message: `${unavailableNames.length} Unity metrics were unavailable; inspect each metric reason.`,
      scope: input.targetId,
      retryable: false,
      details: { metrics: unavailableNames },
    });
  }
  const errors: StructuredIssue[] = [];
  if (input.exitCode !== null && input.exitCode !== 0) {
    errors.push({
      code: "UNITY_NONZERO_EXIT",
      message: `Unity Player exited with code ${input.exitCode}.`,
      scope: input.targetId,
      retryable: false,
      details: { exitCode: input.exitCode },
    });
  }

  const artifacts: ArtifactReference[] = [
    {
      path: input.outputPath,
      mediaType: "application/json",
      recordCount: input.probe.samples.length,
      description: "Unity runtime probe result and raw metric samples.",
    },
    {
      path: input.logPath,
      mediaType: "text/plain",
      recordCount: input.log.bridgePerf.length,
      description: "Unity Player log including bridge performance markers.",
    },
  ];
  const samples: MetricSample[] = input.probe.samples.map((sample) => ({
    ...sample,
    targetId: input.targetId,
  }));
  samples.push(...bridgeSamples.map((sample) => ({ ...sample, targetId: input.targetId })));

  return {
    collector: "unity-probe",
    status: errors.length > 0 ? "partial" : unavailableNames.length > 0 ? "partial" : "completed",
    samples,
    metrics,
    artifacts,
    warnings,
    errors,
  };
}

function normalizeBridgeMetrics(
  metrics: Record<string, MetricMeasurement>,
  log: UnityLogResult,
  probe: UnityProbeResult,
): MetricSample[] {
  const records = log.bridgePerf;
  const source = "bridge-log:THREE_UNITY_BRIDGE_PERF";
  const samples: MetricSample[] = [];
  const queueDepths: number[] = [];
  const inputAges: number[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const tMs = records.length === 0 ? 0 : probe.measuredDurationMs * ((index + 1) / records.length);
    const inbound = numericField(record, "inPending");
    const outbound = numericField(record, "outPending");
    if (inbound !== undefined && outbound !== undefined) {
      const depth = inbound + outbound;
      queueDepths.push(depth);
      samples.push({ tMs, metric: "bridge.queue_pending", value: depth, unit: "count", source });
    }
    const inputAge = numericField(record, "inputAgeMs");
    if (inputAge !== undefined) {
      inputAges.push(inputAge);
      samples.push({ tMs, metric: "bridge.input_age_ms", value: inputAge, unit: "ms", source });
    }
  }

  mapBridgeRate(metrics, records, probe, "bridge.rx_messages_per_second", "rx", "message/s");
  mapBridgeRate(metrics, records, probe, "bridge.tx_messages_per_second", "tx", "message/s");
  mapBridgeRate(metrics, records, probe, "bridge.rx_characters_per_second", "rxChars", "character/s");
  mapBridgeRate(metrics, records, probe, "bridge.tx_characters_per_second", "txChars", "character/s");
  mapArray(metrics, "bridge.queue_pending.p95", queueDepths, "p95", "count", source, false);
  mapArray(metrics, "bridge.queue_pending.max", queueDepths, "max", "count", source, false);
  mapArray(metrics, "bridge.input_age_ms.p95", inputAges, "p95", "ms", source, false);

  mapFinalBridgeCounter(metrics, records, "bridge.dropped", "dropped");
  mapFinalBridgeCounter(metrics, records, "bridge.backpressure", "backpressure");
  mapFinalBridgeCounter(metrics, records, "bridge.inbound_overflow", "inboundOverflow");
  mapFinalBridgeCounter(metrics, records, "bridge.diagnostic_overflow", "diagnosticOverflow");
  metrics["bridge.protocol_errors"] = measured(log.protocolErrors, "count", 1, "bridge-log", false, 1);
  metrics["bridge.fallbacks"] = measured(log.fallbacks, "count", 1, "bridge-log", false, 1);

  if (records.length === 0) {
    metrics["bridge.recovery_count"] = unavailable("count", "bridge-log", "No bridge performance markers were recorded.", false);
  } else {
    const last = records.at(-1)!;
    const recoveries = (numericField(last, "transportResets") ?? 0)
      + (numericField(last, "sessionRestarts") ?? 0);
    metrics["bridge.recovery_count"] = measured(recoveries, "count", 1, source, false, 1);
  }
  return samples;
}

function mapBridgeRate(
  metrics: Record<string, MetricMeasurement>,
  records: BridgePerfRecord[],
  probe: UnityProbeResult,
  metricName: string,
  field: string,
  unit: string,
): void {
  const source = "bridge-log:THREE_UNITY_BRIDGE_PERF";
  if (records.length < 2) {
    metrics[metricName] = unavailable(unit, source, "At least two bridge snapshots are required for a rate.", false);
    return;
  }
  const first = numericField(records[0]!, field);
  const last = numericField(records.at(-1)!, field);
  if (first === undefined || last === undefined || last < first) {
    metrics[metricName] = unavailable(unit, source, `Bridge field '${field}' is missing or reset during measurement.`, false);
    return;
  }
  const sampledMs = (records.length - 1) * BRIDGE_LOG_INTERVAL_FIXED_TICKS * probe.fixedDeltaTimeMs;
  if (sampledMs <= 0) {
    metrics[metricName] = unavailable(unit, source, "Bridge snapshot interval is not positive.", false);
    return;
  }
  const coverage = Math.min(1, sampledMs / probe.measuredDurationMs);
  metrics[metricName] = measured((last - first) / (sampledMs / 1000), unit, records.length, source, false, coverage);
}

function mapFinalBridgeCounter(
  metrics: Record<string, MetricMeasurement>,
  records: BridgePerfRecord[],
  metricName: string,
  field: string,
): void {
  const value = records.length === 0 ? undefined : numericField(records.at(-1)!, field);
  metrics[metricName] = value === undefined
    ? unavailable("count", "bridge-log", `Bridge field '${field}' was not recorded.`, false)
    : measured(value, "count", records.length, "bridge-log:THREE_UNITY_BRIDGE_PERF", false, 1);
}

function mapSummary(
  metrics: Record<string, MetricMeasurement>,
  summaries: Map<string, UnityProbeMetricSummary>,
  outputName: string,
  seriesName: string,
  statistic: "mean" | "p95" | "max",
  unit: string,
): void {
  const summary = summaries.get(seriesName);
  if (!summary) {
    metrics[outputName] = unavailable(unit, "unity-probe", `Probe series '${seriesName}' is missing.`, false);
    return;
  }
  if (summary.status !== "measured") {
    metrics[outputName] = unavailable(unit, summary.source, summary.reason || `Probe series '${seriesName}' is unavailable.`, false);
    return;
  }
  metrics[outputName] = measured(
    summary[statistic],
    unit,
    summary.sampleCount,
    summary.source,
    false,
    summary.coverageRatio,
  );
}

function mapRate(
  metrics: Record<string, MetricMeasurement>,
  summaries: Map<string, UnityProbeMetricSummary>,
  probe: UnityProbeResult,
): void {
  const name = "unity.gc.alloc_bytes_per_second";
  const summary = summaries.get("unity.gc.alloc_bytes_per_frame");
  if (!summary || summary.status !== "measured" || probe.measuredDurationMs <= 0) {
    metrics[name] = unavailable(
      "byte/s",
      summary?.source ?? "unity-probe",
      summary?.reason || "Managed allocation samples or measured duration are unavailable.",
      false,
    );
    return;
  }
  metrics[name] = measured(
    summary.sum / (probe.measuredDurationMs / 1000),
    "byte/s",
    summary.sampleCount,
    summary.source,
    false,
    summary.coverageRatio,
  );
}

function mapArray(
  metrics: Record<string, MetricMeasurement>,
  name: string,
  values: number[],
  statistic: "p95" | "max",
  unit: string,
  source: string,
  comparable: boolean,
): void {
  if (values.length === 0) {
    metrics[name] = unavailable(unit, source, "No bridge samples were recorded for this metric.", comparable);
    return;
  }
  const value = statistic === "max" ? Math.max(...values) : percentile(values, 0.95);
  metrics[name] = measured(value, unit, values.length, source, comparable, 1);
}

function measured(
  value: number,
  unit: string,
  sampleCount: number,
  source: string,
  comparable: boolean,
  coverageRatio: number,
): MetricMeasurement {
  return { status: "measured", value, unit, sampleCount, source, comparable, coverageRatio };
}

function unavailable(
  unit: string,
  source: string,
  reason: string,
  comparable: boolean,
): MetricMeasurement {
  return { status: "unavailable", unit, sampleCount: 0, source, comparable, coverageRatio: 0, reason };
}

function numericField(record: BridgePerfRecord, name: string): number | undefined {
  const value = record.fields[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseBridgeValue(value: string): BridgePerfValue {
  if (/^-?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function validateProbeMetric(value: unknown): asserts value is UnityProbeMetricSummary {
  if (!isRecord(value)
    || typeof value.name !== "string"
    || typeof value.unit !== "string"
    || typeof value.source !== "string"
    || (value.status !== "measured" && value.status !== "unavailable")
    || typeof value.sampleCount !== "number") {
    throw new Error("Invalid Unity probe metric summary.");
  }
}

function validateProbeSample(value: unknown): asserts value is UnityProbeSample {
  if (!isRecord(value)
    || typeof value.tMs !== "number"
    || typeof value.metric !== "string"
    || typeof value.value !== "number"
    || typeof value.unit !== "string"
    || typeof value.source !== "string") {
    throw new Error("Invalid Unity probe metric sample.");
  }
}

function validateProbeCheckpoint(value: unknown): asserts value is UnityProbeCheckpoint {
  if (!isRecord(value)
    || typeof value.tMs !== "number"
    || typeof value.measurementTMs !== "number"
    || (value.phase !== "warmup" && value.phase !== "measurement")
    || typeof value.name !== "string"
    || typeof value.value !== "boolean") {
    throw new Error("Invalid Unity probe checkpoint.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function percentile(values: number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 1) return ordered[0]!;
  const position = (ordered.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower]!;
  return ordered[lower]! + ((ordered[upper]! - ordered[lower]!) * (position - lower));
}

function safeFileStem(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return sanitized || "unity-run";
}

function unityReadyArguments(target: TargetConfig): string[] {
  if (!target.ready) return [];
  if (target.ready.type === "delay") {
    return ["--three-perf-ready-delay-ms", String(target.ready.delayMs)];
  }
  if (target.ready.type === "log") {
    return ["--three-perf-ready-log-pattern", target.ready.pattern];
  }
  throw new Error(`Unity target '${target.id}' does not support ready condition '${target.ready.type}'.`);
}

function unityReadyTimeoutMs(target: TargetConfig): number {
  if (!target.ready) return 0;
  if (target.ready.type === "delay") return target.ready.delayMs;
  if (target.ready.type === "log") return target.ready.timeoutMs ?? 30_000;
  return 0;
}

function waitForProcess(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  executable: string,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(new Error(`Failed to launch Unity Player '${executable}': ${error.message}`));
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (timedOut) {
        rejectPromise(new Error(`Unity Player exceeded the ${timeoutMs} ms collection timeout.`));
        return;
      }
      resolvePromise({ exitCode, signal });
    });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
