import { summarize } from "../analytics/statistics.js";
import { getMetricDefinition } from "../metrics.js";
import type {
  ComparisonResult,
  ExperimentConfig,
  JsonObject,
  MetricComparison,
  MetricMeasurement,
  RunResult,
} from "../types.js";

export interface BenchmarkReportInput {
  title: string;
  comparison: ComparisonResult;
  runs: RunResult[];
  experiment: ExperimentConfig;
  environment?: JsonObject;
}

export function renderMarkdownReport(input: BenchmarkReportInput): string {
  const { comparison } = input;
  const counts = verdictCounts(comparison);
  const lines: string[] = [
    `# ${input.title}`,
    "",
    `Verdict: **${comparison.verdict.toUpperCase()}**. ${comparison.pairCount} paired run(s); ${counts.improved} improved, ${counts.regressed} regressed, ${counts.inconclusive} inconclusive, ${counts.unavailable} unavailable.`,
    "",
    "## Test contract",
    "",
    `- Viewport: ${input.experiment.viewport.width} × ${input.experiment.viewport.height}`,
    `- Warm-up: ${formatDuration(input.experiment.warmupMs)}`,
    `- Measurement: ${formatDuration(input.experiment.measureMs)}`,
    `- Frame budget: ${formatNumber(input.experiment.frameBudgetMs)} ms`,
    `- Run order: ${input.experiment.runOrder}`,
    `- Seed: ${input.experiment.seed}`,
    "",
    "## Comparable metrics",
    "",
    "| Metric | Before | After | Improvement | 95% CI | Verdict | Gate |",
    "| --- | ---: | ---: | ---: | ---: | --- | --- |",
  ];
  for (const metric of sortedComparisons(comparison)) {
    lines.push(comparisonMarkdownRow(metric));
  }
  lines.push("", "## Target diagnostics", "");
  for (const targetId of [comparison.beforeTargetId, comparison.afterTargetId]) {
    lines.push(`### ${targetId}`, "", "| Metric | Median across runs | MAD | Source |", "| --- | ---: | ---: | --- |");
    for (const row of diagnosticRows(input.runs.filter((run) => run.targetId === targetId))) {
      lines.push(`| ${escapeMarkdown(row.metric)} | ${formatMetric(row.median, row.unit)} | ${formatMetric(row.mad, row.unit)} | ${escapeMarkdown(row.source)} |`);
    }
    lines.push("");
  }
  appendIssues(lines, "Warnings", comparison.warnings.map((issue) => `${issue.code}: ${issue.message}`));
  appendIssues(lines, "Errors", comparison.errors.map((issue) => `${issue.code}: ${issue.message}`));
  lines.push(
    "## Interpretation boundary",
    "",
    "Only measurements with the same metric ID and unit, explicitly marked comparable, are gated; each target's source must remain stable across pairs. Browser rAF and Unity internal frame timing use different IDs and remain diagnostic unless a shared presentation collector supplies both sides. Unavailable counters stay unavailable; they are never converted to zero.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

export function renderHtmlReport(input: BenchmarkReportInput): string {
  const comparison = input.comparison;
  const counts = verdictCounts(comparison);
  const comparisonRows = sortedComparisons(comparison).map((metric) => comparisonHtmlRow(metric)).join("");
  const diagnostics = [comparison.beforeTargetId, comparison.afterTargetId].map((targetId) => {
    const rows = diagnosticRows(input.runs.filter((run) => run.targetId === targetId)).map((row) => `
      <tr><td><code>${escapeHtml(row.metric)}</code></td><td>${escapeHtml(formatMetric(row.median, row.unit))}</td><td>${escapeHtml(formatMetric(row.mad, row.unit))}</td><td>${escapeHtml(row.source)}</td></tr>`).join("");
    return `<section><h2>${escapeHtml(targetId)} diagnostics</h2><div class="table-wrap"><table><thead><tr><th>Metric</th><th>Median</th><th>MAD</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }).join("");
  const topChanges = sortedComparisons(comparison)
    .filter((metric) => metric.paired?.improvementPercent !== undefined)
    .sort((left, right) => Math.abs(right.paired!.improvementPercent!) - Math.abs(left.paired!.improvementPercent!))
    .slice(0, 12);
  const chart = renderChangeChart(topChanges);
  const serialized = JSON.stringify({ comparison, experiment: input.experiment, runs: input.runs }).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#121a2e;--line:#26324d;--text:#eef3ff;--muted:#9eabc4;--good:#43d19e;--bad:#ff6b7d;--warn:#f4c95d;--blue:#6ba8ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 12% 0,#1b2c52 0,transparent 32%),var(--bg);font:14px/1.5 Inter,ui-sans-serif,system-ui;color:var(--text)}main{max-width:1440px;margin:auto;padding:36px 28px 64px}h1{font-size:clamp(28px,4vw,52px);line-height:1.05;margin:0 0 12px}h2{margin:42px 0 14px;font-size:22px}.lede{color:var(--muted);font-size:16px;max-width:900px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:26px 0}.card{background:linear-gradient(145deg,#16223d,#10182b);border:1px solid var(--line);border-radius:14px;padding:16px}.card b{display:block;font-size:25px;margin-top:5px}.label{color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-size:11px}.verdict-pass,.improved{color:var(--good)}.verdict-regression,.regressed{color:var(--bad)}.verdict-inconclusive,.inconclusive{color:var(--warn)}.unavailable{color:var(--muted)}section{margin-top:28px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px;background:rgba(15,23,41,.82)}table{border-collapse:collapse;width:100%;min-width:900px}th,td{padding:11px 13px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th{position:sticky;top:0;background:#17223a;color:#b9c4d9;font-size:11px;text-transform:uppercase;letter-spacing:.06em}th:first-child,td:first-child{text-align:left}tbody tr:hover{background:#182540}code{font:12px ui-monospace,SFMono-Regular,Consolas;color:#cae0ff}.chart{border:1px solid var(--line);background:rgba(15,23,41,.82);border-radius:12px;padding:18px;overflow:auto}.bar-row{display:grid;grid-template-columns:minmax(220px,1.5fr) 3fr 80px;align-items:center;gap:12px;margin:9px 0}.track{height:12px;background:#202c45;border-radius:999px;position:relative}.bar{position:absolute;top:0;height:100%;border-radius:999px}.bar.good{background:var(--good);left:50%}.bar.bad{background:var(--bad);right:50%}.axis{position:absolute;width:1px;height:20px;background:#66718a;left:50%;top:-4px}.note{border-left:3px solid var(--blue);padding:12px 15px;background:#111b31;color:var(--muted);margin-top:28px}.issues{color:var(--warn)}footer{margin-top:45px;color:var(--muted);font-size:12px}@media(max-width:700px){main{padding:24px 14px}.bar-row{grid-template-columns:1fr}.track{order:3}}
</style>
</head>
<body><main>
<div class="label">Three.js → Unity performance benchmark</div>
<h1>${escapeHtml(input.title)}</h1>
<p class="lede">A paired before/after run with raw collector provenance. The headline is <strong class="verdict-${escapeHtml(comparison.verdict)}">${escapeHtml(comparison.verdict.toUpperCase())}</strong>; unavailable and runtime-specific metrics are kept diagnostic.</p>
<div class="cards">
  <div class="card"><span class="label">Verdict</span><b class="verdict-${escapeHtml(comparison.verdict)}">${escapeHtml(comparison.verdict)}</b></div>
  <div class="card"><span class="label">Paired runs</span><b>${comparison.pairCount}</b></div>
  <div class="card"><span class="label">Improved</span><b class="improved">${counts.improved}</b></div>
  <div class="card"><span class="label">Regressed</span><b class="regressed">${counts.regressed}</b></div>
  <div class="card"><span class="label">Inconclusive</span><b class="inconclusive">${counts.inconclusive}</b></div>
  <div class="card"><span class="label">Unavailable</span><b class="unavailable">${counts.unavailable}</b></div>
</div>
<section><h2>Largest measured changes</h2><div class="chart">${chart}</div></section>
<section><h2>Comparable metrics</h2><div class="table-wrap"><table><thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Improvement</th><th>95% CI</th><th>Verdict</th><th>Gate</th></tr></thead><tbody>${comparisonRows}</tbody></table></div></section>
${diagnostics}
<div class="note"><strong>Interpretation boundary.</strong> Only matching metric IDs and units explicitly marked comparable can drive a gate, and each target's source must remain stable across pairs. Browser requestAnimationFrame and Unity internal timing use separate IDs; a shared presentation collector is required for a cross-runtime frame gate. Missing counters remain unavailable, never zero.</div>
${renderIssuesHtml(comparison)}
<footer>${escapeHtml(input.experiment.name)} · ${input.experiment.viewport.width}×${input.experiment.viewport.height} · ${formatDuration(input.experiment.warmupMs)} warm-up · ${formatDuration(input.experiment.measureMs)} measurement · seed ${input.experiment.seed}</footer>
<script type="application/json" id="benchmark-data">${serialized}</script>
</main></body></html>`;
}

function diagnosticRows(runs: RunResult[]): Array<{ metric: string; median: number; mad: number; unit: string; source: string }> {
  const names = new Set(runs.flatMap((run) => Object.keys(run.metrics)));
  const rows = [];
  for (const name of names) {
    const measured = runs.map((run) => run.metrics[name]).filter((metric): metric is MetricMeasurement & { value: number } => metric?.status === "measured" && metric.value !== undefined);
    if (measured.length === 0) continue;
    const stats = summarize(measured.map((metric) => metric.value));
    rows.push({ metric: name, median: stats.median, mad: stats.mad, unit: measured[0]!.unit, source: measured[0]!.source });
  }
  return rows.sort((left, right) => categoryOf(left.metric).localeCompare(categoryOf(right.metric)) || left.metric.localeCompare(right.metric));
}

function comparisonMarkdownRow(metric: MetricComparison): string {
  const improvement = metric.paired?.improvementPercent;
  const confidence = metric.paired?.confidence95;
  return `| ${escapeMarkdown(metric.metric)} | ${metric.before ? formatMetric(metric.before.median, metric.unit) : "—"} | ${metric.after ? formatMetric(metric.after.median, metric.unit) : "—"} | ${improvement === undefined ? "—" : `${formatNumber(improvement)}%`} | ${confidence ? `${formatNumber(confidence.low)}…${formatNumber(confidence.high)}` : "—"} | ${metric.verdict} | ${metric.gate.configured ? (metric.gate.passed ? "pass" : metric.gate.reason) : "—"} |`;
}

function comparisonHtmlRow(metric: MetricComparison): string {
  const confidence = metric.paired?.confidence95;
  const improvement = metric.paired?.improvementPercent;
  return `<tr><td><code>${escapeHtml(metric.metric)}</code></td><td>${metric.before ? escapeHtml(formatMetric(metric.before.median, metric.unit)) : "—"}</td><td>${metric.after ? escapeHtml(formatMetric(metric.after.median, metric.unit)) : "—"}</td><td>${improvement === undefined ? "—" : `${escapeHtml(formatNumber(improvement))}%`}</td><td>${confidence ? `${escapeHtml(formatNumber(confidence.low))}…${escapeHtml(formatNumber(confidence.high))}` : "—"}</td><td class="${escapeHtml(metric.verdict)}">${escapeHtml(metric.verdict)}</td><td>${metric.gate.configured ? escapeHtml(metric.gate.passed ? "pass" : metric.gate.reason) : "—"}</td></tr>`;
}

function renderChangeChart(metrics: MetricComparison[]): string {
  if (metrics.length === 0) return `<span class="unavailable">No paired percent changes are available.</span>`;
  const extent = Math.max(1, ...metrics.map((metric) => Math.abs(metric.paired!.improvementPercent!)));
  return metrics.map((metric) => {
    const value = metric.paired!.improvementPercent!;
    const width = Math.min(50, Math.abs(value) / extent * 50);
    return `<div class="bar-row"><code>${escapeHtml(metric.metric)}</code><div class="track"><span class="axis"></span><span class="bar ${value >= 0 ? "good" : "bad"}" style="width:${width}%"></span></div><span class="${value >= 0 ? "improved" : "regressed"}">${escapeHtml(formatNumber(value))}%</span></div>`;
  }).join("");
}

function renderIssuesHtml(comparison: ComparisonResult): string {
  const issues = [...comparison.warnings, ...comparison.errors];
  if (issues.length === 0) return "";
  return `<section class="issues"><h2>Issues</h2><ul>${issues.map((issue) => `<li><code>${escapeHtml(issue.code)}</code> ${escapeHtml(issue.message)}</li>`).join("")}</ul></section>`;
}

function sortedComparisons(comparison: ComparisonResult): MetricComparison[] {
  return Object.values(comparison.metrics).sort((left, right) => categoryOf(left.metric).localeCompare(categoryOf(right.metric)) || left.metric.localeCompare(right.metric));
}

function categoryOf(metric: string): string {
  return getMetricDefinition(metric)?.category ?? metric.split(".")[0] ?? "other";
}

function verdictCounts(comparison: ComparisonResult): Record<string, number> {
  const counts: Record<string, number> = { improved: 0, neutral: 0, regressed: 0, inconclusive: 0, unavailable: 0 };
  for (const metric of Object.values(comparison.metrics)) counts[metric.verdict] = (counts[metric.verdict] ?? 0) + 1;
  return counts;
}

function appendIssues(lines: string[], heading: string, issues: string[]): void {
  if (issues.length === 0) return;
  lines.push(`## ${heading}`, "", ...issues.map((issue) => `- ${issue}`), "");
}

function formatMetric(value: number, unit: string): string {
  if (unit === "byte") return formatBytes(value);
  if (unit === "boolean") return value === 1 ? "yes" : "no";
  return `${formatNumber(value)} ${unit}`;
}

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let scaled = value;
  let index = 0;
  while (Math.abs(scaled) >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${formatNumber(scaled)} ${units[index]}`;
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${formatNumber(ms / 1000)} s` : `${formatNumber(ms)} ms`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "unavailable";
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute >= 1_000_000 || absolute < 0.001)) return value.toExponential(2);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|");
}
