# Three.js → Unity Performance Benchmark

一个面向真实转换项目的、可复现的性能测评工具：把**原始 Three.js 版本**当作 before，把**转换后的 Unity Player**当作 after，在同一台机器、同一分辨率、同一工作负载和配对顺序下采集数据，输出机器可读结果、Markdown 报告和单文件 HTML 报告。

它不把浏览器的 `requestAnimationFrame` 直接拿去和 Unity 内部帧耗时比较。跨运行时的主结论优先来自双方都能使用的 Windows PresentMon 帧呈现数据和动态进程树 CPU/内存数据；Three.js、Unity、渲染器和桥接层指标保留为各自的诊断证据。

## 它测什么

- 帧呈现：平均 FPS、P50/P90/P95/P99/最大帧间隔、1% low、0.1% low、超预算比例、50/100 ms 长帧、卡顿段、样本覆盖率。
- CPU 与进程：整个动态进程树的单核口径 CPU、整机归一化 CPU、CPU 时间、进程数量。
- 内存：进程树工作集均值/峰值/起止值、虚拟内存和长时窗口内存增长趋势；不可获得的 private bytes 会明确标成 unavailable。
- GPU：PresentMon 能提供时的 GPU frame time；GPU 利用率和显存等已进入指标契约，但没有数据源时不会伪造成 0。
- 启动与稳定性：spawn-to-ready、崩溃/非零退出、场景完成检查点、采样缺口。
- Web 诊断：rAF、Long Task、Long Animation Frame、CDP CPU/脚本/布局、JS heap、DOM、导航、资源、FCP/LCP/CLS、自定义 Three.js 指标。
- Unity 诊断：`ProfilerRecorder`、`FrameTimingManager`、主/渲染线程、GC 分配和堆、draw calls、batches、triangles。
- Web Bridge 诊断：消息/字符速率、队列深度、背压、溢出、输入年龄、协议错误、fallback 和 recovery。
- 产物：原始 Web 分发体积、Unity 构建体积和 `.threeunity` 节点/顶点/三角形/警告统计。

完整口径和当前接线状态见 [docs/METRICS.md](docs/METRICS.md)。

## 公平比较模型

每个 repetition 形成一对相同索引的 A/B 运行：A 是原始 Three.js，B 是 Unity 转换。推荐 `runOrder: "alternating"`，顺序为 `AB, BA, AB, BA...`，用来减轻温度、后台负载和缓存随时间漂移造成的偏差。比较器按 pair index 对齐，报告每侧中位数、MAD、配对差值、配对改善百分比和固定 seed 的 bootstrap 95% 区间。

普通性能 gate 至少需要 5 对运行才能作推断；崩溃、非零退出和 `scenario_completed` 等硬约束会逐次检查。`pass` 表示**配置中的 gate 通过**，不表示每一个诊断指标都优于转换前。

为了让结论成立，两个版本还必须保持：

- 相同的测试机器、电源模式、显示器、分辨率、窗口模式和图形驱动；
- 相同的垂直同步、帧率上限、渲染质量、场景状态和随机种子；
- 相同的相机轨迹、输入序列、敌人/粒子/物理数量和完成条件；
- 除被测转换外，不在 A/B 之间混入内容或玩法差异。

## 快速开始

要求 Node.js 20 或更高版本。仓库目前按源码使用，尚未声称已发布到 npm。

```bash
npm install
npm run build
npm link
```

创建配置和场景适配器：

```bash
three-unity-perf init --out ./benchmark/benchmark.config.json
```

然后编辑生成的配置，填写原始 Three.js 服务启动方式、Unity Windows Player 路径，并把两边接到同一份确定性场景契约。也可以从 [examples/threejs-vs-unity.config.json](examples/threejs-vs-unity.config.json) 开始。
Starter config 默认把 PresentMon 设为 required，因为其中的跨运行时 frame gates 依赖共同的呈现口径；请填写实际二进制路径，或明确移除这些 gates 后再禁用该 collector。

在 Unity 项目中安装 runtime probe，构建 Player 后执行：

```bash
three-unity-perf --json doctor --config ./benchmark/benchmark.config.json
three-unity-perf --json plan --config ./benchmark/benchmark.config.json
three-unity-perf --json run --config ./benchmark/benchmark.config.json --out ./.bench-results/current
```

`plan` 只解析配置并展示实际 AB/BA 顺序，不启动目标；`doctor` 只检查该配置实际要求的目标和采集器；`run` 才会启动应用并测量。

如果不执行 `npm link`，把上面的 `three-unity-perf` 替换为 `node ./dist/cli.js` 即可。

## Unity 接入

把本仓库的 `unity-package` 作为 UPM 包安装。Git URL 示例：

```text
https://github.com/mohui666/threejs-unity-benchmark.git?path=/unity-package
```

Probe 平时完全休眠；CLI 启动 Player 时自动追加 `--three-perf-output`、run ID、warm-up 和 measurement 参数，它才会在 `BeforeSceneLoad` 创建采集对象。公平场景结束时，由 Unity 侧调用：

```csharp
using ThreeUnity.Performance;

ThreeUnityPerformance.Checkpoint("scenario-complete", true);
```

若需要等场景真正可玩后再 warm-up，可给 Unity target 配置 `ready.type: "log"`，并让游戏输出一条匹配日志。完整说明见 [unity-package/README.md](unity-package/README.md)。

## PresentMon：跨运行时帧口径

Windows 上建议启用可选的 [PresentMon](https://github.com/GameTechDev/PresentMon) collector；CLI 不下载、不搜索二进制，必须显式提供路径：

```json
{
  "presentmon": {
    "enabled": true,
    "required": true,
    "options": {
      "binaryPath": "C:/Tools/PresentMon/PresentMon.exe",
      "metricsVersion": "v2"
    }
  }
}
```

它给 before/after 提供相同的呈现口径，并产出 `frame.cadence.*` / `frame.present.*` / `gpu.frame_time_ms.*`。浏览器 rAF 与 Unity `FrameTimingManager` 仍分别放在 `web.*` 和 `unity.*`，只作 runtime-specific 诊断。

若 Unity Web Bridge 的呈现发生在 `msedgewebview2.exe` 子进程，可在 PresentMon options 中配置 `processNames`（同时包含 Player 和 WebView 进程名）。保持 `processTree` 启用，runner 会再按本次动态进程树 PID 过滤，避免混入机器上其他同名 WebView 实例。

当前仓库已经用 PresentMon v1/v2 CSV fixtures 验证了解析、主 swap chain 选择和统计归一化；**尚未在本仓库的验证过程中用真实 PresentMon 二进制完成 ETW 采集**。报告会把缺失采集器明确写成 unavailable，而不是制造数据。

## 场景适配

Web 场景模块可以导出 `prepare`、`run`、`validate`、`cleanup`：

```js
export async function prepare({ page }) {
  await page.waitForFunction(() => globalThis.gameReady === true);
}

export async function run({ page, durationMs, seed, parameters, signal }) {
  await page.evaluate(
    ({ seed, parameters }) => globalThis.runBenchmarkScenario(seed, parameters),
    { seed, parameters }
  );
  await page.evaluate(() =>
    globalThis.__THREE_UNITY_PERF__.checkpoint("scenario-complete", true)
  );
}

export async function validate({ page }) {
  return page.evaluate(() => ({ completed: globalThis.scenarioFinished === true }));
}
```

Three.js 页面还可以通过 `threejs-unity-benchmark/web` 发布 renderer 指标：

```js
import { publishThreeRendererInfo } from "threejs-unity-benchmark/web";

publishThreeRendererInfo(renderer);
```

Unity 不执行这个 JavaScript adapter，因此转换后的场景必须用相同 seed 和参数自行启动同等工作负载，并发出同名完成检查点。建议在正式测量前先手工确认 A/B 最终状态和画面内容一致。

## CLI 与 AI 调用

CLI 提供稳定的 `schemaVersion: "1.0.0"` envelope、JSON Schema、能力探测、指标目录、预演、执行、离线比较和报告重建：

```bash
three-unity-perf --json capabilities
three-unity-perf --json schema config
three-unity-perf --json metrics --priority P0
three-unity-perf --json plan --config benchmark.config.json
three-unity-perf --jsonl run --config benchmark.config.json
three-unity-perf --json compare before-run.json after-run.json --out comparison.json
three-unity-perf --json report suite.json --format html --out report.html
```

`--json` 在 stdout 只输出一个最终 envelope，运行进度写到 stderr；`--jsonl` 在 stdout 依次输出 progress event 和最终 envelope。AI/自动化应读取 `status` 和进程 exit code，不要只看 `ok`。详细契约见 [docs/AI_CLI.md](docs/AI_CLI.md)。

## 输出产物

一次 suite 的主要目录如下：

```text
.bench-results/<suite-id>/
├── suite.json
├── comparison.json
├── report.md
├── report.html
└── runs/
    └── <target-id>-<pair>/
        ├── run.json
        ├── raw.json
        ├── samples.jsonl
        ├── presentmon.csv                # 启用且可用时
        ├── *.unity-probe.json            # Unity target
        ├── *.unity-player.log            # Unity target
        └── server.log                    # CLI 启动 Web 服务时
```

`suite.json` 是完整索引，`comparison.json` 是配对统计，`samples.jsonl` 保留可审计的时间序列；HTML 报告是自包含文件，不依赖外部 CDN。

## 开发与当前验证范围

```bash
npm run check
npm run smoke:web
```

当前已验证范围：Node/TypeScript 构建与测试；真实 Chromium/Edge Web collector smoke；Unity `6000.3.22f1` batchmode 编译；PresentMon v1/v2 fixture 解析。`examples/smoke.config.json` 只是 Web-vs-Web 控制组，用于确认采集和报告链路，**不是 Three.js 转 Unity 的性能结论**。Unity `2021.3` 目前只有 API 条件编译和静态兼容检查，没有该版本编辑器的实机编译/Player 运行证据。

架构和证据边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## License

[MIT](LICENSE)

---

**English summary:** This repository runs paired, deterministic benchmarks between an original Three.js application and a converted Unity Player. Shared PresentMon/process-tree metrics are used for cross-runtime conclusions; browser and Unity internals remain diagnostic. The CLI is designed for agents and automation with versioned JSON/JSONL results, JSON Schemas, explicit exit codes, raw samples, and reproducible reports.
