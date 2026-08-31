import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const outputPath = valueAfter("--three-perf-output");
const logPath = valueAfter("-logFile");
if (!outputPath || !logPath) throw new Error("fake-player requires probe output and log paths");

const probe = JSON.parse(readFileSync(join(fixtureDirectory, "probe-result.json"), "utf8"));
probe.runId = valueAfter("--three-perf-run-id") ?? probe.runId;
probe.warmupMs = Number(valueAfter("--three-perf-warmup-ms") ?? probe.warmupMs);
probe.requestedDurationMs = Number(valueAfter("--three-perf-duration-ms") ?? probe.requestedDurationMs);
mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(logPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(probe, null, 2));
writeFileSync(logPath, readFileSync(join(fixtureDirectory, "player-log.txt"), "utf8"));
