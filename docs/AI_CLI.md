# AI-friendly CLI contract

`three-unity-perf` 面向 AI agent、脚本和人工终端使用。核心原则是：一个版本化 envelope、明确的 status/exit code、可查询 schema、可预演执行顺序、原始证据路径可追溯。

## Invocation

仓库开发模式：

```bash
npm install
npm run build
node ./dist/cli.js --json capabilities
```

执行 `npm link` 后：

```bash
three-unity-perf --json capabilities
# 等价别名
threeunity-bench --json capabilities
```

全局输出选项：

- `--json`: stdout 恰好一个最终 JSON envelope；progress 写 stderr。
- `--jsonl`: stdout 输出零到多个 progress event，再输出一个最终 envelope。
- `--quiet`: 不输出 progress；最终结果不受影响。
- `--no-color`: 关闭终端颜色。
- `--json` 与 `--jsonl` 互斥。

Agent应把 stdout 当机器通道，把 stderr 当进度/诊断通道。不要从人类文本中提取 verdict。

## Final envelope

所有命令最终都使用以下结构：

```json
{
  "schemaVersion": "1.0.0",
  "command": "run",
  "ok": true,
  "status": "pass",
  "data": {},
  "artifacts": ["C:/absolute/path/suite.json"],
  "warnings": [],
  "errors": []
}
```

字段规则：

- `schemaVersion`: 先检查再解析 `data`。
- `command`: 实际执行的 command 名称。
- `status`: `pass`、`regression`、`inconclusive` 或 `error`。
- `ok`: 只在 `status === "pass"` 时为 true。性能 regression 和 inconclusive 都不是 transport/JSON 错误，但 `ok` 仍为 false。
- `data`: command-specific payload。
- `artifacts`: CLI 创建或引用的绝对路径；agent可以从这里继续读 `suite.json` / report。
- `warnings`: 可继续执行但应向用户披露的问题。
- `errors`: 阻止成功或进入 error envelope 的问题。

JSON Schema：

```bash
three-unity-perf --json schema cli-result
three-unity-perf --json schema config
three-unity-perf --json schema run
three-unity-perf --json schema comparison
```

Schema 位于 envelope 的 `data.schema`。仓库也直接提供 `schemas/*.schema.json`。

## JSONL progress

`run --jsonl` 的 progress 行示例：

```json
{"schemaVersion":"1.0.0","event":"progress","phase":"run-start","message":"Running threejs-original pair 1","runId":"threejs-original-01","targetId":"threejs-original","completedRuns":0,"totalRuns":10}
```

`phase` 当前为：

```text
suite-start
run-start
run-complete
comparison
suite-complete
```

最后一行是 final envelope，它没有 `event: "progress"`，而有 `command`、`status`、`data`、`artifacts`。一个可靠 parser 可按是否存在 `event` 区分：

```js
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  const item = JSON.parse(line);
  if (item.event === "progress") {
    console.error(`${item.phase}: ${item.message}`);
  } else {
    if (item.schemaVersion !== "1.0.0") throw new Error("Unsupported schema");
    console.log(item.status, item.artifacts);
  }
}
```

## Exit codes

| Code | Meaning | Agent action |
| ---: | --- | --- |
| 0 | pass / command success | 读取 artifacts 和关键 metrics，报告成功 |
| 1 | benchmark regression | 报告失败 gate 和证据；不要重试成“成功” |
| 2 | benchmark inconclusive | 报告缺失 pair/sample/coverage/source；修正实验后再跑 |
| 3 | 参数、配置、schema 名称或非 run 输入错误 | 修正请求；不要把它解释成性能回归 |
| 4 | `doctor` required check 失败 | 根据 `data.checks` 修复依赖/路径/目标 |
| 5 | `run` 目标启动、运行或 Unity 非零退出 | 查看 `errors` 和已有 run artifacts，修复 target |
| 6 | required collector 未完成 | 修复/启用该 collector；不要把缺测结果当作性能结论 |

脚本必须同时检查 exit code 和 envelope `status`。例如 exit 1 是一次有效执行得到的回归结论，不是 JSON 解析失败。

## Command reference

### `init`

```bash
three-unity-perf --json init --out ./benchmark/benchmark.config.json
```

创建 starter config 和同目录下的 `scenarios/benchmark.mjs`。它不会覆盖已有文件。新 scenario故意抛错，直到用户实现真实工作负载，避免无动作空跑被误判为性能结果。
Starter 中 PresentMon 是 required，因为默认 frame gates 使用共同的 `frame.cadence.*`；agent 应填写真实 binary path，不能为绕过 `doctor` 而保留 required frame gate 同时关闭 collector。

### `capabilities`

```bash
three-unity-perf --json capabilities
```

返回当前平台以及 Web、Unity、processTree、PresentMon collector 的 availability 描述和 cross-runtime boundary。建议 agent 在首次配置前调用。

### `metrics`

```bash
three-unity-perf --json metrics
three-unity-perf --json metrics --priority P0
```

返回 canonical metric definitions。Agent应从 `id` 选择 gate，不要自己猜名称、单位或 direction。

### `schema`

```bash
three-unity-perf --json schema config
```

支持 `config`、`run`、`comparison`、`cli-result`。

### `plan`

```bash
three-unity-perf --json plan --config ./benchmark.config.json
```

解析 JSON/YAML config、把相对路径解析到 config 所在目录，并返回精确的 pair index 和 AB/BA order。它不启动目标，是修改配置后的首选检查。

### `doctor`

```bash
three-unity-perf --json doctor --config ./benchmark.config.json
```

只检查 config 实际启用/要求的组件。读取 `data.ok` 和 `data.checks[]`；`optional-unavailable` 是 warning，`fail` 导致 exit 4。

### `run`

```bash
three-unity-perf --jsonl run \
  --config ./benchmark.config.json \
  --out ./.bench-results/current
```

`--out` 是精确 suite 目录；不传时使用 config output directory 下的自动 suite ID。`data` 包含：

```text
suiteId
outputDirectory
verdict
pairCount
runs
comparison
```

预演同一个 command：

```bash
three-unity-perf --json run --config ./benchmark.config.json --dry-run
```

dry-run 只返回 resolved config 和 runs，既不启动目标也不创建性能结论。

### `compare`

```bash
three-unity-perf --json compare \
  ./before-run.json \
  ./after-run.json \
  --rules ./gates.json \
  --seed 42 \
  --out ./comparison.json
```

每个 positional input 可是一个 `run.json`、run array 或含 `runs` 的 `suite.json`。`--rules` 接受 gate array 或 `{ "gates": [] }`。Pairing仍按 `run.index`，不是数组位置。

### `report`

```bash
three-unity-perf --json report ./suite.json --format markdown --out ./report.md
three-unity-perf --json report ./suite.json --format html --out ./report.html
three-unity-perf --json report ./comparison.json --format json --out ./normalized-comparison.json
```

支持 `markdown`、`html`、`json`。HTML 自包含；从 comparison-only 输入生成报告时没有 per-target run diagnostics。

## Recommended agent workflow

```text
1. capabilities
2. schema config + metrics P0
3. init（仅在没有配置时）
4. 编辑 target / scenario / collectors / gates
5. plan
6. doctor
7. run --jsonl
8. 检查 exit code + final.status
9. 读取 suite.json / comparison.json
10. 报告失败 gate、pair count、CI、sample count、coverage、warnings/errors
```

Agent不应：

- 在 `scenario_completed != 1` 时把结果描述成公平对比；
- 把 unavailable 转为 0；
- 把 Web rAF 和 Unity internal frame time合成一个百分比；
- 只看到 HTML 文件生成就宣布 benchmark pass；
- 只有 1 对 run时声称统计显著改善；
- 在没有真实 PresentMon ETW 采集时声称 shared presentation collector 已实机验证。

## Minimal decision extraction

下面的 Node 示例执行 CLI、保留 stderr 进度，并严格处理退出状态：

```js
import { spawn } from "node:child_process";

const child = spawn("three-unity-perf", [
  "--json",
  "run",
  "--config",
  "benchmark.config.json"
], { stdio: ["ignore", "pipe", "inherit"] });

let stdout = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => { stdout += chunk; });

const exitCode = await new Promise(resolve => child.on("close", resolve));
const result = JSON.parse(stdout);

if (result.schemaVersion !== "1.0.0") throw new Error("Unsupported result schema");
if (exitCode === 1) throw new Error(`Regression: ${JSON.stringify(result.data.comparison)}`);
if (exitCode === 2) throw new Error(`Inconclusive: ${result.warnings.join("; ")}`);
if (exitCode !== 0) throw new Error(result.errors.join("; ") || `CLI failed: ${exitCode}`);

console.log(result.artifacts);
```

这段逻辑只负责读取结论；它不会替代对 A/B workload 等价性的人工或项目级验收。
