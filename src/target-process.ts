import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { LaunchConfig } from "./types.js";

export interface ManagedProcess {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  stop(): Promise<void>;
}

export function launchManaged(config: LaunchConfig): ManagedProcess {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.cwd,
    env: { ...process.env, ...config.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
  return {
    child,
    stdout,
    stderr,
    stop: async () => stopProcessTree(child),
  };
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`Target did not become ready at ${url}: ${lastError}`);
}

export async function stopProcessTree(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  child.kill("SIGTERM");
  if (await exitsWithin(child, timeoutMs)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
  await exitsWithin(child, timeoutMs);
}

async function exitsWithin(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const result = await Promise.race([
    once(child, "exit").then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
