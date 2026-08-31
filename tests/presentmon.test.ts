import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  PresentMonCollector,
  buildPresentMonArguments,
  filterPresentMonFrames,
  parsePresentMonCsv,
} from "../src/collectors/presentmon.js";

test("parses PresentMon v1 columns without inventing unavailable metrics", async () => {
  const csv = await readFixture("v1.csv");
  const parsed = parsePresentMonCsv(csv);

  assert.equal(parsed.version, "v1");
  assert.equal(parsed.frames.length, 2);
  assert.deepEqual(parsed.frames[0], {
    sourceVersion: "v1",
    application: "game.exe",
    processId: 4242,
    swapChainAddress: "0xABC",
    presentRuntime: "DXGI",
    presentMode: "Hardware: Independent Flip",
    timestampSeconds: 1.25,
    frameTimeMs: 16.67,
    gpuBusyMs: 4.2,
    displayLatencyMs: 8.2,
    displayedTimeMs: 16.6,
    presentApiMs: 0.12,
    renderPresentLatencyMs: 5.1,
    gpuStartLatencyMs: 1.5,
    flipDelayMs: 0.2,
    dropped: false,
    allowsTearing: true,
  });
  assert.equal("cpuBusyMs" in parsed.frames[0]!, false);
  assert.equal("sinceInputMs" in parsed.frames[0]!, false);
  assert.equal(parsed.frames[1]!.dropped, true);
  assert.equal("displayLatencyMs" in parsed.frames[1]!, false);
});

test("parses PresentMon v2 frame, CPU, GPU, display, and input columns", async () => {
  const csv = await readFixture("v2.csv");
  const parsed = parsePresentMonCsv(csv);

  assert.equal(parsed.version, "v2");
  assert.equal(parsed.frames.length, 2);
  assert.deepEqual(parsed.frames[0], {
    sourceVersion: "v2",
    application: "game, benchmark.exe",
    processId: 5151,
    swapChainAddress: "0xDEF",
    presentRuntime: "DXGI",
    presentMode: "Hardware: Composed Independent Flip",
    frameType: "Application",
    timestampSeconds: 2.5,
    frameTimeMs: 8.33,
    cpuBusyMs: 3.1,
    cpuWaitMs: 5.23,
    gpuLatencyMs: 1.2,
    gpuTimeMs: 2.7,
    gpuBusyMs: 2.5,
    gpuWaitMs: 0.2,
    displayLatencyMs: 7.4,
    displayedTimeMs: 8.33,
    animationErrorMs: 0.1,
    allInputToPhotonLatencyMs: 18.5,
    clickToPhotonLatencyMs: 12.4,
    allowsTearing: true,
  });
  assert.equal("dropped" in parsed.frames[0]!, false);
  assert.equal("displayedTimeMs" in parsed.frames[1]!, false);
});

test("accepts current v2 millisecond-prefixed metric headers", () => {
  const parsed = parsePresentMonCsv([
    "Application,ProcessID,CPUStartTime,FrameTime,MsCPUBusy,MsCPUWait,MsGPULatency,MsGPUTime,MsGPUBusy,MsGPUWait,MsAnimationError,MsAllInputToPhotonLatency,MsClickToPhotonLatency",
    "game.exe,5,3.0,16.0,5.0,11.0,2.0,4.0,3.5,0.5,0.25,20.0,15.0",
  ].join("\n"));

  assert.deepEqual(parsed.frames[0], {
    sourceVersion: "v2",
    application: "game.exe",
    processId: 5,
    timestampSeconds: 3,
    frameTimeMs: 16,
    cpuBusyMs: 5,
    cpuWaitMs: 11,
    gpuLatencyMs: 2,
    gpuTimeMs: 4,
    gpuBusyMs: 3.5,
    gpuWaitMs: 0.5,
    animationErrorMs: 0.25,
    allInputToPhotonLatencyMs: 20,
    clickToPhotonLatencyMs: 15,
  });
});

test("builds an explicit timed PresentMon command", () => {
  assert.deepEqual(buildPresentMonArguments({
    binaryPath: "C:\\Tools\\PresentMon.exe",
    processId: 99,
    outputPath: "C:\\results\\frames.csv",
    durationSeconds: 15,
    metricsVersion: "v1",
  }), [
    "--process_id",
    "99",
    "--output_file",
    "C:\\results\\frames.csv",
    "--timed",
    "15",
    "--terminate_after_timed",
    "--terminate_on_proc_exit",
    "--no_console_stats",
    "--v1_metrics",
  ]);
});

test("captures repeated process names and filters frames to the current process tree", async () => {
  const arguments_ = buildPresentMonArguments({
    binaryPath: "C:\\Tools\\PresentMon.exe",
    processNames: ["UnityPlayer.exe", "msedgewebview2.exe"],
    includedProcessIds: [5151],
    outputPath: "C:\\results\\frames.csv",
    durationSeconds: 10,
  });
  assert.deepEqual(arguments_.slice(0, 4), [
    "--process_name",
    "UnityPlayer.exe",
    "--process_name",
    "msedgewebview2.exe",
  ]);

  const parsed = parsePresentMonCsv(await readFixture("v2.csv"));
  assert.equal(filterPresentMonFrames(parsed.frames, [5151]).length, 2);
  assert.equal(filterPresentMonFrames(parsed.frames, [9999]).length, 0);
});

test("reports an unavailable adapter instead of synthetic frames", async () => {
  const collector = new PresentMonCollector({
    binaryPath: resolve("fixtures", "presentmon", "missing-PresentMon.exe"),
    processId: 99,
    outputPath: resolve(".tmp", "missing-presentmon.csv"),
    durationSeconds: 1,
  });

  const result = await collector.capture();
  assert.equal(result.available, false);
  assert.equal("frames" in result, false);
});

async function readFixture(name: string): Promise<string> {
  return readFile(resolve("fixtures", "presentmon", name), "utf8");
}
