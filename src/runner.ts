import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { compareRuns } from "./analytics/compare.js";
import { collectUnity, type UnityCollectionResult } from "./collectors/unity.js";
import { inventoryArtifact, inventoryThreeUnity } from "./collectors/artifact.js";
import { filterPresentMonFrames, PresentMonCollector, type PresentMonCaptureResult } from "./collectors/presentmon.js";
import { presentMonFramesToCollector } from "./collectors/presentmon-metrics.js";
import { ProcessMonitorSession, processSamplesToCollector } from "./collectors/process-metrics.js";
import type { ProcessTreeSample } from "./collectors/process-tree.js";
import { collectWeb, type WebBrowserConfig, type WebCollectionResult } from "./collectors/web.js";
import { webResultToCollector } from "./collectors/web-metrics.js";
import { planRuns } from "./config.js";
import { captureEnvironment } from "./environment.js";
import { renderHtmlReport, renderMarkdownReport } from "./report/index.js";
import { launchManaged, waitForHttp, type ManagedProcess } from "./target-process.js";
import {
  SCHEMA_VERSION,
  type ArtifactReference,
  type BenchmarkConfig,
  type CollectorResult,
  type ComparisonResult,
  type JsonObject,
  type MetricMeasurement,
  type MetricSample,
  type RunResult,
  type StructuredIssue,
  type TargetConfig,
  type TargetRole,
} from "./types.js";

export interface BenchmarkSuiteResult {
  schemaVersion: typeof SCHEMA_VERSION;
  suiteId: string;
  createdAt: string;
  completedAt: string;
  outputDirectory: string;
  experiment: BenchmarkConfig["experiment"];
  targets: BenchmarkConfig["targets"];
  environment: JsonObject;
  runs: RunResult[];
  comparison: ComparisonResult;
  artifacts: ArtifactReference[];
}

export interface BenchmarkProgressEvent {
  phase: "suite-start" | "run-start" | "run-complete" | "comparison" | "suite-complete";
  message: string;
  runId?: string;
  targetId?: string;
  completedRuns?: number;
  totalRuns?: number;
}

export interface RunBenchmarkOptions {
  outputDirectory?: string;
  onProgress?: (event: BenchmarkProgressEvent) => void;
}

interface TargetRunContext {
  config: BenchmarkConfig;
  target: TargetConfig;
  role: TargetRole;
  pairIndex: number;
  order: number;
  runId: string;
  outputDirectory: string;
}

interface CollectedTargetRun {
  collectors: CollectorResult[];
  raw: unknown;
  startedAt: string;
  durationMs: number;
  readyMs: number;
  exitCode: number;
}

export async function runBenchmark(config: BenchmarkConfig, options: RunBenchmarkOptions = {}): Promise<BenchmarkSuiteResult> {
  const createdAt = new Date().toISOString();
  const suiteId = `${safeStem(config.experiment.name)}-${compactTimestamp(createdAt)}`;
  const baseOutput = options.outputDirectory ?? config.outputDirectory ?? resolve(".bench-results");
  const outputDirectory = options.outputDirectory ? resolve(baseOutput) : resolve(baseOutput, suiteId);
  await mkdir(resolve(outputDirectory, "runs"), { recursive: true });
  options.onProgress?.({ phase: "suite-start", message: `Starting ${config.experiment.name}` });
  const environment = await captureEnvironment();
  const plan = planRuns(config);
  const runs: RunResult[] = [];

  for (let index = 0; index < plan.length; index += 1) {
    const planned = plan[index]!;
    const target = config.targets[planned.role];
    const runId = `${safeStem(target.id)}-${String(planned.pairIndex + 1).padStart(2, "0")}`;
    options.onProgress?.({
      phase: "run-start",
      message: `Running ${target.id} pair ${planned.pairIndex + 1}`,
      runId,
      targetId: target.id,
      completedRuns: index,
      totalRuns: plan.length,
    });
    const result = await runTarget({
      config,
      target,
      role: planned.role,
      pairIndex: planned.pairIndex,
      order: planned.order,
      runId,
      outputDirectory,
    });
    runs.push(result);
    options.onProgress?.({
      phase: "run-complete",
      message: `Completed ${target.id} pair ${planned.pairIndex + 1}`,
      runId,
      targetId: target.id,
      completedRuns: index + 1,
      totalRuns: plan.length,
    });
    if (index < plan.length - 1 && (config.experiment.betweenRunsMs ?? 0) > 0) {
      await delay(config.experiment.betweenRunsMs!);
    }
  }

  options.onProgress?.({ phase: "comparison", message: "Comparing paired runs" });
  const beforeRuns = runs.filter((run) => run.targetId === config.targets.before.id);
  const afterRuns = runs.filter((run) => run.targetId === config.targets.after.id);
  const comparison = compareRuns(beforeRuns, afterRuns, {
    gates: config.gates ?? [],
    seed: config.experiment.seed,
    comparisonId: `${suiteId}-${safeStem(config.targets.before.id)}-vs-${safeStem(config.targets.after.id)}`,
  });
  const failedRunErrors = runs.flatMap((run) => run.errors.map((error) => ({
    ...error,
    scope: run.runId,
  })));
  if (failedRunErrors.length > 0) {
    comparison.errors.push(...failedRunErrors);
    comparison.verdict = "inconclusive";
  }
  const comparisonPath = resolve(outputDirectory, "comparison.json");
  const markdownPath = resolve(outputDirectory, "report.md");
  const htmlPath = resolve(outputDirectory, "report.html");
  await writeJson(comparisonPath, comparison);
  const reportInput = { title: config.experiment.name, comparison, runs, experiment: config.experiment, environment };
  await writeFile(markdownPath, renderMarkdownReport(reportInput), "utf8");
  await writeFile(htmlPath, renderHtmlReport(reportInput), "utf8");
  const suite: BenchmarkSuiteResult = {
    schemaVersion: SCHEMA_VERSION,
    suiteId,
    createdAt,
    completedAt: new Date().toISOString(),
    outputDirectory,
    experiment: config.experiment,
    targets: config.targets,
    environment,
    runs,
    comparison,
    artifacts: [
      { path: comparisonPath, mediaType: "application/json", description: "Machine-readable paired comparison." },
      { path: markdownPath, mediaType: "text/markdown", description: "Portable benchmark report." },
      { path: htmlPath, mediaType: "text/html", description: "Self-contained interactive-style benchmark report." },
    ],
  };
  const suitePath = resolve(outputDirectory, "suite.json");
  suite.artifacts.unshift({ path: suitePath, mediaType: "application/json", description: "Complete benchmark suite manifest." });
  await writeJson(suitePath, suite);
  options.onProgress?.({ phase: "suite-complete", message: `Benchmark ${comparison.verdict}`, completedRuns: runs.length, totalRuns: runs.length });
  return suite;
}

async function runTarget(context: TargetRunContext): Promise<RunResult> {
  const wallStarted = performance.now();
  const startedAt = new Date().toISOString();
  const runDirectory = resolve(context.outputDirectory, "runs", context.runId);
  await mkdir(runDirectory, { recursive: true });
  const collected = context.target.runtime === "web"
    ? await runWebTarget(context, runDirectory)
    : await runUnityTarget(context, runDirectory);
  const staticCollector = await collectStaticArtifacts(context);
  if (staticCollector) collected.collectors.push(staticCollector);
  const metrics = mergeMetrics(collected.collectors);
  metrics["startup.spawn_to_ready_ms"] = measurement(collected.readyMs, "ms", 1, "runner", true, 1);
  metrics["stability.crash_count"] = measurement(collected.exitCode === 0 ? 0 : 1, "count", 1, "runner", true, 1);
  const rawSamples = collected.collectors.flatMap((collector) => collector.samples);
  const samplesPath = resolve(runDirectory, "samples.jsonl");
  const rawPath = resolve(runDirectory, "raw.json");
  const runPath = resolve(runDirectory, "run.json");
  await writeFile(samplesPath, rawSamples.map((sample) => JSON.stringify(sample)).join("\n") + (rawSamples.length > 0 ? "\n" : ""), "utf8");
  await writeJson(rawPath, collected.raw);
  const artifacts = mergeArtifacts(collected.collectors, [
    { path: samplesPath, mediaType: "application/x-ndjson", recordCount: rawSamples.length, description: "Timestamped raw metric samples." },
    { path: rawPath, mediaType: "application/json", description: "Collector-native result for audit and debugging." },
    { path: runPath, mediaType: "application/json", description: "Normalized run result." },
  ]);
  const run: RunResult = {
    schemaVersion: SCHEMA_VERSION,
    runId: context.runId,
    targetId: context.target.id,
    targetRuntime: context.target.runtime,
    targetVariant: context.target.variant,
    index: context.pairIndex,
    order: context.order,
    status: collected.collectors.some((collector) => collector.status === "failed" || collector.errors.length > 0)
      ? "failed"
      : "completed",
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: performance.now() - wallStarted,
    phases: {
      readyMs: collected.readyMs,
      warmupMs: context.config.experiment.warmupMs,
      measurementMs: collected.durationMs,
    },
    metrics,
    artifacts,
    warnings: collected.collectors.flatMap((collector) => collector.warnings),
    errors: collected.collectors.flatMap((collector) => collector.errors),
    metadata: {
      role: context.role,
      collectors: collected.collectors.map((collector) => ({ name: collector.collector, status: collector.status })),
    },
  };
  await writeJson(runPath, run);
  return run;
}

async function runWebTarget(context: TargetRunContext, runDirectory: string): Promise<CollectedTargetRun> {
  const targetLaunchStarted = performance.now();
  let serverReadyMs = 0;
  let server: ManagedProcess | undefined;
  let processMonitor: ProcessMonitorSession | undefined;
  let processSamples: ProcessTreeSample[] = [];
  let presentMonPromise: Promise<PresentMonCaptureResult> | undefined;
  let presentMonResult: PresentMonCaptureResult | undefined;
  const processEnabled = collectorEnabled(context.config, "processTree", true);
  const presentMonEnabled = collectorEnabled(context.config, "presentmon", false);
  const presentOptions = collectorOptions(context.config, "presentmon");

  try {
    if (context.target.launch) {
      server = launchManaged(context.target.launch);
      await waitForWebServer(context.target);
      serverReadyMs = performance.now() - targetLaunchStarted;
    }
    const raw = await collectWeb({
      url: context.target.url!,
      warmupMs: context.config.experiment.warmupMs,
      durationMs: context.config.experiment.measureMs,
      viewport: context.config.experiment.viewport,
      browser: webBrowserOptions(context.config),
      ...(webReadyOptions(context.target) === undefined ? {} : { ready: webReadyOptions(context.target)! }),
      ...(context.config.scenario === undefined ? {} : {
        scenarioPath: context.config.scenario.adapter,
        scenarioParameters: context.config.scenario.parameters ?? {},
      }),
      seed: context.config.experiment.seed,
      onMeasurementStart: async (processIds, processes) => {
        const rootPid = processes.find((entry) => entry.type === "browser")?.id ?? processIds[0];
        if (processEnabled && rootPid !== undefined) {
          processMonitor = new ProcessMonitorSession(rootPid, collectorInterval(context.config, "processTree", 500));
          await processMonitor.start();
        }
        if (presentMonEnabled) {
          const processNames = stringArrayOption(presentOptions, "processNames");
          if (rootPid === undefined && processNames.length === 0) throw new Error("PresentMon requires a browser PID or configured processNames");
          const collector = new PresentMonCollector({
            binaryPath: stringOption(presentOptions, "binaryPath", "PresentMon.exe"),
            ...(processNames.length > 0 ? { processNames } : { processId: rootPid! }),
            includedProcessIds: processIds,
            outputPath: resolve(runDirectory, "presentmon.csv"),
            durationSeconds: Math.max(1, Math.ceil(context.config.experiment.measureMs / 1000)),
            metricsVersion: optionChoice(presentOptions, "metricsVersion", ["v1", "v2"] as const, "v2"),
          });
          presentMonPromise = capturePresentMon(collector);
        }
      },
      onMeasurementEnd: async () => {
        if (processMonitor) processSamples = await processMonitor.stop();
        if (presentMonPromise) presentMonResult = await presentMonPromise;
      },
    });
    if (processMonitor && processSamples.length === 0) processSamples = await processMonitor.stop();
    if (presentMonPromise && presentMonResult === undefined) presentMonResult = await presentMonPromise;
    const collectors: CollectorResult[] = [
      webResultToCollector(raw, context.config.experiment.frameBudgetMs, context.config.scenario !== undefined),
    ];
    if (processEnabled) collectors.push(applyCollectorRequirement(
      processSamplesToCollector(processSamples, context.config.experiment.measureMs),
      context.config,
      "processTree",
    ));
    appendPresentMonCollector(collectors, presentMonResult, context, runDirectory);
    return {
      collectors,
      raw,
      startedAt: raw.startedAt,
      durationMs: raw.durationMs,
      readyMs: serverReadyMs + raw.readyMs,
      exitCode: 0,
    };
  } finally {
    if (processMonitor && processSamples.length === 0) processSamples = await processMonitor.stop();
    if (presentMonPromise && presentMonResult === undefined) presentMonResult = await presentMonPromise;
    if (server) {
      await server.stop();
      const serverLog = `${server.stdout.join("")}\n${server.stderr.join("")}`;
      await writeFile(resolve(runDirectory, "server.log"), serverLog, "utf8");
    }
  }
}

async function runUnityTarget(context: TargetRunContext, runDirectory: string): Promise<CollectedTargetRun> {
  const targetLaunchStartedAtMs = performance.now();
  let processMonitor: ProcessMonitorSession | undefined;
  let processSamples: ProcessTreeSample[] = [];
  let presentMonPromise: Promise<PresentMonCaptureResult> | undefined;
  let presentMonResult: PresentMonCaptureResult | undefined;
  const processEnabled = collectorEnabled(context.config, "processTree", true);
  const presentMonEnabled = collectorEnabled(context.config, "presentmon", false);
  const presentOptions = collectorOptions(context.config, "presentmon");
  const timeoutMs = context.config.experiment.warmupMs + context.config.experiment.measureMs + 30_000;
  const raw = await collectUnity({
    target: context.target,
    warmupMs: context.config.experiment.warmupMs,
    durationMs: context.config.experiment.measureMs,
    outputDirectory: runDirectory,
    runId: context.runId,
    timeoutMs,
    onProcessStarted: async (pid) => {
      if (processEnabled) {
        processMonitor = new ProcessMonitorSession(pid, collectorInterval(context.config, "processTree", 500));
        await processMonitor.start();
      }
      if (presentMonEnabled) {
        const processNames = stringArrayOption(presentOptions, "processNames");
        const collector = new PresentMonCollector({
          binaryPath: stringOption(presentOptions, "binaryPath", "PresentMon.exe"),
          ...(processNames.length > 0 ? { processNames } : { processId: pid }),
          outputPath: resolve(runDirectory, "presentmon.csv"),
          durationSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
          metricsVersion: optionChoice(presentOptions, "metricsVersion", ["v1", "v2"] as const, "v2"),
        });
        presentMonPromise = capturePresentMon(collector);
      }
    },
    onProcessExited: async () => {
      if (processMonitor) processSamples = await processMonitor.stop();
      if (presentMonPromise) presentMonResult = await presentMonPromise;
    },
  });
  const readyMs = unitySpawnToReadyMs(raw);
  const measurementOffsetMs = readyMs + raw.probe.warmupMs;
  const measurementStartedAtMs = targetLaunchStartedAtMs + measurementOffsetMs;
  const processMeasurementOffsetMs = processMonitor?.startedAtMonotonicMs === undefined
    ? measurementOffsetMs
    : Math.max(0, measurementStartedAtMs - processMonitor.startedAtMonotonicMs);
  const trimmedProcessSamples = processSamples
    .filter((sample) => sample.sampledAtMs >= processMeasurementOffsetMs && sample.sampledAtMs <= processMeasurementOffsetMs + raw.probe.measuredDurationMs)
    .map((sample) => ({ ...sample, sampledAtMs: sample.sampledAtMs - processMeasurementOffsetMs }));
  const collectors: CollectorResult[] = [raw.normalized];
  if (context.config.scenario === undefined) {
    raw.normalized.metrics["stability.scenario_completed"] = measurement(1, "boolean", 1, "runner-static-scenario", true, 1);
  }
  if (processEnabled) collectors.push(applyCollectorRequirement(
    processSamplesToCollector(trimmedProcessSamples, raw.probe.measuredDurationMs),
    context.config,
    "processTree",
  ));
  if (presentMonResult?.available) {
    const processIds = [...new Set(processSamples.flatMap((sample) => sample.processes.map((process) => process.pid)))];
    const ownedFrames = processIds.length === 0
      ? presentMonResult.frames
      : filterPresentMonFrames(presentMonResult.frames, processIds);
    const presentMonOffsetMs = Math.max(0, measurementStartedAtMs - presentMonResult.startedAtMonotonicMs);
    const trimmedFrames = trimPresentMonFrames(ownedFrames, presentMonOffsetMs, raw.probe.measuredDurationMs);
    presentMonResult = { ...presentMonResult, frames: trimmedFrames };
  }
  appendPresentMonCollector(collectors, presentMonResult, context, runDirectory);
  return {
    collectors,
    raw,
    startedAt: raw.startedAt,
    durationMs: raw.probe.measuredDurationMs,
    readyMs,
    exitCode: raw.exitCode ?? 1,
  };
}

function appendPresentMonCollector(
  collectors: CollectorResult[],
  result: PresentMonCaptureResult | undefined,
  context: TargetRunContext,
  runDirectory: string,
): void {
  const config = context.config.collectors?.presentmon;
  if (!config?.enabled) return;
  if (result?.available) {
    const normalized = presentMonFramesToCollector(result.frames, context.config.experiment.measureMs, context.config.experiment.frameBudgetMs);
    normalized.artifacts.push({ path: result.csvPath, mediaType: "text/csv", recordCount: result.frames.length, description: `PresentMon ${result.csvVersion} raw frames.` });
    if (config.required && normalized.metrics["frame.cadence.interval_ms.p95"]?.status !== "measured") {
      normalized.status = "failed";
      normalized.errors.push({
        code: "PRESENTMON_REQUIRED_NO_FRAMES",
        message: "Required PresentMon capture contained no usable frame cadence samples.",
        scope: context.runId,
      });
    }
    collectors.push(normalized);
    return;
  }
  const reason = result?.reason ?? `PresentMon did not return a capture in ${runDirectory}`;
  collectors.push({
    collector: "presentmon",
    status: config.required ? "failed" : "partial",
    samples: [],
    metrics: {
      "frame.cadence.interval_ms.p95": { status: "unavailable", unit: "ms", sampleCount: 0, source: "presentmon", comparable: false, reason },
    },
    artifacts: [],
    warnings: config.required ? [] : [{ code: "PRESENTMON_UNAVAILABLE", message: reason }],
    errors: config.required ? [{ code: "PRESENTMON_REQUIRED", message: reason }] : [],
  });
}

async function collectStaticArtifacts(context: TargetRunContext): Promise<CollectorResult | undefined> {
  const artifactPath = stringMetadata(context.target, "artifactPath");
  const threeunityPath = stringMetadata(context.target, "threeunityPath");
  if (!artifactPath && !threeunityPath) return undefined;
  const metrics: Record<string, MetricMeasurement> = {};
  const artifacts: ArtifactReference[] = [];
  if (artifactPath) {
    const inventory = await inventoryArtifact(artifactPath);
    const prefix = context.role === "before" ? "artifact.source" : "artifact.unity";
    metrics["artifact.package.total_bytes"] = measurement(inventory.totalBytes, "byte", inventory.fileCount, "artifact", true, 1);
    metrics["artifact.package.file_count"] = measurement(inventory.fileCount, "count", inventory.fileCount, "artifact", true, 1);
    metrics[`${prefix}.total_bytes`] = measurement(inventory.totalBytes, "byte", inventory.fileCount, "artifact", false, 1);
    metrics[`${prefix}.file_count`] = measurement(inventory.fileCount, "count", inventory.fileCount, "artifact", false, 1);
    artifacts.push({ path: inventory.path, mediaType: "application/octet-stream", recordCount: inventory.fileCount, description: "Measured build artifact." });
  }
  if (threeunityPath) {
    const inventory = await inventoryThreeUnity(threeunityPath);
    for (const [name, value] of Object.entries({
      node_count: inventory.nodes,
      mesh_count: inventory.meshes,
      material_count: inventory.materials,
      texture_count: inventory.textures,
      animation_count: inventory.animations,
      skin_count: inventory.skins,
      vertex_count: inventory.vertices,
      index_count: inventory.indices,
      triangle_count: inventory.triangles,
      morph_target_count: inventory.morphTargets,
      warning_count: inventory.warnings,
    })) metrics[`artifact.threeunity.${name}`] = measurement(value, "count", 1, "artifact", false, 1);
    artifacts.push({ path: inventory.path, mediaType: "application/json", description: "Converted .threeunity scene inventory." });
  }
  return { collector: "artifact", status: "completed", samples: [], metrics, artifacts, warnings: [], errors: [] };
}

function trimPresentMonFrames<T extends { timestampSeconds?: number }>(frames: readonly T[], offsetMs: number, durationMs: number): T[] {
  const timestamped = frames.filter((frame): frame is T & { timestampSeconds: number } => frame.timestampSeconds !== undefined);
  if (timestamped.length === 0) return [];
  return timestamped.filter((frame) => frame.timestampSeconds * 1000 >= offsetMs && frame.timestampSeconds * 1000 <= offsetMs + durationMs);
}

function unitySpawnToReadyMs(result: UnityCollectionResult): number {
  const processStarted = Date.parse(result.startedAt);
  const probeStarted = Date.parse(result.probe.startedAt);
  const bootstrapMs = Number.isFinite(processStarted) && Number.isFinite(probeStarted)
    ? Math.max(0, probeStarted - processStarted)
    : 0;
  return bootstrapMs + result.probe.readyWaitMs;
}

async function waitForWebServer(target: TargetConfig): Promise<void> {
  if (target.ready?.type === "delay") {
    await delay(target.ready.delayMs);
    return;
  }
  const url = target.ready?.type === "http" ? target.ready.url ?? target.url! : target.url!;
  const timeout = target.ready?.type === "http" ? target.ready.timeoutMs ?? 30_000 : 30_000;
  await waitForHttp(url, timeout);
}

function webReadyOptions(target: TargetConfig): { expression?: string; delayMs?: number; timeoutMs?: number } | undefined {
  if (target.ready?.type === "web-expression") return {
    expression: target.ready.expression,
    ...(target.ready.timeoutMs === undefined ? {} : { timeoutMs: target.ready.timeoutMs }),
  };
  if (!target.launch && target.ready?.type === "delay") return { delayMs: target.ready.delayMs };
  return undefined;
}

function webBrowserOptions(config: BenchmarkConfig): WebBrowserConfig {
  const options = collectorOptions(config, "web");
  return {
    headless: booleanOption(options, "headless", false),
    deviceScaleFactor: numberOption(options, "deviceScaleFactor", 1),
    ...(typeof options.channel === "string" ? { channel: options.channel } : {}),
    ...(typeof options.executablePath === "string" ? { executablePath: options.executablePath } : {}),
    ...(Array.isArray(options.args) ? { args: options.args.filter((entry): entry is string => typeof entry === "string") } : {}),
  };
}

function mergeMetrics(collectors: readonly CollectorResult[]): Record<string, MetricMeasurement> {
  const merged: Record<string, MetricMeasurement> = {};
  for (const collector of collectors) Object.assign(merged, collector.metrics);
  return merged;
}

function mergeArtifacts(collectors: readonly CollectorResult[], extra: ArtifactReference[]): ArtifactReference[] {
  return [...collectors.flatMap((collector) => collector.artifacts), ...extra];
}

function collectorEnabled(config: BenchmarkConfig, name: string, defaultValue: boolean): boolean {
  const collector = config.collectors?.[name];
  return collector?.enabled ?? defaultValue;
}

function collectorInterval(config: BenchmarkConfig, name: string, fallback: number): number {
  return config.collectors?.[name]?.intervalMs ?? fallback;
}

function collectorOptions(config: BenchmarkConfig, name: string): Record<string, unknown> {
  return config.collectors?.[name]?.options ?? {};
}

function applyCollectorRequirement(result: CollectorResult, config: BenchmarkConfig, name: string): CollectorResult {
  if (!config.collectors?.[name]?.required || result.status === "completed") return result;
  return {
    ...result,
    status: "failed",
    errors: [
      ...result.errors,
      {
        code: "REQUIRED_COLLECTOR_INCOMPLETE",
        message: `Required collector '${name}' did not complete.`,
        scope: name,
      },
    ],
  };
}

function stringOption(options: Record<string, unknown>, name: string, fallback: string): string {
  return typeof options[name] === "string" ? options[name] : fallback;
}

function stringArrayOption(options: Record<string, unknown>, name: string): string[] {
  const value = options[name];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function numberOption(options: Record<string, unknown>, name: string, fallback: number): number {
  return typeof options[name] === "number" && Number.isFinite(options[name]) ? options[name] : fallback;
}

function booleanOption(options: Record<string, unknown>, name: string, fallback: boolean): boolean {
  return typeof options[name] === "boolean" ? options[name] : fallback;
}

function optionChoice<T extends string>(options: Record<string, unknown>, name: string, choices: readonly T[], fallback: T): T {
  const value = options[name];
  return typeof value === "string" && choices.includes(value as T) ? value as T : fallback;
}

function stringMetadata(target: TargetConfig, name: string): string | undefined {
  const value = target.metadata?.[name];
  return typeof value === "string" ? value : undefined;
}

function measurement(value: number, unit: string, sampleCount: number, source: string, comparable: boolean, coverageRatio: number): MetricMeasurement {
  return { status: "measured", value, unit, sampleCount, source, comparable, coverageRatio };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function capturePresentMon(collector: PresentMonCollector): Promise<PresentMonCaptureResult> {
  try {
    return await collector.capture();
  } catch (error) {
    return {
      available: false,
      reason: `PresentMon capture failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function safeStem(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "benchmark";
}

function compactTimestamp(iso: string): string {
  return iso.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
