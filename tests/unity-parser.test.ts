import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  collectUnity,
  normalizeUnityResult,
  parseBridgePerfLine,
  parseUnityLog,
  parseUnityProbeResult,
  unityPlayerSpawnOptions,
} from "../src/collectors/unity.js";

const fixture = (name: string): string => resolve(process.cwd(), "fixtures", "unity", name);

test("parses probe summaries and preserves explicit unavailable metrics", async () => {
  const probe = parseUnityProbeResult(await readFile(fixture("probe-result.json"), "utf8"));
  assert.equal(probe.runId, "fixture-run");
  assert.equal(probe.measuredFrames, 300);
  assert.equal(probe.metrics.find((metric) => metric.name === "unity.frame.gpu_ms")?.status, "unavailable");
  assert.equal(probe.checkpoints[0]?.name, "scenario-complete");
});

test("parses bridge marker values and limits log metrics to the measurement window", async () => {
  const marker = parseBridgePerfLine("prefix THREE_UNITY_BRIDGE_PERF rx=12 pageReady=1 profile=voxel-v1");
  assert.equal(marker?.fields.rx, 12);
  assert.equal(marker?.fields.pageReady, 1);
  assert.equal(marker?.fields.profile, "voxel-v1");

  const log = parseUnityLog(await readFile(fixture("player-log.txt"), "utf8"));
  assert.equal(log.bridgePerf.length, 2);
  assert.equal(log.protocolErrors, 1);
  assert.equal(log.fallbacks, 1);
  assert.ok(log.measurementStartLine);
  assert.ok(log.resultLine);
});

test("normalizes probe and bridge metrics to the canonical metric IDs", async () => {
  const probe = parseUnityProbeResult(await readFile(fixture("probe-result.json"), "utf8"));
  const logPath = fixture("player-log.txt");
  const normalized = normalizeUnityResult({
    probe,
    log: parseUnityLog(await readFile(logPath, "utf8")),
    targetId: "fixture-unity",
    outputPath: fixture("probe-result.json"),
    logPath,
    exitCode: 0,
  });

  assert.equal(normalized.metrics["unity.frame.cpu_ms.p95"]?.value, 17);
  assert.equal(normalized.metrics["unity.frame.gpu_ms.p95"]?.status, "unavailable");
  assert.equal(normalized.metrics["unity.gc.alloc_bytes_per_second"]?.value, 1200);
  assert.equal(normalized.metrics["render.unity.draw_calls"]?.value, 100);
  assert.equal(normalized.metrics["bridge.rx_messages_per_second"]?.value, 5);
  assert.equal(normalized.metrics["bridge.protocol_errors"]?.value, 1);
  assert.equal(normalized.metrics["bridge.recovery_count"]?.value, 2);
  assert.equal(normalized.metrics["stability.scenario_completed"]?.value, 1);
});

test("launches Unity Players with a visible host window", () => {
  const env = { THREE_UNITY_TEST: "1" };
  const options = unityPlayerSpawnOptions("C:\\benchmark", env);

  assert.equal(options.windowsHide, false);
  assert.equal(options.cwd, "C:\\benchmark");
  assert.equal(options.env, env);
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
});

test("launches a Player-compatible process and reads its probe artifact and log", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "three-unity-probe-test-"));
  const lifecycle: Array<string | number> = [];
  try {
    const result = await collectUnity({
      target: {
        id: "fake-unity",
        runtime: "unity",
        variant: "custom",
        executable: process.execPath,
        args: [fixture("fake-player.mjs")],
      },
      warmupMs: 1000,
      durationMs: 5000,
      outputDirectory,
      runId: "fake run",
      timeoutMs: 10_000,
      onProcessStarted: (pid) => { lifecycle.push("started", pid); },
      onProcessExited: () => { lifecycle.push("exited"); },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.probe.runId, "fake run");
    assert.equal(result.log.bridgePerf.length, 2);
    assert.equal(result.normalized.metrics["unity.main_thread_ms.p95"]?.value, 8);
    assert.deepEqual(lifecycle.slice(0, 1), ["started"]);
    assert.equal(typeof lifecycle[1], "number");
    assert.deepEqual(lifecycle.slice(2), ["exited"]);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("rejects malformed probe JSON", () => {
  assert.throws(
    () => parseUnityProbeResult('{"kind":"unity"}'),
    /required identity, timing, metrics, or samples/u,
  );
});
