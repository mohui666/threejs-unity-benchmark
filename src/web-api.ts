export type WebMetricDirection = "lower" | "higher" | "zero" | "informational";

export interface ThreeUnityWebBenchmarkApi {
  setMetric(name: string, value: number, options?: { unit?: string; direction?: WebMetricDirection }): void;
  checkpoint(name: string, value?: unknown): void;
}

export interface ThreeRendererLike {
  info: {
    render: {
      calls: number;
      triangles: number;
      points: number;
      lines: number;
    };
    memory: {
      geometries: number;
      textures: number;
    };
    programs?: ArrayLike<unknown> | null;
  };
}

/**
 * Publishes Three.js renderer.info through the benchmark page probe.
 * Call this after a representative render; it does not mutate the renderer.
 */
export function publishThreeRendererInfo(renderer: ThreeRendererLike): void {
  const api = benchmarkApi();
  const render = renderer.info.render;
  const memory = renderer.info.memory;
  api.setMetric("render.three.draw_calls", render.calls, { unit: "count/frame", direction: "lower" });
  api.setMetric("render.three.triangles", render.triangles, { unit: "count/frame", direction: "informational" });
  api.setMetric("render.three.points", render.points, { unit: "count/frame", direction: "informational" });
  api.setMetric("render.three.lines", render.lines, { unit: "count/frame", direction: "informational" });
  api.setMetric("render.three.geometries", memory.geometries, { unit: "count", direction: "lower" });
  api.setMetric("render.three.textures", memory.textures, { unit: "count", direction: "lower" });
  if (renderer.info.programs) {
    api.setMetric("render.three.programs", renderer.info.programs.length, { unit: "count", direction: "lower" });
  }
}

export function benchmarkCheckpoint(name: string, value: unknown = true): void {
  benchmarkApi().checkpoint(name, value);
}

function benchmarkApi(): ThreeUnityWebBenchmarkApi {
  const candidate = (globalThis as typeof globalThis & {
    __THREE_UNITY_PERF__?: ThreeUnityWebBenchmarkApi;
  }).__THREE_UNITY_PERF__;
  if (!candidate) throw new Error("Three Unity benchmark page probe is not installed");
  return candidate;
}
