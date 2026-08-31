import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { chromium } from "playwright";
import { PresentMonCollector } from "./collectors/presentmon.js";
import { ProcessTreeCollector } from "./collectors/process-tree.js";
import type { BenchmarkConfig } from "./types.js";

export interface DoctorCheck {
  id: string;
  status: "pass" | "fail" | "optional-unavailable";
  message: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export async function doctorConfig(config: BenchmarkConfig): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  if (config.scenario) {
    checks.push(await fileCheck("scenario.adapter", config.scenario.adapter, true));
  }
  for (const [role, target] of Object.entries(config.targets)) {
    if (target.runtime === "unity" && target.executable) checks.push(await fileCheck(`${role}.unity-player`, target.executable, true));
    if (target.launch) {
      const pathLikeCommand = isAbsolute(target.launch.command) || /[\\/]/u.test(target.launch.command);
      checks.push(pathLikeCommand
        ? await fileCheck(`${role}.launch-command`, resolve(target.launch.cwd ?? process.cwd(), target.launch.command), true)
        : commandCheck(`${role}.launch-command`, target.launch.command));
    }
  }
  if (Object.values(config.targets).some((target) => target.runtime === "web")) {
    const webOptions = config.collectors?.web?.options ?? {};
    try {
      const launchOptions: Parameters<typeof chromium.launch>[0] = { headless: true };
      if (typeof webOptions.channel === "string") launchOptions.channel = webOptions.channel;
      if (typeof webOptions.executablePath === "string") launchOptions.executablePath = webOptions.executablePath;
      const browser = await chromium.launch(launchOptions);
      const version = browser.version();
      await browser.close();
      checks.push({ id: "collector.web", status: "pass", message: `Chromium launched (${version})` });
    } catch (error) {
      checks.push({ id: "collector.web", status: "fail", message: messageOf(error) });
    }
  }
  if (config.collectors?.processTree?.enabled ?? true) {
    try {
      const collector = new ProcessTreeCollector({ rootPid: process.pid });
      await collector.prime();
      const sample = await collector.sample();
      checks.push({ id: "collector.process-tree", status: sample.rootFound ? "pass" : "fail", message: `rootFound=${sample.rootFound} processes=${sample.processCount}` });
    } catch (error) {
      checks.push({ id: "collector.process-tree", status: "fail", message: messageOf(error) });
    }
  }
  const presentConfig = config.collectors?.presentmon;
  if (presentConfig?.enabled) {
    const configured = presentConfig.options ?? {};
    const collector = new PresentMonCollector({
      binaryPath: typeof configured.binaryPath === "string" ? configured.binaryPath : "PresentMon.exe",
      processNames: ["three-unity-perf-doctor"],
      outputPath: resolve(".bench-results", "doctor-presentmon.csv"),
      durationSeconds: 1,
    });
    const availability = await collector.availability();
    checks.push(availability.available
      ? { id: "collector.presentmon", status: "pass", message: "PresentMon binary is available" }
      : { id: "collector.presentmon", status: presentConfig.required ? "fail" : "optional-unavailable", message: availability.reason });
  }
  return { ok: checks.every((check) => check.status !== "fail"), checks };
}

async function fileCheck(id: string, path: string, executable: boolean): Promise<DoctorCheck> {
  try {
    await access(path, executable && process.platform !== "win32" ? constants.X_OK : constants.F_OK);
    return { id, status: "pass", message: path };
  } catch {
    return { id, status: "fail", message: `Not found or inaccessible: ${path}` };
  }
}

function commandCheck(id: string, command: string): DoctorCheck {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], { windowsHide: true, encoding: "utf8" });
  return result.status === 0
    ? { id, status: "pass", message: result.stdout.trim().split(/\r?\n/u)[0] ?? command }
    : { id, status: "fail", message: `Command not found on PATH: ${command}` };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
