import type { MetricDirection, MetricGate } from "./types.js";

export type MetricCategory =
  | "frame"
  | "cpu"
  | "memory"
  | "gpu"
  | "startup"
  | "stability"
  | "web"
  | "unity"
  | "render"
  | "bridge"
  | "artifact";

export type MetricPriority = "P0" | "P1" | "P2";

export interface MetricDefinition {
  id: string;
  unit: string;
  direction: MetricDirection;
  category: MetricCategory;
  priority: MetricPriority;
  description: string;
  sourcePriority: readonly string[];
  comparable: boolean;
  defaultGate?: Omit<MetricGate, "metric">;
}

const metric = (
  id: string,
  unit: string,
  direction: MetricDirection,
  category: MetricCategory,
  priority: MetricPriority,
  description: string,
  sourcePriority: readonly string[],
  comparable = true,
  defaultGate?: Omit<MetricGate, "metric">,
): MetricDefinition => ({
  id,
  unit,
  direction,
  category,
  priority,
  description,
  sourcePriority,
  comparable,
  ...(defaultGate === undefined ? {} : { defaultGate }),
});

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  metric("frame.cadence.fps_mean", "fps", "higher", "frame", "P0", "Canonical frame cadence rate when the same measurement source is used for both targets.", ["presentmon", "cadence"]),
  metric("frame.cadence.interval_ms.p50", "ms", "lower", "frame", "P0", "Canonical median frame cadence interval.", ["presentmon", "cadence"]),
  metric("frame.cadence.interval_ms.p90", "ms", "lower", "frame", "P0", "Canonical 90th percentile frame cadence interval.", ["presentmon", "cadence"]),
  metric("frame.cadence.interval_ms.p95", "ms", "lower", "frame", "P0", "Canonical 95th percentile frame cadence interval.", ["presentmon", "cadence"], true, { required: true, maxRegressionPercent: 5, minSampleCount: 300, minCoverageRatio: 0.98 }),
  metric("frame.cadence.interval_ms.p99", "ms", "lower", "frame", "P0", "Canonical 99th percentile frame cadence interval.", ["presentmon", "cadence"]),
  metric("frame.cadence.interval_ms.max", "ms", "lower", "frame", "P0", "Largest canonical frame cadence interval.", ["presentmon", "cadence"]),
  metric("frame.cadence.fps_1pct_low", "fps", "higher", "frame", "P0", "Canonical one-percent-low FPS.", ["presentmon", "cadence"], true, { required: true, maxRegressionPercent: 5, minSampleCount: 300, minCoverageRatio: 0.98 }),
  metric("frame.cadence.fps_0_1pct_low", "fps", "higher", "frame", "P0", "Canonical 0.1-percent-low FPS.", ["presentmon", "cadence"]),
  metric("frame.cadence.deadline_miss_ratio", "ratio", "lower", "frame", "P0", "Canonical fraction of frames above the configured frame budget.", ["presentmon", "cadence"]),
  metric("frame.cadence.stutter_episode_count", "count", "lower", "frame", "P0", "Canonical count of consecutive long-frame episodes.", ["presentmon", "cadence"]),
  metric("frame.cadence.sample_count", "count", "higher", "frame", "P0", "Canonical frame cadence sample count.", ["presentmon", "cadence"], false),
  metric("frame.cadence.coverage_ratio", "ratio", "higher", "frame", "P0", "Canonical frame cadence measurement coverage.", ["presentmon", "cadence"], true, { required: true, minAbsolute: 0.98 }),

  metric("frame.present.fps_mean", "fps", "higher", "frame", "P0", "Displayed presents divided by measured seconds.", ["presentmon"]),
  metric("frame.present.interval_ms.p50", "ms", "lower", "frame", "P0", "Median interval between displayed presents.", ["presentmon"]),
  metric("frame.present.interval_ms.p90", "ms", "lower", "frame", "P0", "90th percentile interval between displayed presents.", ["presentmon"]),
  metric("frame.present.interval_ms.p95", "ms", "lower", "frame", "P0", "95th percentile interval between displayed presents.", ["presentmon"], true, { required: true, maxRegressionPercent: 5, minSampleCount: 300, minCoverageRatio: 0.98 }),
  metric("frame.present.interval_ms.p99", "ms", "lower", "frame", "P0", "99th percentile interval between displayed presents.", ["presentmon"]),
  metric("frame.present.interval_ms.max", "ms", "lower", "frame", "P0", "Largest displayed-present interval.", ["presentmon"]),
  metric("frame.present.fps_1pct_low", "fps", "higher", "frame", "P0", "1000 divided by the mean of the slowest one percent of frame intervals.", ["presentmon"], true, { required: true, maxRegressionPercent: 5, minSampleCount: 300, minCoverageRatio: 0.98 }),
  metric("frame.present.fps_0_1pct_low", "fps", "higher", "frame", "P0", "1000 divided by the mean of the slowest 0.1 percent of frame intervals.", ["presentmon"]),
  metric("frame.present.deadline_miss_ratio", "ratio", "lower", "frame", "P0", "Fraction of present intervals above the configured frame budget.", ["presentmon"], true, { required: true, minSampleCount: 300, minCoverageRatio: 0.98 }),
  metric("frame.present.long_frame_50ms_count", "count", "lower", "frame", "P0", "Present intervals longer than 50 milliseconds.", ["presentmon"]),
  metric("frame.present.long_frame_100ms_count", "count", "lower", "frame", "P0", "Present intervals longer than 100 milliseconds.", ["presentmon"]),
  metric("frame.present.stutter_episode_count", "count", "lower", "frame", "P0", "Runs of consecutive intervals above max(two frame budgets, 50 ms).", ["presentmon"]),
  metric("frame.present.sample_count", "count", "higher", "frame", "P0", "Number of valid displayed-present samples.", ["presentmon"], false),
  metric("frame.present.coverage_ratio", "ratio", "higher", "frame", "P0", "Fraction of the requested measurement window covered by valid present samples.", ["presentmon"], true, { required: true, minAbsolute: 0.98 }),

  metric("cpu.process_tree.core_percent.mean", "percent", "lower", "cpu", "P0", "Mean process-tree CPU where 100 percent equals one logical core.", ["process-tree"], true, { maxRegressionPercent: 10 }),
  metric("cpu.process_tree.core_percent.p95", "percent", "lower", "cpu", "P0", "95th percentile process-tree CPU where 100 percent equals one logical core.", ["process-tree"]),
  metric("cpu.process_tree.core_percent.peak", "percent", "lower", "cpu", "P0", "Peak process-tree CPU where 100 percent equals one logical core.", ["process-tree"]),
  metric("cpu.process_tree.machine_percent.mean", "percent", "lower", "cpu", "P0", "Mean process-tree CPU normalized to the machine's logical processors.", ["process-tree"]),
  metric("cpu.process_tree.machine_percent.p95", "percent", "lower", "cpu", "P0", "95th percentile machine-normalized process-tree CPU.", ["process-tree"]),
  metric("cpu.process_tree.machine_percent.peak", "percent", "lower", "cpu", "P0", "Peak machine-normalized process-tree CPU.", ["process-tree"]),
  metric("cpu.process_tree.time_seconds", "s", "lower", "cpu", "P0", "Total CPU time consumed by the target process tree.", ["process-tree"]),
  metric("process.process_count.mean", "count", "lower", "cpu", "P0", "Mean number of processes in the dynamic target tree.", ["process-tree"]),
  metric("process.process_count.p95", "count", "lower", "cpu", "P0", "95th percentile number of processes in the dynamic target tree.", ["process-tree"]),
  metric("process.process_count.peak", "count", "lower", "cpu", "P0", "Peak number of processes in the dynamic target tree.", ["process-tree"]),

  metric("memory.process_tree.working_set_bytes.mean", "byte", "lower", "memory", "P0", "Mean aggregate working set of the dynamic target process tree.", ["process-tree"]),
  metric("memory.process_tree.working_set_bytes.p95", "byte", "lower", "memory", "P0", "95th percentile aggregate working set of the dynamic target process tree.", ["process-tree"]),
  metric("memory.process_tree.working_set_bytes.peak", "byte", "lower", "memory", "P0", "Peak aggregate working set of the dynamic target process tree.", ["process-tree"]),
  metric("memory.process_tree.working_set_bytes.start", "byte", "informational", "memory", "P0", "Aggregate working set at measurement start.", ["process-tree"]),
  metric("memory.process_tree.working_set_bytes.end", "byte", "informational", "memory", "P0", "Aggregate working set at measurement end.", ["process-tree"]),
  metric("memory.process_tree.virtual_bytes.mean", "byte", "lower", "memory", "P1", "Mean aggregate virtual memory of the dynamic target process tree.", ["process-tree"]),
  metric("memory.process_tree.virtual_bytes.p95", "byte", "lower", "memory", "P1", "95th percentile aggregate virtual memory of the dynamic target process tree.", ["process-tree"]),
  metric("memory.process_tree.virtual_bytes.peak", "byte", "lower", "memory", "P1", "Peak aggregate virtual memory of the dynamic target process tree.", ["process-tree"]),
  metric("memory.process_tree.private_bytes.mean", "byte", "lower", "memory", "P0", "Mean aggregate private bytes of the dynamic target process tree.", ["process-tree"]),
  metric("memory.process_tree.private_bytes.peak", "byte", "lower", "memory", "P0", "Peak aggregate private bytes of the dynamic target process tree.", ["process-tree"], true, { maxRegressionPercent: 10 }),
  metric("memory.process_tree.growth_bytes_per_minute", "byte/min", "lower", "memory", "P0", "Linear working-set slope; unavailable for windows shorter than 60 seconds.", ["process-tree"]),

  metric("gpu.process_tree.utilization_percent.mean", "percent", "lower", "gpu", "P0", "Mean GPU utilization attributed to the target process tree.", ["presentmon", "windows-gpu-counter"]),
  metric("gpu.process_tree.utilization_percent.p95", "percent", "lower", "gpu", "P0", "95th percentile target process-tree GPU utilization.", ["presentmon", "windows-gpu-counter"]),
  metric("gpu.process_tree.utilization_percent.peak", "percent", "lower", "gpu", "P0", "Peak target process-tree GPU utilization.", ["presentmon", "windows-gpu-counter"]),
  metric("gpu.process_tree.dedicated_bytes.peak", "byte", "lower", "gpu", "P0", "Peak dedicated GPU memory attributed to the target process tree.", ["windows-gpu-counter"]),
  metric("gpu.process_tree.shared_bytes.peak", "byte", "lower", "gpu", "P0", "Peak shared GPU memory attributed to the target process tree.", ["windows-gpu-counter"]),
  metric("gpu.frame_time_ms.mean", "ms", "lower", "gpu", "P0", "Mean GPU frame time exposed by PresentMon.", ["presentmon"]),
  metric("gpu.frame_time_ms.p50", "ms", "lower", "gpu", "P0", "Median GPU frame time when exposed by the same collector for both targets.", ["presentmon"]),
  metric("gpu.frame_time_ms.p95", "ms", "lower", "gpu", "P0", "95th percentile GPU frame time when exposed by the same collector for both targets.", ["presentmon"]),
  metric("gpu.frame_time_ms.p99", "ms", "lower", "gpu", "P0", "99th percentile GPU frame time when exposed by the same collector for both targets.", ["presentmon"]),
  metric("gpu.frame_time_ms.max", "ms", "lower", "gpu", "P0", "Largest GPU frame time exposed by PresentMon.", ["presentmon"]),
  metric("frame.present.cpu_busy_ms.p95", "ms", "lower", "cpu", "P1", "95th percentile PresentMon CPU-busy time per frame.", ["presentmon"]),
  metric("frame.present.cpu_wait_ms.p95", "ms", "lower", "cpu", "P1", "95th percentile PresentMon CPU-wait time per frame.", ["presentmon"]),
  metric("frame.present.display_latency_ms.p95", "ms", "lower", "frame", "P1", "95th percentile display latency when PresentMon exposes it.", ["presentmon"]),
  metric("frame.present.dropped_count", "count", "zero", "frame", "P0", "Dropped presents in the selected primary swap chain.", ["presentmon"]),
  metric("frame.present.dropped_ratio", "ratio", "lower", "frame", "P0", "Fraction of selected presents marked dropped.", ["presentmon"]),

  metric("startup.spawn_to_first_present_ms", "ms", "lower", "startup", "P0", "Process spawn to first displayed present.", ["presentmon"]),
  metric("startup.spawn_to_ready_ms", "ms", "lower", "startup", "P0", "Process spawn to the configured ready condition.", ["runner"]),
  metric("startup.ready_to_first_stable_frame_ms", "ms", "lower", "startup", "P0", "Ready condition to the first stable frame window.", ["runner", "presentmon"]),
  metric("startup.exit_cleanup_ms", "ms", "lower", "startup", "P0", "Shutdown request to complete target process-tree cleanup.", ["runner"]),

  metric("stability.crash_count", "count", "zero", "stability", "P0", "Target crashes after readiness.", ["runner"], true, { required: true, maxAbsolute: 0 }),
  metric("stability.nonzero_exit_count", "count", "zero", "stability", "P0", "Unexpected nonzero process exits.", ["runner"], true, { required: true, maxAbsolute: 0 }),
  metric("stability.hang_count", "count", "zero", "stability", "P0", "Detected target hangs.", ["runner"], true, { required: true, maxAbsolute: 0 }),
  metric("stability.scenario_completed", "boolean", "higher", "stability", "P0", "One when the comparable workload reached its final checkpoint.", ["scenario"], true, { required: true, minAbsolute: 1 }),
  metric("stability.sample_gap_count", "count", "zero", "stability", "P0", "Unexpected gaps in required collector streams.", ["runner"]),
  metric("stability.orphan_process_count", "count", "zero", "stability", "P0", "Target descendants remaining after cleanup.", ["process-tree"], true, { required: true, maxAbsolute: 0 }),
  metric("stability.max_concurrent_host_generations", "count", "lower", "stability", "P0", "Maximum simultaneous Web Bridge host generations.", ["bridge-log"]),
  metric("stability.frame_time_degradation_percent", "percent", "lower", "stability", "P0", "Late-window frame interval change relative to the early window.", ["analytics"]),
  metric("stability.browser_console_error_count", "count", "zero", "stability", "P1", "Browser console errors observed during the workload.", ["playwright"], false),
  metric("stability.browser_page_error_count", "count", "zero", "stability", "P1", "Uncaught browser page errors observed during the workload.", ["playwright"], false),

  metric("web.raf.fps_mean", "fps", "higher", "web", "P1", "Mean requestAnimationFrame cadence for web-to-web diagnostics.", ["web-probe"], false),
  metric("web.raf.interval_ms.p50", "ms", "lower", "web", "P1", "Median requestAnimationFrame interval.", ["web-probe"], false),
  metric("web.raf.interval_ms.p90", "ms", "lower", "web", "P1", "90th percentile requestAnimationFrame interval.", ["web-probe"], false),
  metric("web.raf.interval_ms.p95", "ms", "lower", "web", "P1", "95th percentile requestAnimationFrame interval, diagnostic only across runtimes.", ["web-probe"], false),
  metric("web.raf.interval_ms.p99", "ms", "lower", "web", "P1", "99th percentile requestAnimationFrame interval.", ["web-probe"], false),
  metric("web.raf.interval_ms.max", "ms", "lower", "web", "P1", "Largest requestAnimationFrame interval.", ["web-probe"], false),
  metric("web.raf.fps_1pct_low", "fps", "higher", "web", "P1", "One-percent-low requestAnimationFrame FPS.", ["web-probe"], false),
  metric("web.raf.fps_0_1pct_low", "fps", "higher", "web", "P1", "0.1-percent-low requestAnimationFrame FPS.", ["web-probe"], false),
  metric("web.raf.deadline_miss_ratio", "ratio", "lower", "web", "P1", "Fraction of rAF intervals over the configured frame budget.", ["web-probe"], false),
  metric("web.raf.long_frame_50ms_count", "count", "lower", "web", "P1", "rAF intervals longer than 50 milliseconds.", ["web-probe"], false),
  metric("web.raf.long_frame_100ms_count", "count", "lower", "web", "P1", "rAF intervals longer than 100 milliseconds.", ["web-probe"], false),
  metric("web.raf.stutter_episode_count", "count", "lower", "web", "P1", "Consecutive long-frame episodes in rAF cadence.", ["web-probe"], false),
  metric("web.raf.sample_count", "count", "informational", "web", "P1", "Captured requestAnimationFrame interval count.", ["web-probe"], false),
  metric("web.raf.coverage_ratio", "ratio", "higher", "web", "P1", "rAF interval coverage of the requested measurement window.", ["web-probe"], false),
  metric("web.long_task.count", "count", "lower", "web", "P1", "Browser long-task count.", ["web-probe"], false),
  metric("web.long_task.duration_ms", "ms", "lower", "web", "P1", "Total browser long-task duration.", ["web-probe"], false),
  metric("web.long_task.max_ms", "ms", "lower", "web", "P1", "Largest browser long task.", ["web-probe"], false),
  metric("web.js_heap.used_bytes.peak", "byte", "lower", "web", "P1", "Peak JavaScript heap used size.", ["web-probe"], false),
  metric("web.js_heap.used_bytes.end", "byte", "lower", "web", "P1", "Chromium JS heap used size at measurement end.", ["cdp-performance"], false),
  metric("web.js_heap.total_bytes.end", "byte", "informational", "web", "P1", "Chromium JS heap committed size at measurement end.", ["cdp-performance"], false),
  metric("web.memory.user_agent_bytes", "byte", "lower", "web", "P1", "Origin-scoped memory estimate when the browser API is available.", ["measureUserAgentSpecificMemory"], false),
  metric("web.resource.request_count", "count", "lower", "web", "P1", "Resource requests during page loading.", ["web-probe"], false),
  metric("web.resource.transfer_bytes", "byte", "lower", "web", "P1", "Transferred resource bytes during page loading.", ["web-probe"], false),
  metric("web.resource.decoded_body_bytes", "byte", "lower", "web", "P1", "Decoded response body bytes reported by the Performance API.", ["web-performance"], false),
  metric("web.navigation.dom_content_loaded_ms", "ms", "lower", "web", "P1", "Navigation start to DOMContentLoaded.", ["web-probe"], false),
  metric("web.navigation.load_ms", "ms", "lower", "web", "P1", "Navigation start to load event.", ["web-probe"], false),
  metric("web.navigation.fcp_ms", "ms", "lower", "web", "P1", "First Contentful Paint timing.", ["web-probe"], false),
  metric("web.navigation.lcp_ms", "ms", "lower", "web", "P1", "Largest Contentful Paint timing.", ["web-probe"], false),
  metric("web.layout_shift.cumulative", "score", "lower", "web", "P1", "Cumulative layout shift during collection.", ["web-performance"], false),
  metric("web.cdp.task_duration_ms", "ms", "lower", "web", "P1", "Chromium task duration accumulated during measurement.", ["cdp-performance"], false),
  metric("web.cdp.script_duration_ms", "ms", "lower", "web", "P1", "Chromium script duration accumulated during measurement.", ["cdp-performance"], false),
  metric("web.cdp.layout_duration_ms", "ms", "lower", "web", "P1", "Chromium layout duration accumulated during measurement.", ["cdp-performance"], false),
  metric("web.cdp.recalc_style_duration_ms", "ms", "lower", "web", "P1", "Chromium style recalculation duration accumulated during measurement.", ["cdp-performance"], false),
  metric("web.cdp.v8_compile_duration_ms", "ms", "lower", "web", "P1", "V8 compilation duration accumulated during measurement.", ["cdp-performance"], false),
  metric("web.cdp.layout_count", "count", "lower", "web", "P1", "Chromium layout operations during measurement.", ["cdp-performance"], false),
  metric("web.cdp.recalc_style_count", "count", "lower", "web", "P1", "Chromium style recalculation operations during measurement.", ["cdp-performance"], false),
  metric("web.dom.node_count.end", "count", "lower", "web", "P1", "DOM node count at measurement end.", ["cdp-performance"], false),
  metric("web.dom.document_count.end", "count", "lower", "web", "P1", "Document count at measurement end.", ["cdp-performance"], false),
  metric("web.dom.event_listener_count.end", "count", "lower", "web", "P1", "Event listener count at measurement end.", ["cdp-performance"], false),

  metric("unity.frame.cpu_ms.p95", "ms", "lower", "unity", "P1", "95th percentile Unity CPU frame time.", ["unity-probe"], false),
  metric("unity.frame.gpu_ms.p95", "ms", "lower", "unity", "P1", "95th percentile Unity GPU frame time.", ["unity-probe"], false),
  metric("unity.main_thread_ms.p95", "ms", "lower", "unity", "P1", "95th percentile Unity main-thread time.", ["unity-probe"], false),
  metric("unity.render_thread_ms.p95", "ms", "lower", "unity", "P1", "95th percentile Unity render-thread time.", ["unity-probe"], false),
  metric("unity.wait_for_present_ms.p95", "ms", "lower", "unity", "P1", "95th percentile Unity wait-for-present time.", ["unity-probe"], false),
  metric("unity.gc.alloc_bytes_per_frame.mean", "byte/frame", "lower", "unity", "P1", "Mean managed allocation per Unity frame.", ["unity-probe"], false),
  metric("unity.gc.alloc_bytes_per_second", "byte/s", "lower", "unity", "P1", "Managed allocation rate.", ["unity-probe"], false),
  metric("unity.gc.used_bytes.peak", "byte", "lower", "unity", "P1", "Peak Unity managed heap used bytes.", ["unity-probe"], false),
  metric("unity.gc.reserved_bytes.peak", "byte", "lower", "unity", "P1", "Peak Unity managed heap reserved bytes.", ["unity-probe"], false),

  metric("render.three.draw_calls", "count/frame", "lower", "render", "P1", "Three.js renderer draw calls per frame.", ["web-probe"], false),
  metric("render.three.triangles", "count/frame", "informational", "render", "P1", "Three.js triangles submitted per frame.", ["web-probe"], false),
  metric("render.three.points", "count/frame", "informational", "render", "P1", "Three.js points submitted per frame.", ["web-probe"], false),
  metric("render.three.lines", "count/frame", "informational", "render", "P1", "Three.js line primitives submitted per frame.", ["web-probe"], false),
  metric("render.three.geometries", "count", "lower", "render", "P1", "Three.js geometry resources retained by the renderer.", ["web-probe"], false),
  metric("render.three.textures", "count", "lower", "render", "P1", "Three.js texture resources retained by the renderer.", ["web-probe"], false),
  metric("render.three.programs", "count", "lower", "render", "P1", "Three.js compiled renderer programs when exposed.", ["web-probe"], false),
  metric("render.unity.draw_calls", "count/frame", "lower", "render", "P1", "Unity draw calls per frame.", ["unity-probe"], false),
  metric("render.unity.batches", "count/frame", "lower", "render", "P1", "Unity batches per frame.", ["unity-probe"], false),
  metric("render.unity.triangles", "count/frame", "informational", "render", "P1", "Unity triangles submitted per frame.", ["unity-probe"], false),

  metric("bridge.rx_messages_per_second", "message/s", "lower", "bridge", "P1", "Web-to-Unity envelope rate during the measurement window.", ["bridge-log"], false),
  metric("bridge.tx_messages_per_second", "message/s", "lower", "bridge", "P1", "Unity-to-Web envelope rate during the measurement window.", ["bridge-log"], false),
  metric("bridge.rx_characters_per_second", "character/s", "lower", "bridge", "P1", "Web-to-Unity UTF-16 character rate; not encoded bytes.", ["bridge-log"], false),
  metric("bridge.tx_characters_per_second", "character/s", "lower", "bridge", "P1", "Unity-to-Web UTF-16 character rate; not encoded bytes.", ["bridge-log"], false),
  metric("bridge.queue_pending.p95", "count", "lower", "bridge", "P1", "95th percentile combined bridge queue depth.", ["bridge-log"], false),
  metric("bridge.queue_pending.max", "count", "lower", "bridge", "P1", "Maximum combined bridge queue depth.", ["bridge-log"], false),
  metric("bridge.dropped", "count", "zero", "bridge", "P1", "Accepted reliable messages lost when a physical connection retired.", ["bridge-log"], false),
  metric("bridge.backpressure", "count", "zero", "bridge", "P1", "Reliable enqueue attempts rejected for retry.", ["bridge-log"], false),
  metric("bridge.inbound_overflow", "count", "zero", "bridge", "P1", "Inbound queue overflow count.", ["bridge-log"], false),
  metric("bridge.diagnostic_overflow", "count", "zero", "bridge", "P1", "Host diagnostic queue overflow count.", ["bridge-log"], false),
  metric("bridge.protocol_errors", "count", "zero", "bridge", "P1", "Browser and Unity bridge protocol errors.", ["bridge-log", "web-probe"], false),
  metric("bridge.fallbacks", "count", "zero", "bridge", "P1", "Fallbacks to browser authority.", ["bridge-log", "web-probe"], false),
  metric("bridge.input_age_ms.p95", "ms", "lower", "bridge", "P1", "95th percentile age of replaceable input.", ["bridge-log"], false),
  metric("bridge.recovery_count", "count", "informational", "bridge", "P1", "Logical or physical recovery events.", ["bridge-log"], false),

  metric("artifact.package.total_bytes", "byte", "lower", "artifact", "P1", "Total bytes of each target's configured build artifact.", ["artifact"]),
  metric("artifact.package.file_count", "count", "informational", "artifact", "P1", "File count of each target's configured build artifact.", ["artifact"]),
  metric("artifact.source.total_bytes", "byte", "informational", "artifact", "P1", "Total bytes in the source web distribution.", ["artifact"]),
  metric("artifact.unity.total_bytes", "byte", "informational", "artifact", "P1", "Total bytes in the built Unity artifact.", ["artifact"]),
  metric("artifact.threeunity.node_count", "count", "informational", "artifact", "P1", "Nodes in the converted .threeunity document.", ["artifact"]),
  metric("artifact.threeunity.vertex_count", "count", "informational", "artifact", "P1", "Vertices represented by converted meshes and primitives.", ["artifact"]),
  metric("artifact.threeunity.triangle_count", "count", "informational", "artifact", "P1", "Triangles represented by converted meshes.", ["artifact"]),
  metric("artifact.threeunity.warning_count", "count", "zero", "artifact", "P1", "Exporter warnings in the converted document.", ["artifact"]),
] as const;

export const METRIC_REGISTRY: Readonly<Record<string, MetricDefinition>> = Object.freeze(
  Object.fromEntries(METRIC_DEFINITIONS.map((definition) => [definition.id, definition])),
);

export function getMetricDefinition(id: string): MetricDefinition | undefined {
  return METRIC_REGISTRY[id];
}

export function listMetricDefinitions(priority?: MetricPriority): MetricDefinition[] {
  return METRIC_DEFINITIONS.filter((definition) => priority === undefined || definition.priority === priority);
}

export function metricDirection(id: string): MetricDirection {
  return getMetricDefinition(id)?.direction ?? "informational";
}

export function defaultMetricGates(): MetricGate[] {
  return METRIC_DEFINITIONS.flatMap((definition) =>
    definition.defaultGate === undefined
      ? []
      : [{ metric: definition.id, ...definition.defaultGate }],
  );
}
