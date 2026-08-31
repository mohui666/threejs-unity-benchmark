using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Unity.Profiling;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace ThreeUnity.Performance
{
    /// <summary>
    /// A command-line activated runtime probe. It remains completely dormant in
    /// normal Players and starts only when --three-perf-output is present.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class ThreeUnityPerformanceProbe : MonoBehaviour
    {
        private const string ProbeVersion = "0.1.0";
        private const string SchemaVersion = "1.0.0";

        private readonly Stopwatch clock = new Stopwatch();
        private readonly List<ProbeSample> samples = new List<ProbeSample>();
        private readonly List<ProbeCheckpoint> checkpoints = new List<ProbeCheckpoint>();
        private readonly List<MetricSeries> series = new List<MetricSeries>();
        private readonly List<RecorderSeries> recorders = new List<RecorderSeries>();
        private readonly FrameTiming[] frameTimings = new FrameTiming[1];

        private MetricSeries updateInterval;
        private MetricSeries cpuFrameTime;
        private MetricSeries gpuFrameTime;
        private MetricSeries frameMainThreadTime;
        private MetricSeries frameRenderThreadTime;
        private MetricSeries framePresentWaitTime;
        private ProbeOptions options;
        private string startedAt;
        private double measurementStartedMs;
        private double previousUpdateMs;
        private ulong previousFrameStartTimestamp;
        private bool measuring;
        private bool completed;
        private bool frameTimingEnabled = true;
        private bool ready;
        private double readyAtMs;
        private Regex readyLogPattern;
        private int measuredFrames;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        private static void Bootstrap()
        {
            var parsed = ProbeOptions.TryParse(Environment.GetCommandLineArgs());
            if (parsed == null)
                return;

            var gameObject = new GameObject("ThreeUnityPerformanceProbe");
            DontDestroyOnLoad(gameObject);
            gameObject.AddComponent<ThreeUnityPerformanceProbe>().Initialize(parsed);
        }

        private void Initialize(ProbeOptions parsed)
        {
            options = parsed;
            startedAt = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
            ready = string.IsNullOrEmpty(options.ReadyLogPattern) && options.ReadyDelayMs <= 0d;
            readyAtMs = ready ? 0d : -1d;
            if (!string.IsNullOrEmpty(options.ReadyLogPattern))
                readyLogPattern = new Regex(options.ReadyLogPattern, RegexOptions.CultureInvariant);
            Application.logMessageReceived += HandleLogMessage;
            ThreeUnityPerformance.CheckpointRecorded += HandleCheckpoint;
            CreateSeries();
            clock.Start();
            Debug.Log("THREE_UNITY_PERF_PROBE_STARTED"
                + " runId=" + options.RunId
                + " warmupMs=" + options.WarmupMs.ToString("0", CultureInfo.InvariantCulture)
                + " durationMs=" + options.DurationMs.ToString("0", CultureInfo.InvariantCulture)
                + " output=" + options.OutputPath);
        }

        private void CreateSeries()
        {
            updateInterval = AddSeries("unity.frame.update_interval_ms", "ms", "Stopwatch");
            cpuFrameTime = AddSeries("unity.frame.cpu_ms", "ms", "FrameTimingManager");
            gpuFrameTime = AddSeries("unity.frame.gpu_ms", "ms", "FrameTimingManager");
            frameMainThreadTime = AddSeries("unity.frame.main_thread_active_ms", "ms", "FrameTimingManager");
            frameRenderThreadTime = AddSeries("unity.frame.render_thread_active_ms", "ms", "FrameTimingManager");
            framePresentWaitTime = AddSeries("unity.frame.present_wait_ms", "ms", "FrameTimingManager");

#if UNITY_2022_1_OR_NEWER
            if (!FrameTimingManager.IsFeatureEnabled())
            {
                frameTimingEnabled = false;
                MarkFrameTimingUnavailable(
                    "Frame Timing Stats is disabled. Enable PlayerSettings.enableFrameTimingStats or use a Development Player.");
            }
#else
            frameMainThreadTime.MarkUnavailable("Requires Unity 2022.1 or newer.");
            frameRenderThreadTime.MarkUnavailable("Requires Unity 2022.1 or newer.");
            framePresentWaitTime.MarkUnavailable("Requires Unity 2022.1 or newer.");
#endif

            AddRecorder("unity.main_thread_ms", ProfilerCategory.Internal, "Main Thread", "ms", 0.000001d);
            AddRecorder("unity.render_thread_ms", ProfilerCategory.Internal, "Render Thread", "ms", 0.000001d);
            AddRecorder("unity.player_loop_ms", ProfilerCategory.Internal, "PlayerLoop", "ms", 0.000001d);
            AddRecorder("unity.behaviour_update_ms", ProfilerCategory.Scripts, "BehaviourUpdate", "ms", 0.000001d);
            AddRecorder("unity.fixed_behaviour_update_ms", ProfilerCategory.Scripts, "FixedBehaviourUpdate", "ms", 0.000001d);
            AddRecorder("unity.wait_for_present_ms", ProfilerCategory.Render, "Gfx.WaitForPresentOnGfxThread", "ms", 0.000001d);
            AddRecorder("unity.gc.collect_ms", ProfilerCategory.Scripts, "GC.Collect", "ms", 0.000001d);

            AddRecorder("unity.memory.system_used_bytes", ProfilerCategory.Memory, "System Used Memory", "byte", 1d);
            AddRecorder("unity.memory.total_used_bytes", ProfilerCategory.Memory, "Total Used Memory", "byte", 1d);
            AddRecorder("unity.gc.used_bytes", ProfilerCategory.Memory, "GC Used Memory", "byte", 1d);
            AddRecorder("unity.gc.reserved_bytes", ProfilerCategory.Memory, "GC Reserved Memory", "byte", 1d);
            AddRecorder("unity.gc.alloc_bytes_per_frame", ProfilerCategory.Memory, "GC Allocated In Frame", "byte/frame", 1d);

            AddRecorder("render.unity.draw_calls_per_frame", ProfilerCategory.Render, "Draw Calls Count", "count/frame", 1d);
            AddRecorder("render.unity.batches_per_frame", ProfilerCategory.Render, "Batches Count", "count/frame", 1d);
            AddRecorder("render.unity.setpass_calls_per_frame", ProfilerCategory.Render, "SetPass Calls Count", "count/frame", 1d);
            AddRecorder("render.unity.triangles_per_frame", ProfilerCategory.Render, "Triangles Count", "count/frame", 1d);
            AddRecorder("render.unity.vertices_per_frame", ProfilerCategory.Render, "Vertices Count", "count/frame", 1d);
        }

        private MetricSeries AddSeries(string name, string unit, string source)
        {
            var metric = new MetricSeries(name, unit, source);
            series.Add(metric);
            return metric;
        }

        private void AddRecorder(
            string metric,
            ProfilerCategory category,
            string recorderName,
            string unit,
            double scale)
        {
            var target = AddSeries(metric, unit, "ProfilerRecorder:" + recorderName);
            var recorder = new RecorderSeries(target, category, recorderName, scale);
            recorders.Add(recorder);
            if (!recorder.Valid)
            {
                target.MarkUnavailable("ProfilerRecorder metric '" + recorderName
                    + "' is not available in this Unity Player.");
            }
        }

        private void Update()
        {
            if (options == null || completed)
                return;

            var nowMs = clock.Elapsed.TotalMilliseconds;
            CaptureFrameTiming();
            if (!ready)
            {
                if (string.IsNullOrEmpty(options.ReadyLogPattern) && nowMs >= options.ReadyDelayMs)
                {
                    ready = true;
                    readyAtMs = nowMs;
                    Debug.Log("THREE_UNITY_PERF_READY runId=" + options.RunId + " source=delay");
                }
                else
                {
                    return;
                }
            }
            if (!measuring)
            {
                if (nowMs - readyAtMs < options.WarmupMs)
                    return;
                BeginMeasurement(nowMs);
            }

            SampleFrame(nowMs);
            if (nowMs - measurementStartedMs >= options.DurationMs)
                Complete(nowMs);
        }

        private void BeginMeasurement(double nowMs)
        {
            measuring = true;
            measurementStartedMs = nowMs;
            previousUpdateMs = nowMs;
            previousFrameStartTimestamp = 0;
            measuredFrames = 0;
            foreach (var metric in series)
                metric.Clear();
            samples.Clear();
            Debug.Log("THREE_UNITY_PERF_MEASUREMENT_STARTED runId=" + options.RunId);
        }

        private void SampleFrame(double nowMs)
        {
            var atMs = nowMs - measurementStartedMs;
            if (measuredFrames > 0)
                AddSample(updateInterval, atMs, nowMs - previousUpdateMs);
            previousUpdateMs = nowMs;
            measuredFrames++;

            foreach (var recorder in recorders)
            {
                if (!recorder.Valid || recorder.Recorder.Count == 0)
                    continue;
                AddSample(recorder.Target, atMs, recorder.Recorder.LastValue * recorder.Scale);
            }
        }

        private void CaptureFrameTiming()
        {
            if (!frameTimingEnabled)
                return;

            FrameTimingManager.CaptureFrameTimings();
            if (!measuring || FrameTimingManager.GetLatestTimings(1, frameTimings) == 0)
                return;

            var timing = frameTimings[0];
            if (timing.frameStartTimestamp != 0 && timing.frameStartTimestamp == previousFrameStartTimestamp)
                return;
            previousFrameStartTimestamp = timing.frameStartTimestamp;
            var atMs = clock.Elapsed.TotalMilliseconds - measurementStartedMs;
            if (timing.cpuFrameTime > 0d)
                AddSample(cpuFrameTime, atMs, timing.cpuFrameTime);
            if (timing.gpuFrameTime > 0d)
                AddSample(gpuFrameTime, atMs, timing.gpuFrameTime);

#if UNITY_2022_1_OR_NEWER
            if (timing.cpuMainThreadFrameTime > 0d)
                AddSample(frameMainThreadTime, atMs, timing.cpuMainThreadFrameTime);
            if (timing.cpuRenderThreadFrameTime > 0d)
                AddSample(frameRenderThreadTime, atMs, timing.cpuRenderThreadFrameTime);
            if (timing.cpuMainThreadPresentWaitTime > 0d)
                AddSample(framePresentWaitTime, atMs, timing.cpuMainThreadPresentWaitTime);
#endif
        }

        private void AddSample(MetricSeries metric, double atMs, double value)
        {
            if (!metric.Available || double.IsNaN(value) || double.IsInfinity(value))
                return;
            metric.Values.Add(value);
            samples.Add(new ProbeSample
            {
                tMs = atMs,
                metric = metric.Name,
                value = value,
                unit = metric.Unit,
                source = metric.Source,
            });
        }

        private void Complete(double nowMs)
        {
            completed = true;
            enabled = false;
            var measuredMs = nowMs - measurementStartedMs;
            StopRecorders();
            FinalizeAvailability();

            var result = new ProbeResult
            {
                schemaVersion = SchemaVersion,
                probeVersion = ProbeVersion,
                kind = "unity",
                status = "completed",
                runId = options.RunId,
                startedAt = startedAt,
                completedAt = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                warmupMs = options.WarmupMs,
                requestedDurationMs = options.DurationMs,
                measuredDurationMs = measuredMs,
                readyWaitMs = readyAtMs,
                measuredFrames = measuredFrames,
                fixedDeltaTimeMs = Time.fixedDeltaTime * 1000d,
                unityVersion = Application.unityVersion,
                productName = Application.productName,
                platform = Application.platform.ToString(),
                operatingSystem = SystemInfo.operatingSystem,
                processorType = SystemInfo.processorType,
                processorCount = SystemInfo.processorCount,
                systemMemoryMb = SystemInfo.systemMemorySize,
                graphicsDeviceName = SystemInfo.graphicsDeviceName,
                graphicsDeviceType = SystemInfo.graphicsDeviceType.ToString(),
                graphicsDeviceVersion = SystemInfo.graphicsDeviceVersion,
                graphicsMemoryMb = SystemInfo.graphicsMemorySize,
                screenWidth = Screen.width,
                screenHeight = Screen.height,
                targetFrameRate = Application.targetFrameRate,
                vSyncCount = QualitySettings.vSyncCount,
                isBatchMode = Application.isBatchMode,
                metrics = series.Select(metric => metric.Summarize(measuredFrames)).ToArray(),
                samples = samples.ToArray(),
                checkpoints = checkpoints.ToArray(),
            };

            var outputDirectory = Path.GetDirectoryName(options.OutputPath);
            if (!string.IsNullOrEmpty(outputDirectory))
                Directory.CreateDirectory(outputDirectory);
            File.WriteAllText(
                options.OutputPath,
                JsonUtility.ToJson(result, true),
                new UTF8Encoding(false));
            Debug.Log("THREE_UNITY_PERF_RESULT"
                + " runId=" + options.RunId
                + " frames=" + measuredFrames
                + " measuredMs=" + measuredMs.ToString("0.###", CultureInfo.InvariantCulture)
                + " path=" + options.OutputPath);
            Application.Quit(0);
        }

        private void FinalizeAvailability()
        {
            if (cpuFrameTime.Values.Count == 0 && cpuFrameTime.Available)
                cpuFrameTime.MarkUnavailable(FrameTimingUnavailableReason());
            if (gpuFrameTime.Values.Count == 0 && gpuFrameTime.Available)
                gpuFrameTime.MarkUnavailable("GPU frame timing returned no non-zero samples on this platform and graphics API.");
#if UNITY_2022_1_OR_NEWER
            if (frameMainThreadTime.Values.Count == 0 && frameMainThreadTime.Available)
                frameMainThreadTime.MarkUnavailable(FrameTimingUnavailableReason());
            if (frameRenderThreadTime.Values.Count == 0 && frameRenderThreadTime.Available)
                frameRenderThreadTime.MarkUnavailable(FrameTimingUnavailableReason());
            if (framePresentWaitTime.Values.Count == 0 && framePresentWaitTime.Available)
                framePresentWaitTime.MarkUnavailable("No non-zero main-thread Present wait samples were reported.");
#endif
            foreach (var recorder in recorders)
            {
                if (recorder.Target.Available && recorder.Target.Values.Count == 0)
                    recorder.Target.MarkUnavailable("ProfilerRecorder produced no samples during the measurement window.");
            }
        }

        private string FrameTimingUnavailableReason()
        {
            return "FrameTimingManager produced no samples. Enable Frame Timing Stats and use a supported Player platform.";
        }

        private void MarkFrameTimingUnavailable(string reason)
        {
            cpuFrameTime.MarkUnavailable(reason);
            gpuFrameTime.MarkUnavailable(reason);
            frameMainThreadTime.MarkUnavailable(reason);
            frameRenderThreadTime.MarkUnavailable(reason);
            framePresentWaitTime.MarkUnavailable(reason);
        }

        private void StopRecorders()
        {
            foreach (var recorder in recorders)
                recorder.Dispose();
        }

        private void OnDestroy()
        {
            Application.logMessageReceived -= HandleLogMessage;
            ThreeUnityPerformance.CheckpointRecorded -= HandleCheckpoint;
            if (!completed)
                StopRecorders();
        }

        private void HandleLogMessage(string condition, string stackTrace, LogType type)
        {
            if (ready || options == null || string.IsNullOrEmpty(options.ReadyLogPattern))
                return;
            if (readyLogPattern == null || !readyLogPattern.IsMatch(condition))
                return;
            ready = true;
            readyAtMs = clock.Elapsed.TotalMilliseconds;
            Debug.Log("THREE_UNITY_PERF_READY runId=" + options.RunId + " source=log");
        }

        private void HandleCheckpoint(string name, bool value)
        {
            if (options == null || completed)
                return;
            checkpoints.Add(new ProbeCheckpoint
            {
                tMs = clock.Elapsed.TotalMilliseconds,
                measurementTMs = measuring
                    ? clock.Elapsed.TotalMilliseconds - measurementStartedMs
                    : -1d,
                phase = measuring ? "measurement" : "warmup",
                name = name,
                value = value,
            });
            Debug.Log("THREE_UNITY_PERF_CHECKPOINT"
                + " runId=" + options.RunId
                + " name=" + name
                + " value=" + (value ? 1 : 0));
        }

        private sealed class RecorderSeries : IDisposable
        {
            public RecorderSeries(
                MetricSeries target,
                ProfilerCategory category,
                string recorderName,
                double scale)
            {
                Target = target;
                Scale = scale;
                Recorder = ProfilerRecorder.StartNew(category, recorderName, 1);
            }

            public MetricSeries Target { get; }
            public double Scale { get; }
            public ProfilerRecorder Recorder;
            public bool Valid => Recorder.Valid;

            public void Dispose()
            {
                Recorder.Dispose();
            }
        }

        private sealed class MetricSeries
        {
            public MetricSeries(string name, string unit, string source)
            {
                Name = name;
                Unit = unit;
                Source = source;
            }

            public string Name { get; }
            public string Unit { get; }
            public string Source { get; }
            public bool Available { get; private set; } = true;
            public string UnavailableReason { get; private set; } = string.Empty;
            public List<double> Values { get; } = new List<double>();

            public void Clear()
            {
                Values.Clear();
            }

            public void MarkUnavailable(string reason)
            {
                Available = false;
                UnavailableReason = reason;
                Values.Clear();
            }

            public ProbeMetricSummary Summarize(int measuredFrames)
            {
                if (!Available || Values.Count == 0)
                {
                    return new ProbeMetricSummary
                    {
                        name = Name,
                        unit = Unit,
                        source = Source,
                        status = "unavailable",
                        reason = string.IsNullOrEmpty(UnavailableReason)
                            ? "No samples were recorded."
                            : UnavailableReason,
                        sampleCount = 0,
                        coverageRatio = 0d,
                    };
                }

                var ordered = Values.OrderBy(value => value).ToArray();
                var sum = Values.Sum();
                return new ProbeMetricSummary
                {
                    name = Name,
                    unit = Unit,
                    source = Source,
                    status = "measured",
                    reason = string.Empty,
                    sampleCount = Values.Count,
                    coverageRatio = measuredFrames == 0
                        ? 0d
                        : Math.Min(1d, (double)Values.Count / measuredFrames),
                    sum = sum,
                    mean = sum / Values.Count,
                    min = ordered[0],
                    p50 = Percentile(ordered, 0.50d),
                    p95 = Percentile(ordered, 0.95d),
                    p99 = Percentile(ordered, 0.99d),
                    max = ordered[ordered.Length - 1],
                    last = Values[Values.Count - 1],
                };
            }

            private static double Percentile(double[] ordered, double percentile)
            {
                if (ordered.Length == 1)
                    return ordered[0];
                var position = (ordered.Length - 1) * percentile;
                var lower = (int)Math.Floor(position);
                var upper = (int)Math.Ceiling(position);
                if (lower == upper)
                    return ordered[lower];
                var fraction = position - lower;
                return ordered[lower] + ((ordered[upper] - ordered[lower]) * fraction);
            }
        }

        private sealed class ProbeOptions
        {
            public string OutputPath { get; private set; }
            public string RunId { get; private set; }
            public double WarmupMs { get; private set; }
            public double DurationMs { get; private set; }
            public string ReadyLogPattern { get; private set; }
            public double ReadyDelayMs { get; private set; }

            public static ProbeOptions TryParse(string[] args)
            {
                var output = ValueAfter(args, "--three-perf-output");
                if (string.IsNullOrWhiteSpace(output))
                    return null;

                return new ProbeOptions
                {
                    OutputPath = Path.GetFullPath(output),
                    RunId = ValueAfter(args, "--three-perf-run-id")
                        ?? "unity-" + DateTime.UtcNow.ToString("yyyyMMddTHHmmssfff", CultureInfo.InvariantCulture),
                    WarmupMs = ParseNonNegative(ValueAfter(args, "--three-perf-warmup-ms"), 5000d, "warmup"),
                    DurationMs = ParseNonNegative(ValueAfter(args, "--three-perf-duration-ms"), 30000d, "duration"),
                    ReadyLogPattern = ValueAfter(args, "--three-perf-ready-log-pattern"),
                    ReadyDelayMs = ParseNonNegative(ValueAfter(args, "--three-perf-ready-delay-ms"), 0d, "ready-delay"),
                };
            }

            private static string ValueAfter(string[] args, string name)
            {
                for (var index = 0; index < args.Length - 1; index++)
                {
                    if (string.Equals(args[index], name, StringComparison.Ordinal))
                        return args[index + 1];
                }
                return null;
            }

            private static double ParseNonNegative(string value, double fallback, string name)
            {
                if (value == null)
                    return fallback;
                if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)
                    || parsed < 0d)
                {
                    throw new ArgumentException("Invalid --three-perf-" + name + "-ms value: " + value);
                }
                return parsed;
            }
        }

        [Serializable]
        private sealed class ProbeResult
        {
            public string schemaVersion;
            public string probeVersion;
            public string kind;
            public string status;
            public string runId;
            public string startedAt;
            public string completedAt;
            public double warmupMs;
            public double requestedDurationMs;
            public double measuredDurationMs;
            public double readyWaitMs;
            public int measuredFrames;
            public double fixedDeltaTimeMs;
            public string unityVersion;
            public string productName;
            public string platform;
            public string operatingSystem;
            public string processorType;
            public int processorCount;
            public int systemMemoryMb;
            public string graphicsDeviceName;
            public string graphicsDeviceType;
            public string graphicsDeviceVersion;
            public int graphicsMemoryMb;
            public int screenWidth;
            public int screenHeight;
            public int targetFrameRate;
            public int vSyncCount;
            public bool isBatchMode;
            public ProbeMetricSummary[] metrics;
            public ProbeSample[] samples;
            public ProbeCheckpoint[] checkpoints;
        }

        [Serializable]
        private sealed class ProbeMetricSummary
        {
            public string name;
            public string unit;
            public string source;
            public string status;
            public string reason;
            public int sampleCount;
            public double coverageRatio;
            public double sum;
            public double mean;
            public double min;
            public double p50;
            public double p95;
            public double p99;
            public double max;
            public double last;
        }

        [Serializable]
        private sealed class ProbeSample
        {
            public double tMs;
            public string metric;
            public double value;
            public string unit;
            public string source;
        }

        [Serializable]
        private sealed class ProbeCheckpoint
        {
            public double tMs;
            public double measurementTMs;
            public string phase;
            public string name;
            public bool value;
        }
    }
}
