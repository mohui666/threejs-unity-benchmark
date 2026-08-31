# Metrics and comparison semantics

本页定义指标的口径、来源和可比性。运行时的权威目录由 CLI 生成：

```bash
three-unity-perf --json metrics
three-unity-perf --json metrics --priority P0
three-unity-perf --json capabilities
```

## 先区分三类证据

| 层级 | 典型来源 | 能否用于 Three.js vs Unity 主结论 |
| --- | --- | --- |
| 跨运行时共同指标 | PresentMon、process-tree、runner stability | 可以；仍须满足 unit、sample count、coverage 和 gate 条件 |
| runtime-specific 诊断 | Web probe/CDP、Unity probe、Three/Unity renderer counters | 不直接横向比较；用于解释共同指标为什么变化 |
| 结构/产物指标 | Web dist、Unity build、`.threeunity` inventory、bridge log | 信息或架构诊断，不替代运行时性能 |

Web rAF 表示浏览器回调节奏；Unity CPU/GPU frame time 表示引擎内部计时；PresentMon 表示操作系统观察到的呈现路径。三者回答的问题不同。跨运行时 frame gate 应使用双方共同的 `frame.cadence.*`，而不是把 `web.raf.*` 与 `unity.frame.*` 拼成一项。

## Normalized measurement

每个 `run.json` 的指标都有同一结构：

```json
{
  "status": "measured",
  "value": 16.72,
  "unit": "ms",
  "sampleCount": 3594,
  "source": "presentmon",
  "comparable": true,
  "coverageRatio": 0.998
}
```

- `status`: `measured`、`unavailable` 或 `invalid`。只有 measured 才有有效 value。
- `source`: 保留数据来源；同一个 target 的来源不能在不同 pair 中漂移。
- `comparable`: collector 明确允许比较时才为 true。
- `sampleCount`: 该 run 汇总值使用的底层样本数。
- `coverageRatio`: 有效样本覆盖请求 measurement window 的比例。
- `reason`: unavailable/invalid 的直接原因。

比较器只接受 finite、measured、comparable 且 A/B 单位相同的值。一对中任一侧缺失，该 pair 不会被填 0；gate 可以因为 pair 不完整、样本不足或覆盖不足而变成 inconclusive。

## 优先级

- **P0**：性能结论和稳定性首先应关注的指标。
- **P1**：定位原因、解释架构成本或描述产物的诊断指标。
- `metrics --priority P0` / `P1` 可从注册表取得完整机器可读定义，包括 unit、direction、category、source priority 和建议 gate 元数据。

注册表是指标契约，不承诺每个平台都能产出每个 counter。collector 会保留 unavailable 原因。

## Frame cadence and presentation

### Canonical shared cadence (`frame.cadence.*`)

```text
frame.cadence.fps_mean
frame.cadence.interval_ms.p50
frame.cadence.interval_ms.p90
frame.cadence.interval_ms.p95
frame.cadence.interval_ms.p99
frame.cadence.interval_ms.max
frame.cadence.fps_1pct_low
frame.cadence.fps_0_1pct_low
frame.cadence.deadline_miss_ratio
frame.cadence.stutter_episode_count
frame.cadence.sample_count
frame.cadence.coverage_ratio
```

当前由 PresentMon normalized frame intervals 产出。`fps_mean = 1000 / mean(frame interval)`；1% low / 0.1% low 用最慢 1% / 0.1% 帧间隔的均值换算；deadline miss 使用 `experiment.frameBudgetMs`；stutter episode 是连续超过 `max(2 × frameBudgetMs, 50 ms)` 的一个区段。

### Detailed present path (`frame.present.*`)

```text
frame.present.fps_mean
frame.present.interval_ms.p50
frame.present.interval_ms.p90
frame.present.interval_ms.p95
frame.present.interval_ms.p99
frame.present.interval_ms.max
frame.present.fps_1pct_low
frame.present.fps_0_1pct_low
frame.present.deadline_miss_ratio
frame.present.long_frame_50ms_count
frame.present.long_frame_100ms_count
frame.present.stutter_episode_count
frame.present.sample_count
frame.present.coverage_ratio
```

PresentMon normalizer还会在 CSV 有对应列时输出：

```text
frame.present.cpu_busy_ms.{mean,p50,p95,p99,max}
frame.present.cpu_wait_ms.{mean,p50,p95,p99,max}
frame.present.display_latency_ms.{mean,p50,p95,p99,max}
frame.present.dropped_count
frame.present.dropped_ratio
```

当前实现按 usable frame count 选择主要 process/swap-chain group。覆盖率为有效帧间隔总时长 / 请求测量时长，上限为 1。
PresentMon 默认 `CPUStartTime` 是从本次 recording 开始的相对时间；Unity 路径按 collector 启动时刻把 CSV 裁到同一 ready + warm-up 后的 measurement window，缺少时间列时不会把启动帧混入稳定窗口。

## CPU and process tree

注册指标：

```text
cpu.process_tree.core_percent.mean
cpu.process_tree.core_percent.p95
cpu.process_tree.core_percent.peak
cpu.process_tree.machine_percent.mean
cpu.process_tree.machine_percent.p95
cpu.process_tree.machine_percent.peak
cpu.process_tree.time_seconds
process.process_count.mean
process.process_count.p95
process.process_count.peak
```

`core_percent` 中 100% 表示一个逻辑核；`machine_percent` 再除以逻辑处理器数。采样器动态汇总 root PID 及当次可见 descendants。

## Memory

注册指标：

```text
memory.process_tree.working_set_bytes.mean
memory.process_tree.working_set_bytes.p95
memory.process_tree.working_set_bytes.peak
memory.process_tree.working_set_bytes.start
memory.process_tree.working_set_bytes.end
memory.process_tree.virtual_bytes.mean
memory.process_tree.virtual_bytes.p95
memory.process_tree.virtual_bytes.peak
memory.process_tree.private_bytes.mean
memory.process_tree.private_bytes.peak
memory.process_tree.growth_bytes_per_minute
```

当前 process collector实际采集整个进程树的 resident working set 和 virtual memory，输出：

```text
memory.process_tree.working_set_bytes.{mean,p95,peak,start,end}
memory.process_tree.virtual_bytes.{mean,p95,peak}
memory.process_tree.growth_bytes_per_minute
```

内存增长趋势只对至少 60 秒的窗口计算线性斜率。`systeminformation` 的 portable process 数据没有 private bytes，因此对应指标显式 unavailable，不会拿 working set 冒充 private bytes。

## GPU

注册指标：

```text
gpu.process_tree.utilization_percent.mean
gpu.process_tree.utilization_percent.p95
gpu.process_tree.utilization_percent.peak
gpu.process_tree.dedicated_bytes.peak
gpu.process_tree.shared_bytes.peak
gpu.frame_time_ms.mean
gpu.frame_time_ms.p50
gpu.frame_time_ms.p95
gpu.frame_time_ms.p99
gpu.frame_time_ms.max
```

当前 PresentMon CSV 存在 `GPUTime`/`MsGPUTime` 时会输出 `gpu.frame_time_ms.{mean,p50,p95,p99,max}`。进程树 GPU 利用率和 dedicated/shared GPU memory 已进入契约，但当前没有 Windows GPU counter collector 接线；报告中应保持 unavailable。

## Startup and lifecycle

```text
startup.spawn_to_first_present_ms
startup.spawn_to_ready_ms
startup.ready_to_first_stable_frame_ms
startup.exit_cleanup_ms
```

当前 runner直接输出 `startup.spawn_to_ready_ms`。另外三项保留在契约中，需要可靠的 present/lifecycle marker 后才应产生，不用 delay 推测。

## Stability

```text
stability.crash_count
stability.nonzero_exit_count
stability.hang_count
stability.scenario_completed
stability.sample_gap_count
stability.orphan_process_count
stability.max_concurrent_host_generations
stability.frame_time_degradation_percent
```

当前 runner输出 crash，Unity collector输出 nonzero exit，Web/Unity workload输出 scenario completion，process collector输出 root sample gap。Web collector还输出：

```text
stability.browser_console_error_count
stability.browser_page_error_count
```

hang、orphan、host generations 和长窗口 degradation 只有在相应 detector/telemetry 有数据时才有效。对 `stability.*` 和 direction `zero` 的 hard invariant，`maxAbsolute`/`minAbsolute` 会逐个 after run 检查，不要求先凑满 5 pairs。

## Web diagnostics

注册的核心 Web 指标：

```text
web.raf.interval_ms.p95
web.long_task.count
web.long_task.duration_ms
web.js_heap.used_bytes.peak
web.resource.request_count
web.resource.transfer_bytes
web.navigation.dom_content_loaded_ms
web.navigation.load_ms
web.navigation.fcp_ms
web.navigation.lcp_ms
```

当前 Web collector 的实际输出更细：

```text
web.raf.fps_mean
web.raf.interval_ms.{p50,p90,p95,p99,max}
web.raf.fps_1pct_low
web.raf.fps_0_1pct_low
web.raf.deadline_miss_ratio
web.raf.long_frame_50ms_count
web.raf.long_frame_100ms_count
web.raf.stutter_episode_count
web.raf.sample_count
web.raf.coverage_ratio

web.long_task.{count,duration_ms,max_ms}
web.resource.{request_count,transfer_bytes,decoded_body_bytes}
web.navigation.{dom_content_loaded_ms,load_ms,fcp_ms,lcp_ms}
web.layout_shift.cumulative
web.memory.user_agent_bytes

web.cdp.{task_duration_ms,script_duration_ms,layout_duration_ms,
         recalc_style_duration_ms,v8_compile_duration_ms,
         layout_count,recalc_style_count}
web.js_heap.{used_bytes.end,total_bytes.end}
web.dom.{node_count.end,document_count.end,event_listener_count.end}
```

Long Animation Frame 和 event timing 原始记录在 `raw.json` 中；浏览器不支持某个 Performance entry type 时，不会伪造该数据。Web metrics可以用于 Web-vs-Web control 对比，但不与 Unity internal metrics合并。

页面通过 `globalThis.__THREE_UNITY_PERF__.setMetric(name, value, { unit, direction })` 发布的 custom series 会生成 `name`、`name.p95`、`name.peak`，并保留时间序列。`publishThreeRendererInfo(renderer)` 是 Three.js `renderer.info` 的便捷适配器。

## Unity diagnostics

```text
unity.frame.cpu_ms.p95
unity.frame.gpu_ms.p95
unity.main_thread_ms.p95
unity.render_thread_ms.p95
unity.wait_for_present_ms.p95
unity.gc.alloc_bytes_per_frame.mean
unity.gc.alloc_bytes_per_second
unity.gc.used_bytes.peak
unity.gc.reserved_bytes.peak
```

Probe 的原始 series 还包括 update interval、PlayerLoop、BehaviourUpdate、FixedBehaviourUpdate、GC.Collect、system/total used memory 和逐帧 render counters。规范化结果使用 Unity probe source 并标记为 runtime-specific；不同 Unity 版本、平台、graphics API 或未启用 Frame Timing Stats 时，部分 recorder/FrameTiming 字段会 unavailable。

## Render diagnostics

```text
render.three.draw_calls
render.three.triangles
render.three.points
render.three.lines
render.three.geometries
render.three.textures
render.three.programs
render.unity.draw_calls
render.unity.batches
render.unity.triangles
```

Three.js 页面还可发布 points、lines、geometries、textures 和 programs；Unity probe原始记录还包含 SetPass 和 vertices。draw call/batch/triangle 的引擎定义不同，它们用于解释各自 runtime，不应当作跨引擎等价工作量的唯一证明。

## Bridge diagnostics

```text
bridge.rx_messages_per_second
bridge.tx_messages_per_second
bridge.rx_characters_per_second
bridge.tx_characters_per_second
bridge.queue_pending.p95
bridge.queue_pending.max
bridge.dropped
bridge.backpressure
bridge.inbound_overflow
bridge.diagnostic_overflow
bridge.protocol_errors
bridge.fallbacks
bridge.input_age_ms.p95
bridge.recovery_count
```

Unity Player log中的 `THREE_UNITY_BRIDGE_PERF key=value ...` 快照会在 measurement marker 和 result marker 之间解析。字符速率是日志声明的 character count，不冒充编码后 byte count。Bridge 指标是转换架构诊断，不与原始 Three.js 强行比较；它们回答“桥是否成为瓶颈”，不单独回答“用户看到的帧是否更顺”。

## Artifact inventory

```text
artifact.source.total_bytes
artifact.unity.total_bytes
artifact.package.total_bytes
artifact.package.file_count
artifact.threeunity.node_count
artifact.threeunity.vertex_count
artifact.threeunity.triangle_count
artifact.threeunity.warning_count
```

把 target `metadata.artifactPath` 指向文件或目录即可统计 build size/file count；after target还可用 `metadata.threeunityPath` 指向导出文档，附加 mesh/material/texture/animation/skin/index/morph 等 inventory。产物指标默认 informational，文件体积变小不等于运行性能提升。

## Gate semantics

一个实用 gate 示例：

```json
{
  "metric": "frame.cadence.interval_ms.p95",
  "required": true,
  "maxRegressionPercent": 5,
  "minSampleCount": 300,
  "minCoverageRatio": 0.98
}
```

- `maxRegressionPercent: 5`：允许最多 5% 退化。对 lower-is-better 指标，改善百分比会把 `(after-before)/before` 的符号翻转。
- `minImprovementPercent`: 要求达到指定改善幅度。
- `maxAbsolute` / `minAbsolute`: after 的绝对阈值；普通指标基于 after median 的 bootstrap interval，hard invariant逐 run 检查。
- `minSampleCount`: 每一对都取 A/B 较小 sample count，任一 pair 不足即 inconclusive。
- `minCoverageRatio`: 每一对都取 A/B 较小 coverage；任一 pair 不足即 inconclusive。
- `required: false`: 指标缺失或质量不足时跳过，不阻塞总 verdict。

CLI `run` 只使用 config 中显式列出的 gates。注册表中的 default gate metadata 是建议值，不会偷偷追加到用户配置。

## Reading the verdict

- `pass`: 没有配置 gate 失败，所有 required gate都有明确通过结果，并且存在可比较数据。
- `regression`: 至少一个 gate有明确失败证据。
- `inconclusive`: required 指标缺失、pair 少于推断要求、覆盖/样本不足、区间跨越阈值，或没有可比较指标。

单指标 `improved` / `neutral` / `regressed` / `inconclusive` / `unavailable` 与 suite verdict 是两个层级。报告必须同时看 gate reason、pair count、confidence interval、source、sample count 和 coverage。
