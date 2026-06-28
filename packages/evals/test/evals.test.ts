import { describe, expect, it } from "vitest";
import { ALL_EVALS } from "../src/index.js";

// The evals double as a CI gate: every eval must pass with zero failures.
describe("evals (factory graded by the real code)", () => {
  for (const ev of ALL_EVALS) {
    it(ev.name, async () => {
      const r = await ev.run();
      expect(r.failed, r.failures.join("\n")).toBe(0);
      expect(r.total).toBeGreaterThan(0);
    });
  }
});
