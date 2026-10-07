// Dated pricing table (004 research R10) — the single source for the runtime per-conversation
// budget (005 FR-510/512) and the evaluation harness. Costs are ESTIMATES from token counts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LlmUsage } from "../ports/llm-port";

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

export const PRICING_PATH = fileURLToPath(new URL("./pricing.json", import.meta.url));

export function loadPricing(path = PRICING_PATH): PricingTable {
  const raw = JSON.parse(readFileSync(path, "utf8")) as PricingTable;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.asOf)) throw new Error(`${path}: asOf must be YYYY-MM-DD`);
  if (!raw.usdPerMTok || typeof raw.usdPerMTok !== "object") {
    throw new Error(`${path}: usdPerMTok missing`);
  }
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

/** FR-512: a configured model without a price would make the budget unenforceable. */
export function assertPriced(table: PricingTable, models: string[]): void {
  const missing = models.filter((m) => priceFor(table, m) === null);
  if (missing.length > 0) {
    throw new Error(
      `no price for model(s) ${missing.join(", ")} in the pricing table dated ${table.asOf} — add them to src/llm/pricing.json`,
    );
  }
}

const warned = new Set<string>();

/** USD for one usage record, or null (with one warning per model) when the model is unknown. */
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

/** What the same tokens would cost if nothing were cached (cache reads/writes at plain input). */
export function uncachedEquivalentUsd(
  table: PricingTable,
  model: string,
  usage: LlmUsage,
): number | null {
  const price = priceFor(table, model);
  if (!price) return null;
  const perTok = 1 / 1_000_000;
  return (
    (usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens) * price.input * perTok +
    usage.outputTokens * price.output * perTok
  );
}
