#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareRuns } from "./analytics/compare.js";
import { loadConfig, planRuns, writeStarterConfig } from "./config.js";
import { doctorConfig } from "./doctor.js";
import { listMetricDefinitions } from "./metrics.js";
import { renderHtmlReport, renderMarkdownReport, type BenchmarkReportInput } from "./report/index.js";
import { runBenchmark, type BenchmarkProgressEvent, type BenchmarkSuiteResult } from "./runner.js";
import { SCHEMA_VERSION, type ComparisonResult, type ExperimentConfig, type MetricGate, type RunResult } from "./types.js";

type CliStatus = "pass" | "regression" | "inconclusive" | "error";

interface CliEnvelope {
  schemaVersion: typeof SCHEMA_VERSION;
  command: string;
  ok: boolean;
  status: CliStatus;
  data: unknown;
  artifacts: string[];
  warnings: string[];
  errors: string[];
}

interface CliState {
  envelope?: CliEnvelope;
  exitCode: number;
}

const argv = process.argv.slice(2);
const jsonMode = argv.includes("--json");
const jsonlMode = argv.includes("--jsonl");
const quietMode = argv.includes("--quiet");
const state: CliState = { exitCode: 0 };
const program = new Command();

program
  .name("three-unity-perf")
  .description("Benchmark original Three.js applications against Unity conversions")
  .version("0.1.0")
  .option("--json", "emit exactly one machine-readable JSON result")
  .option("--jsonl", "emit progress events and the final result as JSON Lines")
  .option("--quiet", "suppress progress output")
  .option("--no-color", "disable colored output")
  .exitOverride();

program.command("init")
  .description("write a starter benchmark config and scenario adapter")
  .requiredOption("--out <path>", "output config path")
  .action(async (options: { out: string }) => {
    const path = resolve(options.out);
    await mkdir(dirname(path), { recursive: true });
    await writeStarterConfig(path);
    const scenarioPath = resolve(dirname(path), "scenarios", "benchmark.mjs");
    await mkdir(dirname(scenarioPath), { recursive: true });
    await writeNewFile(scenarioPath, starterScenario());
    finish("init", "pass", { configPath: path, scenarioPath }, [path, scenarioPath]);
  });

program.command("doctor")
  .description("check only the collectors and targets required by a config")
  .requiredOption("-c, --config <path>", "benchmark config")
  .action(async (options: { config: string }) => {
    const config = await loadConfig(options.config);
    const result = await doctorConfig(config);
    finish("doctor", result.ok ? "pass" : "error", result, [], result.checks.filter((check) => check.status === "optional-unavailable").map((check) => `${check.id}: ${check.message}`), result.checks.filter((check) => check.status === "fail").map((check) => `${check.id}: ${check.message}`));
    state.exitCode = result.ok ? 0 : 4;
  });

program.command("plan")
  .description("resolve a config and print the exact paired run order without launching targets")
  .requiredOption("-c, --config <path>", "benchmark config")
  .action(async (options: { config: string }) => {
    const config = await loadConfig(options.config);
    finish("plan", "pass", { config, runs: planRuns(config) });
  });

program.command("run")
  .description("collect before/after runs, compare them, and generate reports")
  .requiredOption("-c, --config <path>", "benchmark config")
  .option("-o, --out <directory>", "exact output directory")
  .option("--dry-run", "print the resolved run plan without launching targets")
  .action(async (options: { config: string; out?: string; dryRun?: boolean }) => {
    const config = await loadConfig(options.config);
    if (options.dryRun) {
      finish("run", "pass", { dryRun: true, config, runs: planRuns(config) });
      return;
    }
    const suite = await runBenchmark(config, {
      ...(options.out === undefined ? {} : { outputDirectory: options.out }),
      onProgress: progress,
    });
    const runErrors = suite.runs.flatMap((run) => run.errors.map((error) => ({
      code: error.code,
      message: `${run.runId}/${error.code}: ${error.message}`,
    })));
    const status = runErrors.length > 0 ? "error" : comparisonStatus(suite.comparison);
    finish("run", status, {
      suiteId: suite.suiteId,
      outputDirectory: suite.outputDirectory,
      verdict: suite.comparison.verdict,
      pairCount: suite.comparison.pairCount,
      runs: suite.runs.length,
      comparison: suite.comparison,
    }, suite.artifacts.map((artifact) => artifact.path), suite.comparison.warnings.map((warning) => `${warning.code}: ${warning.message}`), suite.comparison.errors.map((error) => `${error.scope ?? "comparison"}/${error.code}: ${error.message}`));
    state.exitCode = runErrors.some((error) => error.code === "UNITY_NONZERO_EXIT")
      ? 5
      : runErrors.length > 0
        ? 6
        : comparisonExitCode(suite.comparison);
  });

program.command("compare")
  .description("compare normalized before and after run files")
  .argument("<before>", "before run, run array, or suite JSON")
  .argument("<after>", "after run, run array, or suite JSON")
  .option("--rules <path>", "JSON file containing a gate array or { gates: [] }")
  .option("-o, --out <path>", "write comparison JSON")
  .option("--seed <number>", "bootstrap seed", "42")
  .action(async (beforePath: string, afterPath: string, options: { rules?: string; out?: string; seed: string }) => {
    const beforeRuns = await loadRuns(beforePath);
    const afterRuns = await loadRuns(afterPath);
    const gates = options.rules ? await loadGates(options.rules) : [];
    const comparison = compareRuns(beforeRuns, afterRuns, { gates, seed: Number(options.seed) });
    const artifacts: string[] = [];
    if (options.out) {
      const path = resolve(options.out);
      await writeJson(path, comparison);
      artifacts.push(path);
    }
    finish("compare", comparisonStatus(comparison), comparison, artifacts, comparison.warnings.map((warning) => warning.message), comparison.errors.map((error) => error.message));
    state.exitCode = comparisonExitCode(comparison);
  });

program.command("report")
  .description("render a suite or comparison JSON as Markdown or self-contained HTML")
  .argument("<input>", "suite.json or comparison.json")
  .requiredOption("--format <format>", "markdown, html, or json")
  .requiredOption("-o, --out <path>", "output report path")
  .action(async (inputPath: string, options: { format: string; out: string }) => {
    const loaded = await readJson(inputPath) as unknown;
    const report = reportInputFromDocument(loaded);
    const outputPath = resolve(options.out);
    if (options.format === "markdown") await writeFile(outputPath, renderMarkdownReport(report), "utf8");
    else if (options.format === "html") await writeFile(outputPath, renderHtmlReport(report), "utf8");
    else if (options.format === "json") await writeJson(outputPath, report.comparison);
    else throw new Error("report --format must be markdown, html, or json");
    finish("report", comparisonStatus(report.comparison), { outputPath, verdict: report.comparison.verdict }, [outputPath]);
    state.exitCode = comparisonExitCode(report.comparison);
  });

program.command("metrics")
  .description("list canonical metrics, units, directions, categories, and collector priority")
  .option("--priority <priority>", "P0, P1, or P2")
  .action((options: { priority?: "P0" | "P1" | "P2" }) => {
    finish("metrics", "pass", { metrics: listMetricDefinitions(options.priority) });
  });

program.command("schema")
  .description("return a machine-readable JSON Schema")
  .argument("<name>", "config, run, comparison, or cli-result")
  .action(async (name: string) => {
    const allowed = new Set(["config", "run", "comparison", "cli-result"]);
    if (!allowed.has(name)) throw new Error("schema name must be config, run, comparison, or cli-result");
    const path = schemaPath(name);
    finish("schema", "pass", { name, schema: await readJson(path) }, [path]);
  });

program.command("capabilities")
  .description("describe collector capabilities and comparability boundaries")
  .action(() => {
    finish("capabilities", "pass", {
      platform: process.platform,
      collectors: [
        { id: "web", availability: "built-in", metrics: ["rAF cadence", "Long Tasks", "CDP CPU/heap/DOM", "navigation/resources", "custom Three.js renderer.info"], comparableAcrossRuntimes: false },
        { id: "unity", availability: "install unity-package in Player project", metrics: ["ProfilerRecorder", "FrameTimingManager", "GC/memory", "render counters", "bridge log"], comparableAcrossRuntimes: false },
        { id: "processTree", availability: "built-in", metrics: ["CPU", "working set", "virtual memory", "process count"], comparableAcrossRuntimes: true },
        { id: "presentmon", availability: "optional Windows binary", metrics: ["present cadence", "GPU frame time", "display latency", "dropped frames"], comparableAcrossRuntimes: true },
      ],
    });
  });

program.configureOutput({
  writeErr: (text) => process.stderr.write(text),
  writeOut: (text) => process.stdout.write(text),
});

try {
  if (jsonMode && jsonlMode) throw new Error("--json and --jsonl are mutually exclusive");
  await program.parseAsync(process.argv);
  if (state.envelope) emitEnvelope(state.envelope);
} catch (error) {
  if (error instanceof CommanderError && (error.code === "commander.helpDisplayed" || error.code === "commander.version")) {
    process.exitCode = 0;
  } else {
    const command = commandName(argv);
    const message = error instanceof Error ? error.message : String(error);
    const exitCode = command === "run" ? 5 : 3;
    const envelope = makeEnvelope(command, "error", {}, [], [], [message]);
    state.exitCode = exitCode;
    emitEnvelope(envelope);
  }
}
process.exitCode = state.exitCode;

function finish(command: string, status: CliStatus, data: unknown, artifacts: string[] = [], warnings: string[] = [], errors: string[] = []): void {
  state.envelope = makeEnvelope(command, status, data, artifacts, warnings, errors);
}

function makeEnvelope(command: string, status: CliStatus, data: unknown, artifacts: string[], warnings: string[], errors: string[]): CliEnvelope {
  return { schemaVersion: SCHEMA_VERSION, command, ok: status === "pass", status, data, artifacts, warnings, errors };
}

function emitEnvelope(envelope: CliEnvelope): void {
  if (jsonMode || jsonlMode) {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }
  if (envelope.status === "error") process.stderr.write(`${envelope.command}: ${envelope.errors.join("; ")}\n`);
  else process.stdout.write(`${envelope.command}: ${envelope.status}${envelope.artifacts.length > 0 ? `\n${envelope.artifacts.join("\n")}` : ""}\n`);
}

function progress(event: BenchmarkProgressEvent): void {
  if (quietMode) return;
  if (jsonlMode) process.stdout.write(`${JSON.stringify({ schemaVersion: SCHEMA_VERSION, event: "progress", ...event })}\n`);
  else process.stderr.write(`[${event.phase}] ${event.message}\n`);
}

function comparisonStatus(comparison: ComparisonResult): CliStatus {
  return comparison.verdict === "pass" ? "pass" : comparison.verdict === "regression" ? "regression" : "inconclusive";
}

function comparisonExitCode(comparison: ComparisonResult): number {
  return comparison.verdict === "pass" ? 0 : comparison.verdict === "regression" ? 1 : 2;
}

async function loadRuns(path: string): Promise<RunResult[]> {
  const document = await readJson(path) as unknown;
  if (Array.isArray(document)) return document as RunResult[];
  if (isRecord(document) && Array.isArray(document.runs)) return document.runs as RunResult[];
  if (isRecord(document) && typeof document.runId === "string" && isRecord(document.metrics)) return [document as unknown as RunResult];
  throw new Error(`${path} does not contain a run, run array, or suite`);
}

async function loadGates(path: string): Promise<MetricGate[]> {
  const document = await readJson(path) as unknown;
  if (Array.isArray(document)) return document as MetricGate[];
  if (isRecord(document) && Array.isArray(document.gates)) return document.gates as MetricGate[];
  throw new Error(`${path} must contain a gate array or { gates: [] }`);
}

function reportInputFromDocument(document: unknown): BenchmarkReportInput {
  if (isRecord(document) && isRecord(document.comparison) && Array.isArray(document.runs) && isRecord(document.experiment)) {
    const suite = document as unknown as BenchmarkSuiteResult;
    return { title: suite.experiment.name, comparison: suite.comparison, runs: suite.runs, experiment: suite.experiment, environment: suite.environment };
  }
  if (isRecord(document) && typeof document.comparisonId === "string" && isRecord(document.metrics)) {
    const comparison = document as unknown as ComparisonResult;
    return { title: comparison.comparisonId, comparison, runs: [], experiment: fallbackExperiment(comparison.comparisonId) };
  }
  throw new Error("report input must be a suite or comparison document");
}

function fallbackExperiment(name: string): ExperimentConfig {
  return { name, seed: 0, viewport: { width: 0, height: 0 }, frameBudgetMs: 0, warmupMs: 0, measureMs: 0, repetitions: 0, runOrder: "before-first" };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeNewFile(path: string, contents: string): Promise<void> {
  try {
    await access(path);
    throw new Error(`Refusing to overwrite existing file: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
  }
  await writeFile(path, contents, "utf8");
}

function schemaPath(name: string): string {
  return fileURLToPath(new URL(`../schemas/${name}.schema.json`, import.meta.url));
}

function commandName(arguments_: string[]): string {
  return arguments_.find((argument) => !argument.startsWith("-")) ?? "cli";
}

function starterScenario(): string {
  return `/** Deterministic workload adapter used by the original Three.js target. */
export async function prepare({ page }) {
  // Replace this with the real game-ready condition.
  await page.waitForLoadState("load");
}

export async function run({ page, durationMs, seed, signal }) {
  // Drive the same camera/input/workload implemented by the Unity benchmark scene.
  // Keep all randomness derived from seed. Set this only after the workload finishes:
  // await page.evaluate(() => globalThis.__THREE_UNITY_PERF__.checkpoint("scenario-complete", true));
  throw new Error("Implement scenarios/benchmark.mjs before running the benchmark");
}

export async function validate({ page }) {
  return await page.evaluate(() => ({
    completed: false,
    reason: "Replace with an assertion over the game's final state"
  }));
}
`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
