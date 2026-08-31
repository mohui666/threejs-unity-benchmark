import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page, type ViewportSize } from "playwright";

export interface WebReadyConfig {
  selector?: string;
  expression?: string;
  delayMs?: number;
  timeoutMs?: number;
}

export interface WebBrowserConfig {
  channel?: string;
  executablePath?: string;
  headless?: boolean;
  deviceScaleFactor?: number;
  args?: string[];
}

export interface WebScenarioContext {
  page: Page;
  durationMs: number;
  seed: number;
  parameters: Record<string, unknown>;
  signal: AbortSignal;
}

export interface WebScenarioModule {
  prepare?: (context: WebScenarioContext) => Promise<void> | void;
  run?: (context: WebScenarioContext) => Promise<void> | void;
  cleanup?: (context: WebScenarioContext) => Promise<void> | void;
  validate?: (context: WebScenarioContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface WebCollectionOptions {
  url: string;
  warmupMs: number;
  durationMs: number;
  viewport: ViewportSize;
  browser?: WebBrowserConfig;
  ready?: WebReadyConfig;
  scenarioPath?: string;
  scenarioParameters?: Record<string, unknown>;
  seed?: number;
  onMeasurementStart?: (
    processIds: number[],
    processes: Array<{ id: number; type: string; cpuTimeSeconds: number }>,
  ) => Promise<void> | void;
  onMeasurementEnd?: () => Promise<void> | void;
}

export interface NetworkTotals {
  requestCount: number;
  requestBodyBytes: number;
  requestHeadersBytes: number;
  responseBodyBytes: number;
  responseHeadersBytes: number;
  byResourceType: Record<string, { requests: number; responseBodyBytes: number }>;
}

export interface WebCollectionResult {
  collector: "playwright-cdp";
  browserVersion: string;
  browserSystemInfo: Record<string, unknown> | null;
  browserProcesses: Array<{ id: number; type: string; cpuTimeSeconds: number }>;
  processIds: number[];
  startedAt: string;
  readyMs: number;
  durationMs: number;
  probe: WebProbeSnapshot;
  cdp: {
    availableMetrics: string[];
    start: Record<string, number>;
    end: Record<string, number>;
    delta: Record<string, number>;
  };
  network: NetworkTotals;
  scenario: Record<string, unknown>;
  consoleErrors: string[];
  pageErrors: string[];
  warnings: string[];
}

export interface WebProbeSnapshot {
  availableEntryTypes: string[];
  frameIntervalsMs: number[];
  longTasks: Array<{ startTime: number; duration: number }>;
  longAnimationFrames: Array<{ startTime: number; duration: number }>;
  eventTimings: Array<{ name: string; startTime: number; duration: number; interactionId: number }>;
  paints: Record<string, number>;
  largestContentfulPaintMs: number | null;
  cumulativeLayoutShift: number;
  navigation: Record<string, number | string> | null;
  resources: Array<Record<string, number | string>>;
  customMetrics: Record<string, Array<{ atMs: number; value: number; unit: string; direction: string }>>;
  checkpoints: Array<{ atMs: number; name: string; value: unknown }>;
  memory: { status: "measured"; bytes: number } | { status: "unavailable"; reason: string };
}

const probeSource = String.raw`(() => {
  const makeState = () => ({
    origin: performance.now(),
    previousFrame: null,
    frames: [],
    longTasks: [],
    longAnimationFrames: [],
    eventTimings: [],
    paints: {},
    lcp: null,
    cls: 0,
    customMetrics: {},
    checkpoints: []
  });
  let state = makeState();
  const availableEntryTypes = Array.from(PerformanceObserver.supportedEntryTypes || []);

  const observe = (type, callback) => {
    if (!availableEntryTypes.includes(type)) return;
    const observer = new PerformanceObserver((list) => callback(list.getEntries()));
    observer.observe({ type, buffered: true });
  };

  observe('longtask', (entries) => {
    for (const entry of entries) state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
  });
  observe('long-animation-frame', (entries) => {
    for (const entry of entries) state.longAnimationFrames.push({ startTime: entry.startTime, duration: entry.duration });
  });
  observe('event', (entries) => {
    for (const entry of entries) state.eventTimings.push({
      name: entry.name,
      startTime: entry.startTime,
      duration: entry.duration,
      interactionId: entry.interactionId || 0
    });
  });
  observe('paint', (entries) => {
    for (const entry of entries) state.paints[entry.name] = entry.startTime;
  });
  observe('largest-contentful-paint', (entries) => {
    const entry = entries[entries.length - 1];
    if (entry) state.lcp = entry.startTime;
  });
  observe('layout-shift', (entries) => {
    for (const entry of entries) if (!entry.hadRecentInput) state.cls += entry.value;
  });

  const frame = (timestamp) => {
    if (state.previousFrame !== null) state.frames.push(timestamp - state.previousFrame);
    state.previousFrame = timestamp;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  const api = {
    reset() {
      state = makeState();
    },
    setMetric(name, value, options = {}) {
      if (!Number.isFinite(value)) throw new TypeError('Custom metric value must be finite');
      const series = state.customMetrics[name] || (state.customMetrics[name] = []);
      series.push({
        atMs: performance.now() - state.origin,
        value,
        unit: options.unit || 'count',
        direction: options.direction || 'informational'
      });
    },
    checkpoint(name, value = true) {
      state.checkpoints.push({ atMs: performance.now() - state.origin, name, value });
    },
    async snapshot() {
      const navigationEntry = performance.getEntriesByType('navigation')[0];
      const navigation = navigationEntry ? navigationEntry.toJSON() : null;
      const resources = performance.getEntriesByType('resource').map((entry) => entry.toJSON());
      let memory;
      if (crossOriginIsolated && typeof performance.measureUserAgentSpecificMemory === 'function') {
        const measured = await performance.measureUserAgentSpecificMemory();
        memory = { status: 'measured', bytes: measured.bytes };
      } else {
        memory = {
          status: 'unavailable',
          reason: crossOriginIsolated
            ? 'measureUserAgentSpecificMemory is not supported by this browser'
            : 'measureUserAgentSpecificMemory requires a cross-origin-isolated page'
        };
      }
      return {
        availableEntryTypes,
        frameIntervalsMs: state.frames.slice(),
        longTasks: state.longTasks.slice(),
        longAnimationFrames: state.longAnimationFrames.slice(),
        eventTimings: state.eventTimings.slice(),
        paints: { ...state.paints },
        largestContentfulPaintMs: state.lcp,
        cumulativeLayoutShift: state.cls,
        navigation,
        resources,
        customMetrics: structuredClone(state.customMetrics),
        checkpoints: structuredClone(state.checkpoints),
        memory
      };
    }
  };
  Object.defineProperty(globalThis, '__THREE_UNITY_PERF__', { value: api, configurable: false });
})();`;

export async function collectWeb(options: WebCollectionOptions): Promise<WebCollectionResult> {
  const startedAt = new Date().toISOString();
  const collectionStarted = performance.now();
  const browser = await launchBrowser(options.browser);
  const context = await browser.newContext({
    viewport: options.viewport,
    deviceScaleFactor: options.browser?.deviceScaleFactor ?? 1,
  });
  await context.addInitScript({ content: probeSource });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const warnings: string[] = [];
  const networkRequests: Array<Promise<void>> = [];
  const network: NetworkTotals = {
    requestCount: 0,
    requestBodyBytes: 0,
    requestHeadersBytes: 0,
    responseBodyBytes: 0,
    responseHeadersBytes: 0,
    byResourceType: {},
  };

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfinished", (request) => {
    networkRequests.push((async () => {
      const sizes = await request.sizes();
      const resourceType = request.resourceType();
      network.requestCount += 1;
      network.requestBodyBytes += sizes.requestBodySize;
      network.requestHeadersBytes += sizes.requestHeadersSize;
      network.responseBodyBytes += sizes.responseBodySize;
      network.responseHeadersBytes += sizes.responseHeadersSize;
      const group = network.byResourceType[resourceType] ?? { requests: 0, responseBodyBytes: 0 };
      group.requests += 1;
      group.responseBodyBytes += sizes.responseBodySize;
      network.byResourceType[resourceType] = group;
    })().catch((error: unknown) => {
      warnings.push(`Network size unavailable for ${request.url()}: ${messageOf(error)}`);
    }));
  });

  const pageSession = await context.newCDPSession(page);
  await pageSession.send("Performance.enable");
  let browserSession: Awaited<ReturnType<Browser["newBrowserCDPSession"]>> | null = null;
  let systemInfo: Record<string, unknown> | null = null;
  let browserProcesses: Array<{ id: number; type: string; cpuTimeSeconds: number }> = [];

  try {
    browserSession = await browser.newBrowserCDPSession();
    systemInfo = await browserSession.send("SystemInfo.getInfo") as Record<string, unknown>;
  } catch (error) {
    warnings.push(`CDP SystemInfo is unavailable: ${messageOf(error)}`);
  }

  const controller = new AbortController();
  const scenario = await loadScenario(options.scenarioPath);
  const scenarioContext: WebScenarioContext = {
    page,
    durationMs: options.durationMs,
    seed: options.seed ?? 1,
    parameters: options.scenarioParameters ?? {},
    signal: controller.signal,
  };

  try {
    await page.goto(options.url, { waitUntil: "load", timeout: options.ready?.timeoutMs ?? 30_000 });
    await waitUntilReady(page, options.ready);
    await scenario.prepare?.(scenarioContext);
    const readyMs = performance.now() - collectionStarted;
    await page.waitForTimeout(options.warmupMs);

    if (browserSession) {
      const response = await browserSession.send("SystemInfo.getProcessInfo") as {
        processInfo: Array<{ id: number; type: string; cpuTime: number }>;
      };
      browserProcesses = response.processInfo.map((process) => ({
        id: process.id,
        type: process.type,
        cpuTimeSeconds: process.cpuTime,
      }));
    }
    const processIds = browserProcesses.map((process) => process.id);

    await options.onMeasurementStart?.(processIds, browserProcesses);
    await page.evaluate(() => {
      (globalThis as unknown as { __THREE_UNITY_PERF__: { reset(): void } }).__THREE_UNITY_PERF__.reset();
    });
    const cdpStart = metricsToRecord(await pageSession.send("Performance.getMetrics") as CdpMetricsResponse);

    let scenarioFailure: unknown;
    const scenarioRun = Promise.resolve(scenario.run?.(scenarioContext)).catch((error: unknown) => {
      scenarioFailure = error;
    });
    await page.waitForTimeout(options.durationMs);
    controller.abort();
    await Promise.race([scenarioRun, page.waitForTimeout(1_000)]);
    if (scenarioFailure) throw scenarioFailure;

    await options.onMeasurementEnd?.();
    const cdpEnd = metricsToRecord(await pageSession.send("Performance.getMetrics") as CdpMetricsResponse);
    const probe = await page.evaluate(async () => {
      return await (globalThis as unknown as { __THREE_UNITY_PERF__: { snapshot(): Promise<WebProbeSnapshot> } })
        .__THREE_UNITY_PERF__.snapshot();
    });
    const scenarioResult = await scenario.validate?.(scenarioContext) ?? {};
    await Promise.all(networkRequests);

    return {
      collector: "playwright-cdp",
      browserVersion: browser.version(),
      browserSystemInfo: systemInfo,
      browserProcesses,
      processIds,
      startedAt,
      readyMs,
      durationMs: options.durationMs,
      probe,
      cdp: {
        availableMetrics: Object.keys(cdpEnd).sort(),
        start: cdpStart,
        end: cdpEnd,
        delta: metricDelta(cdpStart, cdpEnd),
      },
      network,
      scenario: scenarioResult,
      consoleErrors,
      pageErrors,
      warnings,
    };
  } finally {
    controller.abort();
    await scenario.cleanup?.(scenarioContext);
    await pageSession.detach();
    await browserSession?.detach();
    await context.close();
    await browser.close();
  }
}

async function launchBrowser(config: WebBrowserConfig | undefined): Promise<Browser> {
  const launchOptions: Parameters<typeof chromium.launch>[0] = {
    headless: config?.headless ?? false,
    args: config?.args ?? [],
  };
  if (config?.channel) launchOptions.channel = config.channel;
  if (config?.executablePath) launchOptions.executablePath = config.executablePath;
  return await chromium.launch(launchOptions);
}

async function waitUntilReady(page: Page, ready: WebReadyConfig | undefined): Promise<void> {
  const timeout = ready?.timeoutMs ?? 30_000;
  if (ready?.selector) await page.waitForSelector(ready.selector, { timeout });
  if (ready?.expression) {
    await page.waitForFunction(`() => Boolean(${ready.expression})`, undefined, { timeout });
  }
  if (ready?.delayMs) await page.waitForTimeout(ready.delayMs);
}

async function loadScenario(path: string | undefined): Promise<WebScenarioModule> {
  if (!path) return {};
  const loaded = await import(`${pathToFileURL(path).href}?run=${Date.now()}`) as WebScenarioModule & {
    default?: WebScenarioModule;
  };
  return loaded.default ?? loaded;
}

interface CdpMetricsResponse {
  metrics: Array<{ name: string; value: number }>;
}

function metricsToRecord(response: CdpMetricsResponse): Record<string, number> {
  return Object.fromEntries(response.metrics.map((metric) => [metric.name, metric.value]));
}

function metricDelta(start: Record<string, number>, end: Record<string, number>): Record<string, number> {
  const cumulative = new Set([
    "TaskDuration",
    "ScriptDuration",
    "LayoutDuration",
    "RecalcStyleDuration",
    "V8CompileDuration",
    "LayoutCount",
    "RecalcStyleCount",
  ]);
  return Object.fromEntries([...cumulative]
    .filter((name) => start[name] !== undefined && end[name] !== undefined)
    .map((name) => [name, end[name]! - start[name]!]));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
