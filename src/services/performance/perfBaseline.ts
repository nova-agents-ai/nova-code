/** Performance baseline helpers for M6.5 release-readiness checks. */

export interface PerformanceMetric {
  readonly name: string;
  readonly runs: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly maxMs: number;
  readonly avgMs: number;
}

export interface MeasureMetricParams {
  readonly name: string;
  readonly runs: number;
  readonly task: () => Promise<void>;
}

/** Measure one async task repeatedly and summarize latency in milliseconds. */
export async function measurePerformanceMetric(
  params: MeasureMetricParams,
): Promise<PerformanceMetric> {
  validateRuns(params.runs);
  let durations: readonly number[] = [];
  for (let index = 0; index < params.runs; index += 1) {
    const startedAt = performance.now();
    await params.task();
    durations = [...durations, performance.now() - startedAt];
  }
  return summarizePerformanceMetric(params.name, durations);
}

function validateRuns(runs: number): void {
  if (!Number.isInteger(runs) || runs <= 0) {
    throw new Error(`runs must be a positive integer, got ${runs}`);
  }
}

function summarizePerformanceMetric(name: string, durations: readonly number[]): PerformanceMetric {
  if (durations.length === 0) {
    throw new Error("durations must not be empty");
  }
  const sorted = [...durations].sort((left, right) => left - right);
  const median = getMedian(sorted);
  const sum = durations.reduce((total, duration) => total + duration, 0);
  return {
    name,
    runs: durations.length,
    minMs: roundMs(sorted[0] ?? 0),
    medianMs: roundMs(median),
    maxMs: roundMs(sorted.at(-1) ?? 0),
    avgMs: roundMs(sum / durations.length),
  };
}

function getMedian(sortedDurations: readonly number[]): number {
  const middle = Math.floor(sortedDurations.length / 2);
  const right = sortedDurations[middle] ?? 0;
  if (sortedDurations.length % 2 === 1) return right;
  const left = sortedDurations[middle - 1] ?? right;
  return (left + right) / 2;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}
