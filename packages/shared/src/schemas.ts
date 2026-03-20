/**
 * Zod schemas for external API response validation.
 * Validates Kong REST responses at ingestion time for early schema drift detection.
 */
import { z } from "zod";

/** Kong REST vault shape */
export const KongVaultRESTSchema = z.object({
  address: z.string(),
  name: z.string(),
  chainId: z.number(),
  apiVersion: z.string().optional().default(""),
  v3: z.boolean().optional().default(false),
  yearn: z.boolean().optional().default(true),
  vaultType: z.number().optional().default(0),
  tvl: z.object({
    close: z.number().optional().default(0),
    blockTime: z.string().optional().default(""),
  }).optional().default(() => ({ close: 0, blockTime: "" })),
  totalAssets: z.string().optional().default("0"),
  totalIdle: z.string().optional().default("0"),
  asset: z.object({
    address: z.string(),
    symbol: z.string(),
    decimals: z.number(),
  }).optional(),
  debts: z.array(z.object({
    strategy: z.string(),
    currentDebt: z.string().optional().default("0"),
    currentDebtUsd: z.number().optional().default(0),
    maxDebt: z.string().optional().default("0"),
  })).optional().default([]),
  fees: z.object({
    managementFee: z.number().optional().default(0),
    performanceFee: z.number().optional().default(0),
  }).optional().default(() => ({ managementFee: 0, performanceFee: 0 })),
  meta: z.object({
    isRetired: z.boolean().optional().default(false),
  }).optional().default(() => ({ isRetired: false })),
  strategies: z.array(z.string()).optional().default([]),
}).passthrough();

export type KongVaultREST = z.infer<typeof KongVaultRESTSchema>;

/** Kong REST vault report shape */
export const KongReportRESTSchema = z.object({
  strategy: z.string().optional().default(""),
  gain: z.string().nullable().optional().default(null),
  gainUsd: z.number().nullable().optional().default(null),
  loss: z.string().nullable().optional().default(null),
  lossUsd: z.number().nullable().optional().default(null),
  totalGainUsd: z.number().nullable().optional().default(null),
  totalLossUsd: z.number().nullable().optional().default(null),
  blockTime: z.string().optional().default("0"),
  blockNumber: z.number().optional().default(0),
  transactionHash: z.string().optional().default(""),
}).passthrough();

export type KongReportREST = z.infer<typeof KongReportRESTSchema>;

/** Kong REST transfer shape */
export const KongTransferRESTSchema = z.object({
  sender: z.string(),
  receiver: z.string(),
  valueUsd: z.number().optional().default(0),
  blockTime: z.string().optional().default("0"),
  transactionHash: z.string().optional().default(""),
}).passthrough();

export type KongTransferREST = z.infer<typeof KongTransferRESTSchema>;

/**
 * Validate an array of items against a schema, logging warnings for failures.
 * Returns only successfully parsed items.
 */
export function validateArray<T>(
  items: unknown[],
  schema: z.ZodType<T>,
  label: string,
): T[] {
  const results: T[] = [];
  let warnings = 0;
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) {
      results.push(parsed.data);
    } else {
      warnings++;
      if (warnings <= 3) {
        console.warn(`  ${label} validation warning: ${parsed.error.issues[0]?.message}`);
      }
    }
  }
  if (warnings > 3) {
    console.warn(`  ... and ${warnings - 3} more ${label} validation warnings`);
  }
  return results;
}
