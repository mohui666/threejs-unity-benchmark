# Architecture

## Goal

The benchmark separates three questions that are often mixed together:

1. Did the converted Unity build execute the same workload and remain stable?
2. Did user-visible frame delivery, total CPU, and total memory improve or regress?
3. Which runtime-specific subsystem explains the change?

The first question is answered by deterministic scenarios and checkpoints. The second uses collectors that can observe both targets. The third uses browser, Unity, renderer, bridge, and artifact diagnostics without pretending that unlike counters have the same semantics.

## Data flow

```text
benchmark config
    │
    ├── run planner ── pair index + AB/BA order + deterministic seed
    │
    ├── Web target
    │     ├── optional server process
    │     ├── Playwright/Chromium page + CDP
    │     └── Web scenario adapter
    │
    └── Unity target
          ├── built Windows Player
          ├── UPM runtime probe
          └── Player/bridge log

Both target paths
    ├── dynamic process-tree sampler
    ├── optional PresentMon process/swap-chain capture
    ├── normalized MetricMeasurement + MetricSample
    └── per-run raw.json / run.json / samples.jsonl

paired comparator
    ├── run.index alignment
    ├── median + MAD
    ├── paired delta/improvement
    ├── seeded bootstrap 95% interval
    └── explicit metric gates

suite.json + comparison.json + report.md + self-contained report.html
```

## Target model

The config always has exactly two roles:

- `before`: normally `runtime: "web"`, `variant: "threejs-original"`;
- `after`: normally `runtime: "unity"`, with either `unity-native-assets` or `unity-web-bridge`.

`unity-web-bridge` means Unity hosts/presents a converted application that still owns suitable behavior in WebView/browser processes. The process-tree collector follows the target hierarchy so child cost is not intentionally excluded. Game-specific behavior belongs in the benchmark scenario and the conversion itself, not in generic collectors.

## Run lifecycle

Each planned run goes through launch, ready, warm-up, measurement, collection, cleanup, and normalization.

- A Web target may have a `launch` command for its static/dev server. Readiness can be HTTP, delay, or a page expression.
- A Unity target launches a built Player. The CLI adds probe arguments and can wait for a delay or a matching Player log line.
- Warm-up and measurement durations come from the shared experiment config.
- The Web scenario receives the configured seed and parameters. The Unity scene is responsible for applying the same contract on its side.
- Both sides must emit/produce `scenario-complete`; otherwise the stability gate can fail.
- Every repetition receives a pair index. Comparison uses this index, not file order.

## Collector boundary

### Shared collectors

`process-tree` measures the root and currently visible descendants at each sample. Its CPU and working-set measurements can be compared because the same collector and units are used for both targets.

`presentmon` is optional and Windows-only. It selects the process/swap-chain group with the most usable frame samples and normalizes presentation cadence. It is the intended headline frame source for Web-vs-Unity comparison.

### Runtime-specific collectors

The Web collector injects a page probe before application scripts, executes the workload through Playwright, and combines browser Performance APIs, CDP and network observations. These metrics use `web.*` names.

The Unity package records Unity frame, profiler, memory, render and checkpoint data. These metrics use `unity.*` and `render.unity.*` names. Browser rAF and Unity frame timing never share an ID, so they cannot silently become one cross-runtime metric.

Bridge markers and artifact inventory explain architecture cost but are not treated as a direct substitute for displayed-frame or total-process measurements.

## Metric provenance

A normalized measurement carries:

- `status`: `measured`, `unavailable`, or `invalid`;
- `value` and `unit` when measured;
- `sampleCount` and optional `coverageRatio`;
- `source`, preserving collector provenance;
- `comparable`, an explicit comparison permission;
- `reason`, explaining unavailable/invalid measurements.

The comparator accepts only finite `measured` values marked `comparable`, requires matching units within each pair, and requires each target's source to remain stable across repetitions. Missing metrics remain unavailable; they are never filled with zero.

## Statistical boundary

The comparison is paired and robust to outliers, but it does not turn a noisy desktop into a laboratory:

- A/B values are aligned by pair index.
- Each target summary uses median and median absolute deviation.
- Pair differences and percent improvements use a deterministic bootstrap 95% interval.
- Inferential gates require at least five pairs.
- Hard stability invariants are checked on every after run and do not wait for five pairs.
- `minSampleCount` and `minCoverageRatio` can make a gate inconclusive before threshold evaluation.

There is no automatic claim of gameplay, visual, input, audio, or save-data fidelity. Those must be validated separately; a faster but behaviorally different workload is not a valid conversion win.

## Failure and evidence model

The tool surfaces collector reasons and target failures instead of switching to a hidden fallback. Optional collectors can be unavailable without fabricating samples. Required target/config failures produce a nonzero exit code. Reports retain both normalized statistics and the raw collector payloads needed for audit.

Current verification includes the real Edge Web collector, three open-source Three.js games, three native-scene Players, one full-fidelity Web Bridge Player, and 40 completed formal runs across 20 pairs on Unity `6000.3.22f1`. The native-scene results remain rendering-slice evidence rather than full-game migration evidence. PresentMon 2.5.1 was exercised on the validation host, but the non-elevated session produced no ETW CSV, so shared presented-frame/GPU conclusions remain unavailable. Unity `2021.3` is declared by the UPM package but still has only static compatibility review in this repository.
