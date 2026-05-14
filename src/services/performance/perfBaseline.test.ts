/** M6.5 performance baseline helper tests. */

import { describe, expect, test } from "bun:test";
import { measurePerformanceMetric } from "./perfBaseline.ts";

describe("measurePerformanceMetric", () => {
  test("runs task N times and returns a rounded summary", async () => {
    let calls = 0;
    const metric = await measurePerformanceMetric({
      name: "unit.fake",
      runs: 3,
      task: () => {
        calls += 1;
        return Promise.resolve();
      },
    });

    expect(calls).toBe(3);
    expect(metric.name).toBe("unit.fake");
    expect(metric.runs).toBe(3);
    expect(metric.minMs).toBeGreaterThanOrEqual(0);
    expect(metric.medianMs).toBeGreaterThanOrEqual(0);
    expect(metric.maxMs).toBeGreaterThanOrEqual(0);
  });

  test("rejects invalid run count", async () => {
    await expect(
      measurePerformanceMetric({ name: "bad", runs: 0, task: () => Promise.resolve() }),
    ).rejects.toThrow(/positive integer/);
  });
});
