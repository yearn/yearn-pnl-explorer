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
export async function fetchAllPages<T>(
  url: string,
  opts: FetchAllPagesOpts<T>,
): Promise<T[]> {
  const { extract, nextPage, maxPages = 100, delayMs = 0, retries = DEFAULT_RETRIES, headers } = opts;
  const results: T[] = [];
  let currentUrl: string | null = url;
  let page = 0;

  while (currentUrl && page < maxPages) {
    const json = await fetchWithRetry(currentUrl, { retries, headers });
    const items = extract(json);
    results.push(...items);

    if (!nextPage) break;
    currentUrl = nextPage(json, currentUrl);
    page++;

    if (currentUrl && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return results;
}

/**
 * Fetch a single URL with exponential backoff retry.
 * Respects Retry-After headers on 429 responses.
 */
export async function fetchWithRetry(
  url: string,
  opts?: { retries?: number; headers?: Record<string, string> },
): Promise<unknown> {
  const maxAttempts = (opts?.retries ?? DEFAULT_RETRIES) + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      headers: opts?.headers,
    });

    if (res.ok) {
      return res.json();
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
      if (attempt < maxAttempts) {
        console.warn(`Rate limited (429), waiting ${waitMs}ms before retry ${attempt}/${maxAttempts - 1}`);
        await sleep(waitMs);
        continue;
      }
    }

    if (res.status >= 500 && attempt < maxAttempts) {
      const backoff = INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
      console.warn(`Server error ${res.status}, retrying in ${backoff}ms (${attempt}/${maxAttempts - 1})`);
      await sleep(backoff);
      continue;
    }

    throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
  }

  throw new Error(`All ${maxAttempts} attempts failed: ${url}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
