export const SCHEMA_VERSION = "1.0.0" as const;

export type SchemaVersion = typeof SCHEMA_VERSION;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type TargetRuntime = "web" | "unity";
export type TargetVariant =
  | "threejs-original"
  | "unity-web-bridge"
  | "unity-native-assets"
  | "custom";
export type TargetRole = "before" | "after";

export interface ViewportConfig {
  width: number;
  height: number;
}

export interface LaunchConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export type ReadyCondition =
  | { type: "delay"; delayMs: number }
  | { type: "http"; url?: string; timeoutMs?: number }
  | { type: "log"; pattern: string; timeoutMs?: number }
  | { type: "web-expression"; expression: string; timeoutMs?: number };

export interface TargetConfig {
  id: string;
  label?: string;
  runtime: TargetRuntime;
  variant: TargetVariant;
  url?: string;
  executable?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  launch?: LaunchConfig;
  ready?: ReadyCondition;
  metadata?: JsonObject;
}

/** Public alias used by runners and collectors. */
export type BenchmarkTarget = TargetConfig;

export type RunOrder = "alternating" | "before-first" | "after-first" | "randomized";

export interface ExperimentConfig {
  name: string;
  seed: number;
  viewport: ViewportConfig;
  frameBudgetMs: number;
  warmupMs: number;
  measureMs: number;
  repetitions: number;
  runOrder: RunOrder;
  betweenRunsMs?: number;
}

export interface ScenarioConfig {
  adapter: string;
  exportName?: string;
  parameters?: JsonObject;
}

export interface CollectorConfig {
  enabled?: boolean;
  required?: boolean;
  intervalMs?: number;
  options?: JsonObject;
}

export interface MetricGate {
  metric: string;
  required?: boolean;
  maxRegressionPercent?: number;
  minImprovementPercent?: number;
  maxAbsolute?: number;
  minAbsolute?: number;
  minSampleCount?: number;
  minCoverageRatio?: number;
}

export interface BenchmarkConfig {
  schemaVersion: SchemaVersion;
  experiment: ExperimentConfig;
  targets: Record<TargetRole, TargetConfig>;
  scenario?: ScenarioConfig;
  collectors?: Record<string, CollectorConfig>;
  gates?: MetricGate[];
  outputDirectory?: string;
}

/** Short alias for API consumers and config loaders. */
export type Config = BenchmarkConfig;

export type MetricDirection = "lower" | "higher" | "zero" | "informational";
export type MetricAvailability = "measured" | "unavailable" | "invalid";

export interface MetricMeasurement {
  status: MetricAvailability;
  value?: number;
  unit: string;
  sampleCount: number;
  source: string;
  comparable: boolean;
  coverageRatio?: number;
  reason?: string;
}

/** A timestamped raw observation written to the JSONL sample stream. */
export interface MetricSample {
  tMs: number;
  metric: string;
  value: number;
  unit: string;
  source: string;
  targetId?: string;
  pid?: number;
  tags?: Record<string, string | number | boolean>;
}

export interface ArtifactReference {
  path: string;
  mediaType: string;
  recordCount?: number;
  description?: string;
}

export interface StructuredIssue {
  code: string;
  message: string;
  scope?: string;
  retryable?: boolean;
  details?: JsonObject;
}

export type RunStatus = "completed" | "failed" | "cancelled";

export interface RunPhaseTimings {
  launchMs?: number;
  readyMs?: number;
  warmupMs?: number;
  measurementMs?: number;
  cleanupMs?: number;
}

export interface RunResult {
  schemaVersion: SchemaVersion;
  runId: string;
  targetId: string;
  targetRuntime: TargetRuntime;
  targetVariant: TargetVariant;
  index: number;
  order: number;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  phases?: RunPhaseTimings;
  metrics: Record<string, MetricMeasurement>;
  artifacts: ArtifactReference[];
  warnings: StructuredIssue[];
  errors: StructuredIssue[];
  metadata?: JsonObject;
}

export type MetricMap = Record<string, MetricMeasurement>;

export interface CollectorResult {
  collector: string;
  status: "completed" | "partial" | "failed";
  samples: MetricSample[];
  metrics: MetricMap;
  artifacts: ArtifactReference[];
  warnings: StructuredIssue[];
  errors: StructuredIssue[];
}

export interface ConfidenceInterval {
  low: number;
  high: number;
  level: number;
}

export interface AggregateStatistics {
  count: number;
  median: number;
  mad: number;
  min: number;
  max: number;
}

export interface TargetMetricSummary extends AggregateStatistics {
  unit: string;
  source: string;
}

export interface PairedStatistics {
  count: number;
  deltaAbsolute: number;
  deltaPercent?: number;
  ratio?: number;
  improvementPercent?: number;
  confidenceBasis: "improvementPercent" | "deltaAbsolute";
  confidence95: ConfidenceInterval;
}

export type MetricVerdict = "improved" | "neutral" | "regressed" | "inconclusive" | "unavailable";

export interface GateEvaluation {
  configured: boolean;
  passed?: boolean;
  reason: string;
}

export interface MetricComparison {
  metric: string;
  unit: string;
  direction: MetricDirection;
  before?: TargetMetricSummary;
  after?: TargetMetricSummary;
  paired?: PairedStatistics;
  verdict: MetricVerdict;
  gate: GateEvaluation;
}

export type ComparisonVerdict = "pass" | "regression" | "inconclusive";

export interface ComparisonResult {
  schemaVersion: SchemaVersion;
  comparisonId: string;
  createdAt: string;
  beforeTargetId: string;
  afterTargetId: string;
  pairCount: number;
  verdict: ComparisonVerdict;
  metrics: Record<string, MetricComparison>;
  warnings: StructuredIssue[];
  errors: StructuredIssue[];
}

/** Short public aliases requested by CLI/report integrations. */
export type Target = TargetConfig;
export type Run = RunResult;
export type Comparison = ComparisonResult;
