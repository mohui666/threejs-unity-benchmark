import assert from "node:assert/strict";
import test from "node:test";
import { presentMonFramesToCollector } from "../src/collectors/presentmon-metrics.js";
import type { PresentMonFrameSample } from "../src/collectors/presentmon.js";
import { webResultToCollector } from "../src/collectors/web-metrics.js";
import type { WebCollectionResult } from "../src/collectors/web.js";

test("PresentMon normalization selects the busiest swap chain and publishes shared cadence", () => {
  const frames: PresentMonFrameSample[] = [
    frame(10, "main", 16, 4),
    frame(10.016, "main", 18, 5),
    frame(10.034, "main", 20, 6),
    frame(10.001, "overlay", 200, 1),
  ];
  const result = presentMonFramesToCollector(frames, 54, 16.6667);

  assert.equal(result.metrics["frame.cadence.interval_ms.p95"]?.status, "measured");
  assert.equal(result.metrics["frame.cadence.interval_ms.p95"]?.sampleCount, 3);
  assert.equal(result.metrics["gpu.frame_time_ms.p95"]?.status, "measured");
  assert.equal(result.metrics["frame.present.dropped_count"]?.value, 0);
});

test("web normalization keeps browser metrics comparable for web-to-web control runs", () => {
  const result = webResultToCollector(webResult(), 16.6667, true);

  assert.equal(result.metrics["web.raf.interval_ms.p95"]?.comparable, true);
  assert.equal(result.metrics["web.cdp.task_duration_ms"]?.value, 250);
  assert.equal(result.metrics["render.three.draw_calls"]?.comparable, true);
  assert.equal(result.metrics["stability.scenario_completed"]?.value, 1);
});

function frame(timestampSeconds: number, swapChainAddress: string, frameTimeMs: number, gpuTimeMs: number): PresentMonFrameSample {
  return {
    sourceVersion: "v2",
    processId: 100,
    swapChainAddress,
    timestampSeconds,
    frameTimeMs,
    gpuTimeMs,
    dropped: false,
  };
}

function webResult(): WebCollectionResult {
  return {
    collector: "playwright-cdp",
    browserVersion: "test",
    browserSystemInfo: null,
    browserProcesses: [],
    processIds: [],
    startedAt: "2026-08-31T00:00:00.000Z",
    readyMs: 100,
    durationMs: 100,
    probe: {
      availableEntryTypes: [],
      frameIntervalsMs: [16, 17, 18, 16, 17, 16],
      longTasks: [{ startTime: 25, duration: 55 }],
      longAnimationFrames: [],
      eventTimings: [],
      paints: { "first-contentful-paint": 30 },
      largestContentfulPaintMs: 45,
      cumulativeLayoutShift: 0,
      navigation: { domContentLoadedEventEnd: 40, loadEventEnd: 50 },
      resources: [{ decodedBodySize: 1024 }],
      customMetrics: {
        "render.three.draw_calls": [{ atMs: 50, value: 12, unit: "count/frame", direction: "lower" }],
      },
      checkpoints: [{ atMs: 90, name: "scenario-complete", value: true }],
      memory: { status: "unavailable", reason: "test" },
    },
    cdp: {
      availableMetrics: ["TaskDuration"],
      start: { TaskDuration: 1 },
      end: { TaskDuration: 1.25, JSHeapUsedSize: 2048 },
      delta: { TaskDuration: 0.25 },
    },
    network: {
      requestCount: 1,
      requestBodyBytes: 0,
      requestHeadersBytes: 100,
      responseBodyBytes: 1024,
      responseHeadersBytes: 100,
      byResourceType: { script: { requests: 1, responseBodyBytes: 1024 } },
    },
    scenario: { completed: true },
    consoleErrors: [],
    pageErrors: [],
    warnings: [],
  };
}
