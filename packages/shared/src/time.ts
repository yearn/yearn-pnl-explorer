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
  return Math.floor(date.getTime() / 1000);
};

/** Generate weekly Monday-noon timestamps from start to end */
export const weeklyTimestamps = (startTs: number, endTs: number): number[] => {
  const weeks: number[] = [];
  let ts = toMondayNoon(startTs);
  const end = toMondayNoon(endTs);
  while (ts <= end) {
    weeks.push(ts);
    ts += WEEK_SECONDS;
  }
  return weeks;
};
