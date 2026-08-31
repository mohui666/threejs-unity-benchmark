/**
 * Contract for the original Three.js page used by threejs-vs-unity.config.json.
 * The page must expose globalThis.runThreeUnityBenchmark({ seed, ...parameters }).
 * Unity must implement the same workload independently and emit the same
 * scenario-complete checkpoint through ThreeUnityPerformance.Checkpoint.
 */
export async function prepare({ page }) {
  await page.waitForFunction(() =>
    globalThis.gameReady === true
      && typeof globalThis.runThreeUnityBenchmark === "function"
  );
}

export async function run({ page, seed, parameters }) {
  const completed = await page.evaluate(async ({ runSeed, runParameters }) => {
    const result = await globalThis.runThreeUnityBenchmark({
      seed: runSeed,
      ...runParameters
    });
    globalThis.__THREE_UNITY_SCENARIO_RESULT__ = result;
    return result !== false;
  }, { runSeed: seed, runParameters: parameters });

  await page.evaluate((value) => {
    globalThis.__THREE_UNITY_PERF__.checkpoint("scenario-complete", value);
  }, completed);
}

export async function validate({ page }) {
  return await page.evaluate(() => ({
    completed: globalThis.__THREE_UNITY_SCENARIO_RESULT__ !== false
      && globalThis.__THREE_UNITY_SCENARIO_RESULT__ !== undefined,
    result: globalThis.__THREE_UNITY_SCENARIO_RESULT__ ?? null
  }));
}
