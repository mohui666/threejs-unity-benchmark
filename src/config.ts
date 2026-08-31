import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  SCHEMA_VERSION,
  type BenchmarkConfig,
  type JsonObject,
  type ReadyCondition,
  type TargetConfig,
  type TargetRole,
} from "./types.js";

export interface PlannedRun {
  pairIndex: number;
  order: number;
  role: TargetRole;
  targetId: string;
  runtime: "web" | "unity";
  variant: TargetConfig["variant"];
}

export async function loadConfig(configPath: string): Promise<BenchmarkConfig> {
  const absolutePath = resolve(configPath);
  const raw = await readFile(absolutePath, "utf8");
  const parsed = extname(absolutePath).toLowerCase() === ".json"
    ? JSON.parse(raw) as unknown
    : parseYaml(raw) as unknown;
  const config = validateConfig(parsed);
  return resolveConfigPaths(config, dirname(absolutePath));
}

export function validateConfig(input: unknown): BenchmarkConfig {
  const value = objectAt(input, "config");
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`config.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  const experiment = objectAt(value.experiment, "config.experiment");
  const viewport = objectAt(experiment.viewport, "config.experiment.viewport");
  const targets = objectAt(value.targets, "config.targets");
  const before = validateTarget(targets.before, "before");
  const after = validateTarget(targets.after, "after");
  if (before.id === after.id) throw new Error("before and after target ids must differ");

  const config: BenchmarkConfig = {
    schemaVersion: SCHEMA_VERSION,
    experiment: {
      name: stringAt(experiment.name, "config.experiment.name"),
      seed: wholeAt(experiment.seed, "config.experiment.seed"),
      viewport: {
        width: integerAt(viewport.width, "config.experiment.viewport.width", 1),
        height: integerAt(viewport.height, "config.experiment.viewport.height", 1),
      },
      frameBudgetMs: positiveAt(experiment.frameBudgetMs, "config.experiment.frameBudgetMs"),
      warmupMs: integerAt(experiment.warmupMs, "config.experiment.warmupMs", 0),
      measureMs: integerAt(experiment.measureMs, "config.experiment.measureMs", 1),
      repetitions: integerAt(experiment.repetitions, "config.experiment.repetitions", 1),
      runOrder: runOrderAt(experiment.runOrder),
    },
    targets: { before, after },
  };

  if (experiment.betweenRunsMs !== undefined) {
    config.experiment.betweenRunsMs = integerAt(experiment.betweenRunsMs, "config.experiment.betweenRunsMs", 0);
  }
  if (value.scenario !== undefined) {
    const scenario = objectAt(value.scenario, "config.scenario");
    config.scenario = { adapter: stringAt(scenario.adapter, "config.scenario.adapter") };
    if (scenario.exportName !== undefined) config.scenario.exportName = stringAt(scenario.exportName, "config.scenario.exportName");
    if (scenario.parameters !== undefined) config.scenario.parameters = objectAt(scenario.parameters, "config.scenario.parameters") as JsonObject;
  }
  if (value.collectors !== undefined) {
    const collectors = objectAt(value.collectors, "config.collectors");
    config.collectors = Object.fromEntries(Object.entries(collectors).map(([name, rawCollector]) => {
      const collector = objectAt(rawCollector, `config.collectors.${name}`);
      return [name, {
        ...(collector.enabled === undefined ? {} : { enabled: booleanAt(collector.enabled, `config.collectors.${name}.enabled`) }),
        ...(collector.required === undefined ? {} : { required: booleanAt(collector.required, `config.collectors.${name}.required`) }),
        ...(collector.intervalMs === undefined ? {} : { intervalMs: integerAt(collector.intervalMs, `config.collectors.${name}.intervalMs`, 1) }),
        ...(collector.options === undefined ? {} : { options: objectAt(collector.options, `config.collectors.${name}.options`) as JsonObject }),
      }];
    }));
  }
  if (value.gates !== undefined) {
    if (!Array.isArray(value.gates)) throw new Error("config.gates must be an array");
    config.gates = value.gates.map((rawGate, index) => {
      const gate = objectAt(rawGate, `config.gates[${index}]`);
      return {
        metric: stringAt(gate.metric, `config.gates[${index}].metric`),
        ...(gate.required === undefined ? {} : { required: booleanAt(gate.required, `config.gates[${index}].required`) }),
        ...(gate.maxRegressionPercent === undefined ? {} : { maxRegressionPercent: finiteAt(gate.maxRegressionPercent, `config.gates[${index}].maxRegressionPercent`) }),
        ...(gate.minImprovementPercent === undefined ? {} : { minImprovementPercent: finiteAt(gate.minImprovementPercent, `config.gates[${index}].minImprovementPercent`) }),
        ...(gate.maxAbsolute === undefined ? {} : { maxAbsolute: finiteAt(gate.maxAbsolute, `config.gates[${index}].maxAbsolute`) }),
        ...(gate.minAbsolute === undefined ? {} : { minAbsolute: finiteAt(gate.minAbsolute, `config.gates[${index}].minAbsolute`) }),
        ...(gate.minSampleCount === undefined ? {} : { minSampleCount: integerAt(gate.minSampleCount, `config.gates[${index}].minSampleCount`, 1) }),
        ...(gate.minCoverageRatio === undefined ? {} : { minCoverageRatio: ratioAt(gate.minCoverageRatio, `config.gates[${index}].minCoverageRatio`) }),
      };
    });
  }
  if (value.outputDirectory !== undefined) config.outputDirectory = stringAt(value.outputDirectory, "config.outputDirectory");
  return config;
}

export function planRuns(config: BenchmarkConfig): PlannedRun[] {
  const runs: PlannedRun[] = [];
  let order = 0;
  for (let pairIndex = 0; pairIndex < config.experiment.repetitions; pairIndex += 1) {
    const roles = orderForPair(config.experiment.runOrder, pairIndex, config.experiment.seed);
    for (const role of roles) {
      const target = config.targets[role];
      runs.push({ pairIndex, order, role, targetId: target.id, runtime: target.runtime, variant: target.variant });
      order += 1;
    }
  }
  return runs;
}

export async function writeStarterConfig(outputPath: string): Promise<void> {
  const absolutePath = resolve(outputPath);
  try {
    await access(absolutePath);
    throw new Error(`Refusing to overwrite existing config: ${absolutePath}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
  }
  const starter = starterConfig();
  await writeFile(absolutePath, `${JSON.stringify(starter, null, 2)}\n`, "utf8");
}

export function starterConfig(): BenchmarkConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    experiment: {
      name: "threejs-to-unity",
      seed: 42,
      viewport: { width: 1280, height: 720 },
      frameBudgetMs: 16.6667,
      warmupMs: 15_000,
      measureMs: 60_000,
      repetitions: 5,
      runOrder: "alternating",
      betweenRunsMs: 5_000,
    },
    targets: {
      before: {
        id: "threejs-original",
        label: "Original Three.js",
        runtime: "web",
        variant: "threejs-original",
        url: "http://127.0.0.1:4173",
        launch: {
          command: "node",
          args: ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", "4173"],
          cwd: "./before",
        },
        ready: { type: "http" },
      },
      after: {
        id: "unity-native",
        label: "Converted Unity Player",
        runtime: "unity",
        variant: "unity-native-assets",
        executable: "./after/Build/Game.exe",
        args: ["-screen-width", "1280", "-screen-height", "720", "-screen-fullscreen", "0"],
      },
    },
    scenario: {
      adapter: "./scenarios/benchmark.mjs",
      parameters: {},
    },
    collectors: {
      processTree: { enabled: true, required: true, intervalMs: 500 },
      presentmon: { enabled: true, required: true, options: { binaryPath: "./tools/PresentMon.exe" } },
      web: { enabled: true, required: false, options: { headless: false } },
      unity: { enabled: true, required: false },
      bridgeLog: { enabled: true, required: false },
    },
    gates: [
      { metric: "frame.cadence.interval_ms.p95", maxRegressionPercent: 5, required: true },
      { metric: "frame.cadence.fps_1pct_low", maxRegressionPercent: 5, required: true },
      { metric: "cpu.process_tree.core_percent.mean", maxRegressionPercent: 10, required: true },
      { metric: "memory.process_tree.working_set_bytes.peak", maxRegressionPercent: 10, required: true },
      { metric: "stability.crash_count", maxAbsolute: 0, required: true },
      { metric: "stability.scenario_completed", minAbsolute: 1, required: true },
    ],
    outputDirectory: ".bench-results",
  };
}

function validateTarget(input: unknown, role: TargetRole): TargetConfig {
  const value = objectAt(input, `config.targets.${role}`);
  const runtime = value.runtime;
  if (runtime !== "web" && runtime !== "unity") throw new Error(`config.targets.${role}.runtime must be web or unity`);
  const variant = value.variant;
  if (variant !== "threejs-original" && variant !== "unity-web-bridge" && variant !== "unity-native-assets" && variant !== "custom") {
    throw new Error(`config.targets.${role}.variant is invalid`);
  }
  if (runtime === "web" && typeof value.url !== "string") throw new Error(`config.targets.${role}.url is required for web targets`);
  if (runtime === "unity" && typeof value.executable !== "string" && value.launch === undefined) {
    throw new Error(`config.targets.${role} requires executable or launch for unity targets`);
  }
  const target: TargetConfig = {
    id: stringAt(value.id, `config.targets.${role}.id`),
    runtime,
    variant,
  };
  if (value.label !== undefined) target.label = stringAt(value.label, `config.targets.${role}.label`);
  if (value.url !== undefined) target.url = stringAt(value.url, `config.targets.${role}.url`);
  if (value.executable !== undefined) target.executable = stringAt(value.executable, `config.targets.${role}.executable`);
  if (value.args !== undefined) target.args = stringArrayAt(value.args, `config.targets.${role}.args`);
  if (value.cwd !== undefined) target.cwd = stringAt(value.cwd, `config.targets.${role}.cwd`);
  if (value.env !== undefined) target.env = stringRecordAt(value.env, `config.targets.${role}.env`);
  if (value.metadata !== undefined) target.metadata = objectAt(value.metadata, `config.targets.${role}.metadata`) as JsonObject;
  if (value.launch !== undefined) {
    const launch = objectAt(value.launch, `config.targets.${role}.launch`);
    target.launch = { command: stringAt(launch.command, `config.targets.${role}.launch.command`) };
    if (launch.args !== undefined) target.launch.args = stringArrayAt(launch.args, `config.targets.${role}.launch.args`);
    if (launch.cwd !== undefined) target.launch.cwd = stringAt(launch.cwd, `config.targets.${role}.launch.cwd`);
    if (launch.env !== undefined) target.launch.env = stringRecordAt(launch.env, `config.targets.${role}.launch.env`);
  }
  if (value.ready !== undefined) target.ready = readyAt(value.ready, `config.targets.${role}.ready`);
  return target;
}

function resolveConfigPaths(config: BenchmarkConfig, baseDirectory: string): BenchmarkConfig {
  const pathOf = (path: string): string => isAbsolute(path) ? path : resolve(baseDirectory, path);
  for (const target of Object.values(config.targets)) {
    if (target.executable) target.executable = pathOf(target.executable);
    if (target.cwd) target.cwd = pathOf(target.cwd);
    if (target.launch?.cwd) target.launch.cwd = pathOf(target.launch.cwd);
    if (typeof target.metadata?.artifactPath === "string") target.metadata.artifactPath = pathOf(target.metadata.artifactPath);
    if (typeof target.metadata?.threeunityPath === "string") target.metadata.threeunityPath = pathOf(target.metadata.threeunityPath);
  }
  if (config.scenario) config.scenario.adapter = pathOf(config.scenario.adapter);
  if (config.outputDirectory) config.outputDirectory = pathOf(config.outputDirectory);
  const presentMonBinary = config.collectors?.presentmon?.options?.binaryPath;
  if (typeof presentMonBinary === "string") config.collectors!.presentmon!.options!.binaryPath = pathOf(presentMonBinary);
  return config;
}

function orderForPair(order: BenchmarkConfig["experiment"]["runOrder"], pairIndex: number, seed: number): TargetRole[] {
  if (order === "before-first") return ["before", "after"];
  if (order === "after-first") return ["after", "before"];
  if (order === "alternating") return pairIndex % 2 === 0 ? ["before", "after"] : ["after", "before"];
  return seededBit(seed, pairIndex) === 0 ? ["before", "after"] : ["after", "before"];
}

function seededBit(seed: number, index: number): number {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value & 1;
}

function readyAt(input: unknown, path: string): ReadyCondition {
  const value = objectAt(input, path);
  if (value.type === "delay") return { type: "delay", delayMs: integerAt(value.delayMs, `${path}.delayMs`, 0) };
  if (value.type === "http") return {
    type: "http",
    ...(value.url === undefined ? {} : { url: stringAt(value.url, `${path}.url`) }),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: integerAt(value.timeoutMs, `${path}.timeoutMs`, 1) }),
  };
  if (value.type === "log") return {
    type: "log",
    pattern: stringAt(value.pattern, `${path}.pattern`),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: integerAt(value.timeoutMs, `${path}.timeoutMs`, 1) }),
  };
  if (value.type === "web-expression") return {
    type: "web-expression",
    expression: stringAt(value.expression, `${path}.expression`),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: integerAt(value.timeoutMs, `${path}.timeoutMs`, 1) }),
  };
  throw new Error(`${path}.type is invalid`);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function finiteAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function wholeAt(value: unknown, path: string): number {
  const number = finiteAt(value, path);
  if (!Number.isInteger(number)) throw new Error(`${path} must be an integer`);
  return number;
}

function positiveAt(value: unknown, path: string): number {
  const number = finiteAt(value, path);
  if (number <= 0) throw new Error(`${path} must be greater than zero`);
  return number;
}

function integerAt(value: unknown, path: string, minimum: number): number {
  const number = finiteAt(value, path);
  if (!Number.isInteger(number) || number < minimum) throw new Error(`${path} must be an integer >= ${minimum}`);
  return number;
}

function ratioAt(value: unknown, path: string): number {
  const number = finiteAt(value, path);
  if (number < 0 || number > 1) throw new Error(`${path} must be between 0 and 1`);
  return number;
}

function stringArrayAt(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${path} must be an array of strings`);
  return value;
}

function stringRecordAt(value: unknown, path: string): Record<string, string> {
  const record = objectAt(value, path);
  for (const [key, entry] of Object.entries(record)) if (typeof entry !== "string") throw new Error(`${path}.${key} must be a string`);
  return record as Record<string, string>;
}

function runOrderAt(value: unknown): BenchmarkConfig["experiment"]["runOrder"] {
  if (value === "alternating" || value === "before-first" || value === "after-first" || value === "randomized") return value;
  throw new Error("config.experiment.runOrder is invalid");
}
