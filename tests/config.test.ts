import assert from "node:assert/strict";
import test from "node:test";
import { planRuns, starterConfig, validateConfig } from "../src/config.js";

test("starter config produces paired alternating before and after runs", () => {
  const config = starterConfig();
  config.experiment.repetitions = 3;
  const plan = planRuns(validateConfig(config));

  assert.deepEqual(plan.map((run) => [run.pairIndex, run.role]), [
    [0, "before"],
    [0, "after"],
    [1, "after"],
    [1, "before"],
    [2, "before"],
    [2, "after"],
  ]);
});

test("config rejects identical target ids", () => {
  const config = starterConfig();
  config.targets.after.id = config.targets.before.id;
  assert.throws(() => validateConfig(config), /target ids must differ/u);
});
