// FX: Coinbase exchange rates (no key, mid rate that moves every ~30–60 s) and Coinbase daily spot
// prices for yesterday's reference (to show the real change of the day).

import { getJSON } from "./http.js";
import { FX_PAIRS, FX_BY_ID } from "../core/money.js";

const RATES = "https://api.coinbase.com/v2/exchange-rates?currency=USD";
const SPOT = "https://api.coinbase.com/v2/prices";

export function fxInst(id) {
  const p = FX_BY_ID[id];
  return { key: "fx:" + id, m: "fx", id, sym: p.base + "/" + p.quote, name: p.name, base: p.base, quote: p.quote, dp: p.dp };
}
export const FX_INSTS = FX_PAIRS.map(p => fxInst(p.id));

const CURRENCIES = [...new Set(FX_PAIRS.flatMap(p => [p.base, p.quote]))].filter(c => c !== "USD");

/** {rates: {EUR: units per USD, ...}, t} */
export async function rates() {
  const d = await getJSON(RATES, { source: "coinbase-fx" });
  const r = { USD: 1 };
  for (const c of CURRENCIES) { const v = +d?.data?.rates?.[c]; if (v > 0) r[c] = v; }
  return { rates: r, t: Date.now() };
}

/** Price of a pair and USD value of its quote currency. */
export function pairQuote(id, r) {
  const p = FX_BY_ID[id];
  const b = r[p.base], q = r[p.quote];
  if (!(b > 0) || !(q > 0)) return null;
  return { px: q / b, quoteUsd: 1 / q };
}

/** Rates of a past UTC day (one call per currency), same shape as rates(). */
export async function ratesOn(dateKey) {
  const r = { USD: 1 };
  await Promise.all(CURRENCIES.map(async c => {
    try {
      const d = await getJSON(`${SPOT}/USD-${c}/spot?date=${dateKey}`, { source: "coinbase-fx" });
      const v = +d?.data?.amount;
      if (v > 0) r[c] = v;
    } catch {}
  }));
  return r;
}
