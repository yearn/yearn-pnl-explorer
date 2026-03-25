/**
 * Pagination & retry utilities for external API requests.
 * Used by Kong REST fetchers and any paginated endpoint.
 */

const DEFAULT_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

interface FetchAllPagesOpts<T> {
  /** Extract items from a response page */
  extract: (json: unknown) => T[];
  /** Determine the next page URL from the response, or null if done */
  nextPage?: (json: unknown, currentUrl: string) => string | null;
  /** Maximum pages to fetch (safety valve) */
  maxPages?: number;
  /** Delay between page requests in ms */
  delayMs?: number;
  /** Number of retry attempts per request */
  retries?: number;
  /** Custom headers */
  headers?: Record<string, string>;
}

/**
 * Fetch all pages from a paginated REST endpoint.
 * Handles retry with exponential backoff and 429 rate limiting.
 */
export async function fetchAllPages<T>(url: string, opts: FetchAllPagesOpts<T>): Promise<T[]> {
  const { extract, nextPage, maxPages = 100, delayMs = 0, retries = DEFAULT_RETRIES, headers } = opts;

  const fetchPage = async (currentUrl: string, page: number, acc: T[]): Promise<T[]> => {
    if (page >= maxPages) return acc;
    const json = await fetchWithRetry(currentUrl, { retries, headers });
    const items = extract(json);
    const newAcc = [...acc, ...items];

    if (!nextPage) return newAcc;
    const nextUrl = nextPage(json, currentUrl);
    if (!nextUrl) return newAcc;

    if (delayMs > 0) {
      await sleep(delayMs);
    }
    return fetchPage(nextUrl, page + 1, newAcc);
  };

  return fetchPage(url, 0, []);
}

/**
 * Fetch a single URL with exponential backoff retry.
 * Respects Retry-After headers on 429 responses.
 */
export async function fetchWithRetry(url: string, opts?: { retries?: number; headers?: Record<string, string> }): Promise<unknown> {
  const maxAttempts = (opts?.retries ?? DEFAULT_RETRIES) + 1;

  const attempt = async (n: number): Promise<unknown> => {
    const res = await fetch(url, {
      headers: opts?.headers,
    });

    if (res.ok) {
      return res.json();
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : INITIAL_BACKOFF_MS * 2 ** (n - 1);
      if (n < maxAttempts) {
        console.warn(`Rate limited (429), waiting ${waitMs}ms before retry ${n}/${maxAttempts - 1}`);
        await sleep(waitMs);
        return attempt(n + 1);
      }
    }

    if (res.status >= 500 && n < maxAttempts) {
      const backoff = INITIAL_BACKOFF_MS * 2 ** (n - 1);
      console.warn(`Server error ${res.status}, retrying in ${backoff}ms (${n}/${maxAttempts - 1})`);
      await sleep(backoff);
      return attempt(n + 1);
    }

    throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
  };

  return attempt(1);
}

/**
 * Generic retry wrapper with exponential backoff.
 * Works with any async function (GraphQL POST, RPC calls, etc).
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, opts?: { retries?: number; label?: string }): Promise<T> {
  const maxAttempts = (opts?.retries ?? DEFAULT_RETRIES) + 1;

  const attempt = async (n: number, lastError: Error | null): Promise<T> => {
    if (n > maxAttempts) {
      throw lastError ?? new Error("All retry attempts failed");
    }
    try {
      return await fn();
    } catch (err) {
      const error = err as Error;
      if (n < maxAttempts) {
        const backoff = INITIAL_BACKOFF_MS * 2 ** (n - 1);
        const label = opts?.label || "request";
        console.warn(`${label} failed: ${error.message}, retrying in ${backoff}ms (${n}/${maxAttempts - 1})`);
        await sleep(backoff);
      }
      return attempt(n + 1, error);
    }
  };

  return attempt(1, null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
