import assert from "node:assert/strict";
import test from "node:test";
import {
  bootstrapMedianConfidenceInterval,
  mad,
  median,
  pairedDifferences,
  pairedPercentChanges,
  quantile,
  slowestPercentLowFps,
  summarize,
} from "../src/analytics/statistics.js";

test("median, quantile, MAD, and summary use stable definitions", () => {
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(quantile([0, 10, 20, 30], 0.25), 7.5);
  assert.equal(mad([1, 2, 4, 8, 16]), 3);
  assert.deepEqual(summarize([4, 1, 3, 2]), {
    count: 4,
    median: 2.5,
    mad: 1,
    min: 1,
    max: 4,
  });
});

test("bootstrap median confidence interval is repeatable for a fixed seed", () => {
  const values = [8, 9, 10, 11, 12, 13, 14];
  const first = bootstrapMedianConfidenceInterval(values, { iterations: 2_000, seed: 1234 });
  const second = bootstrapMedianConfidenceInterval(values, { iterations: 2_000, seed: 1234 });
  assert.deepEqual(first, second);
  assert.equal(first.level, 0.95);
  assert.ok(first.low <= median(values));
  assert.ok(first.high >= median(values));
});

test("paired helpers preserve run alignment and omit percentages for a zero baseline", () => {
  assert.deepEqual(pairedDifferences([10, 20, 30], [12, 19, 35]), [2, -1, 5]);
  assert.deepEqual(pairedPercentChanges([10, 20], [11, 18]), [10.000000000000009, -9.999999999999998]);
  assert.equal(pairedPercentChanges([0, 20], [1, 18]), undefined);
  assert.throws(() => pairedDifferences([1], [1, 2]), /equal length/);
});

test("one-percent-low FPS uses the arithmetic mean of the slowest intervals", () => {
  const intervals = new Array<number>(100).fill(10);
  intervals[98] = 20;
  intervals[99] = 40;
  assert.equal(slowestPercentLowFps(intervals, 0.01), 25);
  assert.equal(slowestPercentLowFps(intervals, 0.02), 1000 / 30);
});

test("statistics reject empty and non-finite samples", () => {
  assert.throws(() => median([]), /at least one/);
  assert.throws(() => summarize([1, Number.NaN]), /finite/);
  assert.throws(() => quantile([1], 2), /between 0 and 1/);
});
