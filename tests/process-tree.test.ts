import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  ProcessTreeCollector,
  type ProcessListEntry,
  type ProcessListSource,
} from "../src/collectors/process-tree.js";

test("recursively discovers the current process tree on every sample", async () => {
  const snapshots: ProcessListEntry[][] = [
    [
      processEntry(10, 1, 10, 100, 200),
      processEntry(11, 10, 20, 50, 80),
      processEntry(12, 11, 5, 25, 40),
      processEntry(99, 1, 90, 500, 800),
    ],
    [
      processEntry(10, 1, 12, 110, 210),
      processEntry(13, 10, 7, 30, 50),
      processEntry(14, 13, 3, 20, 30),
      processEntry(99, 1, 90, 500, 800),
    ],
  ];
  let snapshotIndex = 0;
  const collector = new ProcessTreeCollector({
    rootPid: 10,
    logicalProcessorCount: 4,
    now: () => 1234,
    processSource: async () => ({ list: snapshots[snapshotIndex++]! }),
  });

  const first = await collector.sample();
  assert.deepEqual(first.processes.map((process) => process.pid), [10, 11, 12]);
  assert.equal(first.totalCpuPercent, 140);
  assert.equal(first.totalResidentMemoryBytes, 175 * 1024);
  assert.equal(first.totalVirtualMemoryBytes, 320 * 1024);
  assert.equal(first.cpuScale, "one-logical-core");
  assert.equal(first.logicalProcessorCount, 4);

  const second = await collector.sample();
  assert.deepEqual(second.processes.map((process) => process.pid), [10, 13, 14]);
  assert.equal(second.totalCpuPercent, 88);
  assert.equal(second.processes.some((process) => process.pid === 11), false);
  assert.equal(second.sampledAtMs, 1234);
});

test("serializes concurrent process-table readings", async () => {
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const processSource: ProcessListSource = async () => {
    calls++;
    active++;
    maximumActive = Math.max(maximumActive, active);
    await delay(5);
    active--;
    return { list: [processEntry(42, 1, 1, 1, 1)] };
  };
  const collector = new ProcessTreeCollector({
    rootPid: 42,
    logicalProcessorCount: 1,
    processSource,
  });

  await Promise.all([collector.sample(), collector.sample(), collector.sample()]);
  assert.equal(calls, 3);
  assert.equal(maximumActive, 1);
});

test("prime discards the first CPU reading", async () => {
  let call = 0;
  const collector = new ProcessTreeCollector({
    rootPid: 7,
    logicalProcessorCount: 4,
    processSource: async () => ({
      list: [processEntry(7, 1, call++ === 0 ? 0 : 25, 10, 20)],
    }),
  });

  await collector.prime();
  const retained = await collector.sample();
  assert.equal(retained.totalCpuPercent, 100);
});

function processEntry(
  pid: number,
  parentPid: number,
  cpu: number,
  memRss: number,
  memVsz: number,
): ProcessListEntry {
  return {
    pid,
    parentPid,
    cpu,
    memRss,
    memVsz,
    name: `process-${pid}`,
    command: `process-${pid}.exe`,
    params: "",
    path: `C:\\benchmark\\process-${pid}.exe`,
  };
}
