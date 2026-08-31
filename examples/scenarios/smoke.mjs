export async function prepare({ page }) {
  await page.waitForFunction(() => globalThis.gameReady === true);
}

export async function run({ page, durationMs, seed }) {
  await page.evaluate((value) => { globalThis.benchmarkSeed = value; }, seed);
  await page.waitForTimeout(Math.min(700, durationMs * 0.6));
  await page.evaluate(() => globalThis.__THREE_UNITY_PERF__.checkpoint("scenario-complete", true));
}

export async function validate({ page }) {
  return await page.evaluate(() => ({
    completed: globalThis.fixtureState.frame > 20 && globalThis.fixtureState.rotation > 0,
    renderedFrames: globalThis.fixtureState.frame,
    rotation: globalThis.fixtureState.rotation
  }));
}
