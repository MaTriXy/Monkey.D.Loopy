import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./Model.js", import.meta.url), "utf8");
const context = vm.createContext({ JSON, String, Number, Math, Array, isFinite });
vm.runInContext(source, context);

const parsed = context.parseSnapshot(JSON.stringify({
  apiVersion: "1",
  loops: [{
    id: "deploy-watch",
    status: "paused",
    health: "attention",
    latestRun: {
      runId: "default",
      status: "paused",
      health: "attention",
      integrity: "verified",
      iteration: 3,
      tokens: 120,
      usd: 0.02,
      pendingCap: "budget"
    }
  }]
}));

assert.equal(parsed.ok, true);
assert.equal(parsed.loops[0].latestRun.iteration, 3);
assert.equal(context.hasAttention(parsed.loops[0]), true);
assert.equal(context.barLabel(parsed.loops, false, ""), "L  !1");
assert.equal(context.parseSnapshot("not-json").ok, false);

console.log("Omarchy model tests passed");
