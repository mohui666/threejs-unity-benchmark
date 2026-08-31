# Three.js Unity Performance Probe (UPM)

这个包为转换后的 Unity Player提供 runtime-specific 性能采集，并与仓库根目录的 `three-unity-perf` runner 配合使用。它不会改动正常 Player 行为：命令行中没有 `--three-perf-output` 时，bootstrap 直接返回，不创建 GameObject，也不启动 recorder。

## Install

通过 Unity Package Manager 的 Git URL：

```text
https://github.com/mohui666/threejs-unity-benchmark.git?path=/unity-package
```

或者在项目 `Packages/manifest.json` 中指向本地 checkout：

```json
{
  "dependencies": {
    "com.three-unity.performance-probe": "file:../../threejs-unity-benchmark/unity-package"
  }
}
```

构建要被测的 Windows Player。CLI 对现有 Player运行采集，不要求为了 benchmark 创建 Editor UI。

## Activation and lifecycle

CLI 自动追加：

```text
--three-perf-output <absolute-json-path>
--three-perf-run-id <run-id>
--three-perf-warmup-ms <milliseconds>
--three-perf-duration-ms <milliseconds>
```

如 Unity target有 ready 条件，还会追加其中一个：

```text
--three-perf-ready-delay-ms <milliseconds>
--three-perf-ready-log-pattern <regex>
```

Probe 在 `BeforeSceneLoad` 创建 `DontDestroyOnLoad` GameObject，等待 ready，完成 warm-up，按帧采样，写 JSON，输出 `THREE_UNITY_PERF_RESULT` 日志并以 code 0 退出。CLI 读取 JSON 和 Player log后再规范化为 `run.json`。

## Scenario checkpoint

在 Unity 侧同等工作负载完成时调用：

```csharp
using ThreeUnity.Performance;

public sealed class BenchmarkScenario : MonoBehaviour
{
    private void CompleteComparableWorkload(bool stateMatchesExpected)
    {
        ThreeUnityPerformance.Checkpoint("scenario-complete", stateMatchesExpected);
    }
}
```

当 benchmark config包含 Web scenario adapter 时，Unity 没有发出 `scenario-complete` 会让 `stability.scenario_completed` unavailable；值为 false 会让硬 gate失败。检查点只接受 boolean value，名称不能为空。

Web adapter不会在 Unity 中执行。Unity 场景必须自行读取/固定与 Web 相同的 seed、路线、对象数量和输入序列。可以把这些参数放进 Player args，但要确保它们和 config 的 experiment/scenario 参数同步。

## Readiness

推荐在 Player真正可交互时输出稳定日志，例如：

```csharp
Debug.Log("BENCHMARK_SCENE_READY");
```

配置：

```json
{
  "ready": {
    "type": "log",
    "pattern": "^BENCHMARK_SCENE_READY$",
    "timeoutMs": 60000
  }
}
```

Probe 使用 regex 匹配 Unity log callback。`delay` 更适合启动时序完全固定的最小样例；正式项目优先使用语义 ready marker。

## Collected series

### FrameTimingManager

```text
unity.frame.cpu_ms
unity.frame.gpu_ms
unity.frame.main_thread_active_ms
unity.frame.render_thread_active_ms
unity.frame.present_wait_ms
```

启用 Player Settings 的 Frame Timing Stats，或使用支持该功能的 Development Player。平台/API 不提供 timing 时，series会带 unavailable reason。

### ProfilerRecorder

```text
unity.main_thread_ms
unity.render_thread_ms
unity.player_loop_ms
unity.behaviour_update_ms
unity.fixed_behaviour_update_ms
unity.wait_for_present_ms
unity.gc.collect_ms

unity.memory.system_used_bytes
unity.memory.total_used_bytes
unity.gc.used_bytes
unity.gc.reserved_bytes
unity.gc.alloc_bytes_per_frame

render.unity.draw_calls_per_frame
render.unity.batches_per_frame
render.unity.setpass_calls_per_frame
render.unity.triangles_per_frame
render.unity.vertices_per_frame
```

Recorder名称是否存在由实际 Unity 版本、平台和构建决定。Probe 对每项独立保留 availability，不把 missing counter填 0。

### Probe metadata

结果还记录 Unity/product/platform、CPU、system memory、GPU/API/VRAM、screen size、target frame rate、vSync、fixed delta time、是否 batch mode、requested/measured duration、frame count 和 checkpoints。

## Bridge telemetry

如果转换使用 Three.js-to-Unity Web Bridge，Player log可在 measurement window内输出：

```text
THREE_UNITY_BRIDGE_PERF rx=120 tx=80 rxChars=24000 txChars=12000 inPending=1 outPending=0 dropped=0 backpressure=0 inboundOverflow=0 diagnosticOverflow=0 inputAgeMs=4.2 transportResets=0 sessionRestarts=0
```

Runner据此计算消息/字符速率、queue P95/max、input age、overflow/backpressure/recovery 等诊断。Counter应是单调累计值；发生 reset或字段缺失时对应 rate会 unavailable，而不是自动修补。

## Output markers

```text
THREE_UNITY_PERF_PROBE_STARTED
THREE_UNITY_PERF_READY
THREE_UNITY_PERF_MEASUREMENT_STARTED
THREE_UNITY_PERF_CHECKPOINT
THREE_UNITY_PERF_RESULT
```

Bridge log parser只读取 measurement-start 和 result marker之间的 `THREE_UNITY_BRIDGE_PERF` 行，避免把启动噪声混入稳定窗口。

## Compatibility and verified scope

- `package.json` declares Unity `2021.3`.
- Unity `6000.3.22f1` batchmode compilation has passed for this package.
- Unity `2021.3` compatibility has only been reviewed statically through the conditional API paths; it has not been compiled or run with a 2021.3 editor in the current verification.
- The repository's Web smoke does not exercise a real Unity Player.
- PresentMon parsing has fixture coverage, but no real PresentMon ETW capture was part of the current verification.

These limits should remain visible in benchmark reports until the corresponding real Player/environment has been exercised.
