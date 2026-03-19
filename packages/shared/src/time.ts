export const WEEK_SECONDS = 7 * 86400;
export const YEAR_SECONDS = 365.25 * 24 * 3600;
export const MIN_BLOCK_TIMESTAMP = 1577836800; // 2020-01-01 — filter junk blockTime data

/** Round a unix timestamp down to Monday noon UTC of that week */
export const toMondayNoon = (ts: number): number => {
  const date = new Date(ts * 1000);
  const day = date.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - diff);
  date.setUTCHours(12, 0, 0, 0);
  const result = Math.floor(date.getTime() / 1000);
  return result > ts ? result - WEEK_SECONDS : result;
};

/** Generate weekly Monday-noon timestamps from start to end */
export const weeklyTimestamps = (startTs: number, endTs: number): number[] => {
  const start = toMondayNoon(startTs);
  const end = toMondayNoon(endTs);
  const count = Math.max(0, Math.floor((end - start) / WEEK_SECONDS) + 1);
  return Array.from({ length: count }, (_, i) => start + i * WEEK_SECONDS);
};
