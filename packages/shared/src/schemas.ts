/**
 * Zod schemas for external API response validation.
 * Validates Kong REST responses at ingestion time for early schema drift detection.
 */
import { z } from "zod";

/** Coerce null to undefined so .default() kicks in */
const nullToUndef = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === null ? undefined : v), schema);

/** Kong REST vault shape */
export const KongVaultRESTSchema = z
  .object({
    address: z.string(),
    name: nullToUndef(z.string().default("")),
    chainId: z.number(),
    apiVersion: nullToUndef(z.string().default("")),
    v3: nullToUndef(z.boolean().default(false)),
    yearn: nullToUndef(z.boolean().default(true)),
    vaultType: nullToUndef(z.number().default(0)),
    tvl: nullToUndef(
      z
        .object({
          close: nullToUndef(z.number().default(0)),
          blockTime: nullToUndef(z.string().default("")),
        })
        .default(() => ({ close: 0, blockTime: "" })),
    ),
    totalAssets: nullToUndef(z.string().default("0")),
    totalIdle: nullToUndef(z.string().default("0")),
    asset: nullToUndef(
      z.object({
        address: z.string(),
        symbol: nullToUndef(z.string().default("")),
        decimals: nullToUndef(z.number().default(18)),
      }),
    ).optional(),
    debts: nullToUndef(
      z
        .array(
          z.object({
            strategy: z.string(),
            currentDebt: nullToUndef(z.string().default("0")),
            currentDebtUsd: nullToUndef(z.number().default(0)),
            maxDebt: nullToUndef(z.string().default("0")),
          }),
        )
        .default([]),
    ),
    fees: nullToUndef(
      z
        .object({
          managementFee: nullToUndef(z.number().default(0)),
          performanceFee: nullToUndef(z.number().default(0)),
        })
        .default(() => ({ managementFee: 0, performanceFee: 0 })),
    ),
    meta: nullToUndef(
      z
        .object({
          isRetired: nullToUndef(z.boolean().default(false)),
        })
        .default(() => ({ isRetired: false })),
    ),
    strategies: nullToUndef(z.array(z.string()).default([])),
  })
  .passthrough();

export type KongVaultREST = z.infer<typeof KongVaultRESTSchema>;

/** Kong REST vault report shape */
export const KongReportRESTSchema = z
  .object({
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
  })
  .passthrough();

export type KongReportREST = z.infer<typeof KongReportRESTSchema>;

/** Kong REST transfer shape */
export const KongTransferRESTSchema = z
  .object({
    sender: z.string(),
    receiver: z.string(),
    valueUsd: z.number().optional().default(0),
    blockTime: z.string().optional().default("0"),
    transactionHash: z.string().optional().default(""),
  })
  .passthrough();

export type KongTransferREST = z.infer<typeof KongTransferRESTSchema>;

/**
 * Validate an array of items against a schema, logging warnings for failures.
 * Returns only successfully parsed items.
 */
export function validateArray<T>(items: unknown[], schema: z.ZodType<T>, label: string): T[] {
  const { results, warnings } = items.reduce<{ results: T[]; warnings: number }>(
    (acc, item) => {
      const parsed = schema.safeParse(item);
      if (parsed.success) {
        return { results: [...acc.results, parsed.data], warnings: acc.warnings };
      }
      const newWarnings = acc.warnings + 1;
      if (newWarnings <= 3) {
        console.warn(`  ${label} validation warning: ${parsed.error.issues[0]?.message}`);
      }
      return { results: acc.results, warnings: newWarnings };
    },
    { results: [], warnings: 0 },
  );
  if (warnings > 3) {
    console.warn(`  ... and ${warnings - 3} more ${label} validation warnings`);
  }
  return results;
}
