import { processes as readSystemProcesses } from "systeminformation";
import { availableParallelism } from "node:os";

const KIBIBYTE = 1024;

export interface ProcessListEntry {
  pid: number;
  parentPid: number;
  name: string;
  cpu: number;
  memRss: number;
  memVsz: number;
  command: string;
  params: string;
  path: string;
}

export interface ProcessListSnapshot {
  list: readonly ProcessListEntry[];
}

export type ProcessListSource = () => Promise<ProcessListSnapshot>;

export interface ProcessTreeProcessSample {
  pid: number;
  parentPid: number;
  name: string;
  command: string;
  params: string;
  path: string;
  /** 100 means one fully occupied logical CPU; process-tree totals may exceed 100. */
  cpuPercent: number;
  residentMemoryBytes: number;
  virtualMemoryBytes: number;
}

export interface ProcessTreeSample {
  sampledAtMs: number;
  rootPid: number;
  rootFound: boolean;
  processCount: number;
  logicalProcessorCount: number;
  cpuScale: "one-logical-core";
  processes: ProcessTreeProcessSample[];
  totalCpuPercent: number;
  totalResidentMemoryBytes: number;
  totalVirtualMemoryBytes: number;
}

export interface ProcessTreeCollectorOptions {
  rootPid: number;
  processSource?: ProcessListSource;
  now?: () => number;
  logicalProcessorCount?: number;
}

const systemProcessSource: ProcessListSource = async () => {
  const snapshot = await readSystemProcesses();
  return { list: snapshot.list };
};

/**
 * Samples one root process and every currently attached descendant. The full
 * process table is traversed again for every sample so WebView, browser, and
 * helper processes created after collection starts are included automatically.
 */
export class ProcessTreeCollector {
  private readonly rootPid: number;
  private readonly processSource: ProcessListSource;
  private readonly now: () => number;
  private readonly logicalProcessorCount: number;
  private sampleQueue: Promise<void> = Promise.resolve();

  constructor(options: ProcessTreeCollectorOptions) {
    if (!Number.isInteger(options.rootPid) || options.rootPid <= 0) {
      throw new Error("ProcessTreeCollector rootPid must be a positive integer.");
    }
    this.rootPid = options.rootPid;
    this.processSource = options.processSource ?? systemProcessSource;
    this.now = options.now ?? Date.now;
    this.logicalProcessorCount = options.logicalProcessorCount ?? availableParallelism();
    if (!Number.isInteger(this.logicalProcessorCount) || this.logicalProcessorCount <= 0) {
      throw new Error("ProcessTreeCollector logicalProcessorCount must be a positive integer.");
    }
  }

  /**
   * Discards one serialized processes() reading. systeminformation calculates
   * process CPU from the delta to its prior reading, so benchmark runners should
   * prime, wait one normal sample interval, and only then retain samples.
   */
  async prime(): Promise<void> {
    await this.sample();
  }

  sample(): Promise<ProcessTreeSample> {
    const queued = this.sampleQueue.then(() => this.readSample());
    this.sampleQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private async readSample(): Promise<ProcessTreeSample> {
    const snapshot = await this.processSource();
    const entriesByPid = new Map<number, ProcessListEntry>();
    const childrenByParent = new Map<number, ProcessListEntry[]>();

    for (const entry of snapshot.list) {
      entriesByPid.set(entry.pid, entry);
      const siblings = childrenByParent.get(entry.parentPid);
      if (siblings) siblings.push(entry);
      else childrenByParent.set(entry.parentPid, [entry]);
    }

    const rootFound = entriesByPid.has(this.rootPid);
    const treeEntries: ProcessListEntry[] = [];
    const pending = rootFound ? [this.rootPid] : [];
    const visited = new Set<number>();

    while (pending.length > 0) {
      const pid = pending.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);

      const entry = entriesByPid.get(pid);
      if (!entry) continue;
      treeEntries.push(entry);

      for (const child of childrenByParent.get(pid) ?? []) {
        pending.push(child.pid);
      }
    }

    const processSamples = treeEntries
      .sort((left, right) => left.pid - right.pid)
      .map((entry) => toProcessSample(entry, this.logicalProcessorCount));

    return {
      sampledAtMs: this.now(),
      rootPid: this.rootPid,
      rootFound,
      processCount: processSamples.length,
      logicalProcessorCount: this.logicalProcessorCount,
      cpuScale: "one-logical-core",
      processes: processSamples,
      totalCpuPercent: processSamples.reduce((sum, process) => sum + process.cpuPercent, 0),
      totalResidentMemoryBytes: processSamples.reduce(
        (sum, process) => sum + process.residentMemoryBytes,
        0,
      ),
      totalVirtualMemoryBytes: processSamples.reduce(
        (sum, process) => sum + process.virtualMemoryBytes,
        0,
      ),
    };
  }
}

function toProcessSample(
  entry: ProcessListEntry,
  logicalProcessorCount: number,
): ProcessTreeProcessSample {
  return {
    pid: entry.pid,
    parentPid: entry.parentPid,
    name: entry.name,
    command: entry.command,
    params: entry.params,
    path: entry.path,
    cpuPercent: entry.cpu * logicalProcessorCount,
    residentMemoryBytes: entry.memRss * KIBIBYTE,
    virtualMemoryBytes: entry.memVsz * KIBIBYTE,
  };
}
