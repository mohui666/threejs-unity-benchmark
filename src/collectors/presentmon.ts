import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

export type PresentMonCsvVersion = "v1" | "v2" | "unknown";

export interface PresentMonFrameSample {
  sourceVersion: PresentMonCsvVersion;
  application?: string;
  processId?: number;
  swapChainAddress?: string;
  presentRuntime?: string;
  presentMode?: string;
  frameType?: string;
  timestampSeconds?: number;
  frameTimeMs?: number;
  cpuBusyMs?: number;
  cpuWaitMs?: number;
  gpuLatencyMs?: number;
  gpuTimeMs?: number;
  gpuBusyMs?: number;
  gpuWaitMs?: number;
  displayLatencyMs?: number;
  displayedTimeMs?: number;
  presentApiMs?: number;
  renderPresentLatencyMs?: number;
  gpuStartLatencyMs?: number;
  flipDelayMs?: number;
  animationErrorMs?: number;
  allInputToPhotonLatencyMs?: number;
  clickToPhotonLatencyMs?: number;
  sinceInputMs?: number;
  dropped?: boolean;
  allowsTearing?: boolean;
}

export interface ParsedPresentMonCsv {
  version: PresentMonCsvVersion;
  frames: PresentMonFrameSample[];
}

export interface PresentMonCollectorOptions {
  binaryPath: string;
  processId?: number;
  processNames?: string[];
  includedProcessIds?: number[];
  outputPath: string;
  durationSeconds: number;
  metricsVersion?: "v1" | "v2";
}

export type PresentMonAvailability =
  | { available: true }
  | { available: false; reason: string };

export type PresentMonCaptureResult =
  | { available: false; reason: string }
  | {
    available: true;
    csvPath: string;
    csvVersion: PresentMonCsvVersion;
    startedAtMonotonicMs: number;
    frames: PresentMonFrameSample[];
  };

/**
 * Optional Windows collector backed by a caller-supplied PresentMon binary.
 * It never downloads or searches for an executable, and an unavailable adapter
 * returns an explicit result instead of synthetic frame metrics.
 */
export class PresentMonCollector {
  private readonly options: PresentMonCollectorOptions;

  constructor(options: PresentMonCollectorOptions) {
    if (options.binaryPath.trim().length === 0) {
      throw new Error("PresentMon binaryPath is required.");
    }
    validateCaptureTargets(options);
    if (!Number.isInteger(options.durationSeconds) || options.durationSeconds <= 0) {
      throw new Error("PresentMon durationSeconds must be a positive integer.");
    }
    if (options.outputPath.trim().length === 0) {
      throw new Error("PresentMon outputPath is required.");
    }
    this.options = options;
  }

  async availability(): Promise<PresentMonAvailability> {
    if (process.platform !== "win32") {
      return { available: false, reason: "PresentMon is available only on Windows." };
    }
    try {
      await access(this.options.binaryPath, constants.F_OK);
      return { available: true };
    } catch {
      return {
        available: false,
        reason: `PresentMon binary was not found at ${this.options.binaryPath}`,
      };
    }
  }

  async capture(): Promise<PresentMonCaptureResult> {
    const availability = await this.availability();
    if (!availability.available) return availability;

    await mkdir(dirname(this.options.outputPath), { recursive: true });
    await rm(this.options.outputPath, { force: true });
    const arguments_ = buildPresentMonArguments(this.options);
    const startedAtMonotonicMs = performance.now();
    await runPresentMon(this.options.binaryPath, arguments_);

    const parsed = parsePresentMonCsv(await readFile(this.options.outputPath, "utf8"));
    const frames = filterPresentMonFrames(parsed.frames, this.options.includedProcessIds);
    return {
      available: true,
      csvPath: this.options.outputPath,
      csvVersion: parsed.version,
      startedAtMonotonicMs,
      frames,
    };
  }
}

export function buildPresentMonArguments(options: PresentMonCollectorOptions): string[] {
  const captureTargets = presentMonCaptureTargetArguments(options);
  return [
    ...captureTargets,
    "--output_file",
    options.outputPath,
    "--timed",
    String(options.durationSeconds),
    "--terminate_after_timed",
    "--terminate_on_proc_exit",
    "--no_console_stats",
    options.metricsVersion === "v1" ? "--v1_metrics" : "--v2_metrics",
  ];
}

export function filterPresentMonFrames(
  frames: readonly PresentMonFrameSample[],
  includedProcessIds: readonly number[] | undefined,
): PresentMonFrameSample[] {
  if (includedProcessIds === undefined) return frames.slice();
  const included = new Set(includedProcessIds);
  return frames.filter((frame) => frame.processId !== undefined && included.has(frame.processId));
}

export function parsePresentMonCsv(csv: string): ParsedPresentMonCsv {
  const records = parseCsvRecords(csv);
  const header = records.shift();
  if (!header) return { version: "unknown", frames: [] };

  const columns = new Map<string, number>();
  header.forEach((name, index) => {
    columns.set(normalizeHeader(name), index);
  });

  const version = detectCsvVersion(columns);
  const frames = records
    .filter((record) => record.some((value) => value.trim().length > 0))
    .map((record) => parseFrame(record, columns, version));
  return { version, frames };
}

function detectCsvVersion(columns: ReadonlyMap<string, number>): PresentMonCsvVersion {
  if (
    columns.has("frametime")
    || columns.has("cpubusy")
    || columns.has("mscpubusy")
    || columns.has("cpustarttime")
    || columns.has("cpustartqpctime")
  ) {
    return "v2";
  }
  if (
    columns.has("msbetweenpresents")
    || columns.has("msinpresentapi")
    || columns.has("dropped")
  ) {
    return "v1";
  }
  return "unknown";
}

function validateCaptureTargets(options: PresentMonCollectorOptions): void {
  const hasProcessId = options.processId !== undefined;
  const hasProcessNames = (options.processNames?.length ?? 0) > 0;
  if (hasProcessId === hasProcessNames) {
    throw new Error("PresentMon requires exactly one of processId or processNames.");
  }
  if (hasProcessId && (!Number.isInteger(options.processId) || options.processId! <= 0)) {
    throw new Error("PresentMon processId must be a positive integer.");
  }
  for (const processName of options.processNames ?? []) {
    if (processName.trim().length === 0) {
      throw new Error("PresentMon processNames cannot contain an empty name.");
    }
  }
  for (const processId of options.includedProcessIds ?? []) {
    if (!Number.isInteger(processId) || processId <= 0) {
      throw new Error("PresentMon includedProcessIds must contain only positive integers.");
    }
  }
}

function presentMonCaptureTargetArguments(options: PresentMonCollectorOptions): string[] {
  validateCaptureTargets(options);
  if (options.processId !== undefined) return ["--process_id", String(options.processId)];
  return (options.processNames ?? []).flatMap((name) => ["--process_name", name]);
}

function parseFrame(
  record: readonly string[],
  columns: ReadonlyMap<string, number>,
  version: PresentMonCsvVersion,
): PresentMonFrameSample {
  const frame: PresentMonFrameSample = { sourceVersion: version };

  assignText(frame, "application", valueFor(record, columns, "Application"));
  assignInteger(frame, "processId", valueFor(record, columns, "ProcessID"));
  assignText(frame, "swapChainAddress", valueFor(record, columns, "SwapChainAddress"));
  assignText(frame, "presentRuntime", valueFor(record, columns, "PresentRuntime", "Runtime"));
  assignText(frame, "presentMode", valueFor(record, columns, "PresentMode"));
  assignText(frame, "frameType", valueFor(record, columns, "FrameType"));

  const timestampSeconds = numericValue(record, columns, "CPUStartTime", "TimeInSeconds");
  if (timestampSeconds !== undefined) frame.timestampSeconds = timestampSeconds;
  else {
    const timestampMs = numericValue(record, columns, "CPUStartQPCTime", "TimeInMs");
    if (timestampMs !== undefined) frame.timestampSeconds = timestampMs / 1000;
  }

  assignNumber(frame, "frameTimeMs", numericValue(record, columns, "FrameTime", "MsBetweenPresents"));
  assignNumber(frame, "cpuBusyMs", numericValue(record, columns, "CPUBusy", "MsCPUBusy"));
  assignNumber(frame, "cpuWaitMs", numericValue(record, columns, "CPUWait", "MsCPUWait"));
  assignNumber(frame, "gpuLatencyMs", numericValue(record, columns, "GPULatency", "MsGPULatency"));
  assignNumber(frame, "gpuTimeMs", numericValue(record, columns, "GPUTime", "MsGPUTime"));
  assignNumber(
    frame,
    "gpuBusyMs",
    numericValue(record, columns, "GPUBusy", "MsGPUBusy", "MsGPUActive"),
  );
  assignNumber(frame, "gpuWaitMs", numericValue(record, columns, "GPUWait", "MsGPUWait"));
  assignNumber(frame, "displayLatencyMs", numericValue(record, columns, "DisplayLatency", "MsUntilDisplayed"));
  assignNumber(frame, "displayedTimeMs", numericValue(record, columns, "DisplayedTime", "MsBetweenDisplayChange"));
  assignNumber(frame, "presentApiMs", numericValue(record, columns, "MsInPresentAPI"));
  assignNumber(
    frame,
    "renderPresentLatencyMs",
    numericValue(record, columns, "MsRenderPresentLatency", "MsUntilRenderComplete"),
  );
  assignNumber(frame, "gpuStartLatencyMs", numericValue(record, columns, "MsUntilRenderStart"));
  assignNumber(frame, "flipDelayMs", numericValue(record, columns, "MsFlipDelay"));
  assignNumber(frame, "animationErrorMs", numericValue(record, columns, "AnimationError", "MsAnimationError"));
  assignNumber(
    frame,
    "allInputToPhotonLatencyMs",
    numericValue(record, columns, "AllInputToPhotonLatency", "MsAllInputToPhotonLatency"),
  );
  assignNumber(
    frame,
    "clickToPhotonLatencyMs",
    numericValue(record, columns, "ClickToPhotonLatency", "MsClickToPhotonLatency"),
  );
  assignNumber(frame, "sinceInputMs", numericValue(record, columns, "MsSinceInput"));
  assignBoolean(frame, "dropped", valueFor(record, columns, "Dropped"));
  assignBoolean(frame, "allowsTearing", valueFor(record, columns, "AllowsTearing"));

  return frame;
}

function valueFor(
  record: readonly string[],
  columns: ReadonlyMap<string, number>,
  ...names: readonly string[]
): string | undefined {
  for (const name of names) {
    const index = columns.get(normalizeHeader(name));
    if (index !== undefined) return record[index];
  }
  return undefined;
}

function numericValue(
  record: readonly string[],
  columns: ReadonlyMap<string, number>,
  ...names: readonly string[]
): number | undefined {
  const raw = valueFor(record, columns, ...names)?.trim();
  if (!raw || raw.toUpperCase() === "NA" || raw.toUpperCase() === "N/A") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function assignText<K extends keyof PresentMonFrameSample>(
  frame: PresentMonFrameSample,
  key: K,
  raw: string | undefined,
): void {
  const value = raw?.trim();
  if (value && value.toUpperCase() !== "NA" && value.toUpperCase() !== "N/A") {
    Object.assign(frame, { [key]: value });
  }
}

function assignInteger<K extends keyof PresentMonFrameSample>(
  frame: PresentMonFrameSample,
  key: K,
  raw: string | undefined,
): void {
  const value = raw === undefined ? undefined : Number(raw.trim());
  if (value !== undefined && Number.isInteger(value)) Object.assign(frame, { [key]: value });
}

function assignNumber<K extends keyof PresentMonFrameSample>(
  frame: PresentMonFrameSample,
  key: K,
  value: number | undefined,
): void {
  if (value !== undefined) Object.assign(frame, { [key]: value });
}

function assignBoolean<K extends keyof PresentMonFrameSample>(
  frame: PresentMonFrameSample,
  key: K,
  raw: string | undefined,
): void {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") Object.assign(frame, { [key]: true });
  if (normalized === "0" || normalized === "false") Object.assign(frame, { [key]: false });
}

function normalizeHeader(header: string): string {
  return header.replace(/^\uFEFF/, "").trim().toLowerCase();
}

function parseCsvRecords(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  const finishRecord = (): void => {
    record.push(field);
    field = "";
    records.push(record);
    record = [];
  };

  for (let index = 0; index < csv.length; index++) {
    const character = csv[index]!;
    if (quoted) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') quoted = true;
    else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && csv[index + 1] === "\n") index++;
      finishRecord();
    } else {
      field += character;
    }
  }

  if (field.length > 0 || record.length > 0) finishRecord();
  return records;
}

async function runPresentMon(binaryPath: string, arguments_: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, arguments_, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        const detail = stderr.trim();
        reject(new Error(
          `PresentMon exited with ${code === null ? `signal ${signal}` : `code ${code}`}${detail ? `: ${detail}` : "."}`,
        ));
      }
    });
  });
}
