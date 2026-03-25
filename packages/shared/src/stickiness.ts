/**
 * TVL stickiness scoring algorithm.
 * Measures how stable a vault's TVL is over time.
 */

export interface StickinessResult {
  score: number;
  grade: string;
  dataPoints: number;
}

const GRADES = [
  { min: 80, label: "Strong" },
  { min: 60, label: "Moderate" },
  { min: 40, label: "Weak" },
  { min: 0, label: "Volatile" },
] as const;

function gradeFor(score: number): string {
  return GRADES.find((g) => score >= g.min)?.label ?? "Volatile";
}

/**
 * Compute stickiness score from a time-series of TVL values.
 * Returns null if insufficient data (fewer than 3 points).
 *
 * Score 0-100 where:
 *   100 = perfectly stable TVL
 *   0   = highly volatile or declining
 *
 * Formula: 100 - (CV * 200) - (maxDrawdown * 100)
 *   CV = coefficient of variation (stddev / mean)
 *   maxDrawdown = worst peak-to-trough decline as fraction
 */
export function computeStickiness(values: number[]): StickinessResult | null {
  if (values.length < 3) return null;

  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean < 1000) return { score: 0, grade: "Dust", dataPoints: values.length };

  // Coefficient of variation
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);
  const cv = stddev / mean;

  // Max drawdown (peak to trough)
  const { maxDrawdown } = values.reduce(
    (acc, v) => {
      const peak = Math.max(acc.peak, v);
      const drawdown = (peak - v) / peak;
      return { peak, maxDrawdown: Math.max(acc.maxDrawdown, drawdown) };
    },
    { peak: values[0], maxDrawdown: 0 },
  );

  const score = Math.max(0, Math.min(100, 100 - cv * 200 - maxDrawdown * 100));

  return {
    score: Math.round(score * 10) / 10,
    grade: gradeFor(score),
    dataPoints: values.length,
  };
}

/**
 * Filter a time-series to a given window (in seconds) from the latest timestamp.
 */
export function filterWindow(data: Array<{ timestamp: number; tvlUsd: number }>, windowSeconds: number): number[] {
  if (data.length === 0) return [];
  const latest = Math.max(...data.map((d) => d.timestamp));
  const cutoff = latest - windowSeconds;
  return data.filter((d) => d.timestamp >= cutoff).map((d) => d.tvlUsd);
}

export const STICKINESS_WINDOWS = {
  "30d": 30 * 86400,
  "90d": 90 * 86400,
  "365d": 365 * 86400,
} as const;
