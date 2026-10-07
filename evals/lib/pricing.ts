// Dated pricing table (research R10). Costs are ESTIMATES from token counts; the table is
// maintained by hand with its date and the report labels the number as an estimate.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LlmUsage } from "../../src/ports/llm-port";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PricingTable {
  asOf: string;
  source: string;
  usdPerMTok: Record<string, ModelPrice>;
}

export const PRICING_PATH = fileURLToPath(new URL("../pricing.json", import.meta.url));

export function loadPricing(path = PRICING_PATH): PricingTable {
  const raw = JSON.parse(readFileSync(path, "utf8")) as PricingTable;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.asOf)) throw new Error(`${path}: asOf must be YYYY-MM-DD`);
  if (!raw.usdPerMTok || typeof raw.usdPerMTok !== "object")
    throw new Error(`${path}: usdPerMTok missing`);
  return raw;
}

/** Exact id first, then the longest known id the model id starts with (dated snapshots). */
export function priceFor(table: PricingTable, model: string): ModelPrice | null {
  if (table.usdPerMTok[model]) return table.usdPerMTok[model];
  const match = Object.keys(table.usdPerMTok)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return match ? table.usdPerMTok[match] : null;
}

const warned = new Set<string>();

/** USD for one execution's usage, or null (with one warning per model) when the model is unknown. */
export function costUsd(
  table: PricingTable,
  model: string,
  usage: LlmUsage,
  warn: (message: string) => void = console.warn,
): number | null {
  const price = priceFor(table, model);
  if (!price) {
    if (!warned.has(model)) {
      warned.add(model);
      warn(
        `pricing: no entry for model "${model}" in the table dated ${table.asOf} — cost reported as n/a`,
      );
    }
    return null;
  }
  const perTok = 1 / 1_000_000;
  return (
    usage.inputTokens * price.input * perTok +
    usage.outputTokens * price.output * perTok +
    usage.cacheReadTokens * price.cacheRead * perTok +
    usage.cacheWriteTokens * price.cacheWrite * perTok
  );
}
