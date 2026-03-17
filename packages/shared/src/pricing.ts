/**
 * Historical token pricing interface.
 *
 * Implementations provide getPrice(chainId, tokenAddress, timestamp) → USD price.
 * Swap the provider to use a different pricing backend (DeFiLlama, your own service, etc.).
 */

export interface HistoricalPriceProvider {
  /** Fetch USD price for a token at a specific timestamp. Returns 0 if unavailable. */
  getPrice(chainId: number, tokenAddress: string, timestamp: number): Promise<number>;

  /**
   * Batch-fetch prices for multiple tokens at a single timestamp.
   * Returns Map<lowercase_address, price>.
   * Default implementation calls getPrice() individually.
   */
  getPrices(
    timestamp: number,
    tokens: { chainId: number; address: string }[],
  ): Promise<Map<string, number>>;
}

export const CHAIN_PREFIXES: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  137: "polygon",
  250: "fantom",
  8453: "base",
  42161: "arbitrum",
  747474: "katana",
  999: "hyperliquid",
  80094: "berachain",
  146: "sonic",
};

/**
 * DefiLlama Coins API provider.
 * Uses https://coins.llama.fi/prices/historical/{timestamp}/{chain}:{address}
 * Supports batch queries (multiple tokens per call).
 */
export class DefiLlamaPriceProvider implements HistoricalPriceProvider {
  private baseUrl = "https://coins.llama.fi/prices/historical";
  private searchWidth = "12h";

  async getPrice(chainId: number, tokenAddress: string, timestamp: number): Promise<number> {
    const prices = await this.getPrices(timestamp, [{ chainId, address: tokenAddress }]);
    return prices.get(tokenAddress.toLowerCase()) || 0;
  }

  async getPrices(
    timestamp: number,
    tokens: { chainId: number; address: string }[],
  ): Promise<Map<string, number>> {
    const coinKeys = tokens
      .map((t) => {
        const prefix = CHAIN_PREFIXES[t.chainId];
        return prefix ? `${prefix}:${t.address}` : null;
      })
      .filter(Boolean)
      .join(",");

    if (!coinKeys) return new Map();

    try {
      const url = `${this.baseUrl}/${timestamp}/${coinKeys}?searchWidth=${this.searchWidth}`;
      const res = await fetch(url);
      if (!res.ok) return new Map();

      const data = (await res.json()) as {
        coins: Record<string, { price: number; decimals: number; symbol: string; confidence: number }>;
      };

      const prices = new Map<string, number>();
      for (const [key, info] of Object.entries(data.coins)) {
        const addr = key.split(":")[1]?.toLowerCase();
        if (addr && info.price > 0) {
          prices.set(addr, info.price);
        }
      }
      return prices;
    } catch {
      return new Map();
    }
  }
}
