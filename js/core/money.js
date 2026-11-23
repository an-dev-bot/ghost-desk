// Cost model per market. Pure functions: every number the trade sheet shows comes from here.
//
//   meme   1% commission + price impact by pool liquidity (same as version 0)
//   crypto 0.1% commission + 0.02% slippage
//   stock  $0 commission, pays half the bid/ask spread (max($0.01, 0.01% of price))
//   fx     $0 commission, pays half the pair's typical retail spread (FX_PAIRS)
//
// A position is {qty, cost, avg}: qty in units of the asset (base currency for fx), cost in USD
// actually paid (fees included), avg the weighted execution price in the instrument's quote currency.

export const START_CASH = 10000;
export const MEME_FEE = 0.01;
export const CRYPTO_FEE = 0.001;
export const CRYPTO_SLIP = 0.0002;

// Typical retail spreads (full spread, in price units of the pair).
export const FX_PAIRS = [
  { id: "EURUSD", base: "EUR", quote: "USD", spread: 0.0001, dp: 5, name: "Euro / Dólar" },
  { id: "GBPUSD", base: "GBP", quote: "USD", spread: 0.00015, dp: 5, name: "Libra / Dólar" },
  { id: "USDJPY", base: "USD", quote: "JPY", spread: 0.01, dp: 3, name: "Dólar / Yen" },
  { id: "AUDUSD", base: "AUD", quote: "USD", spread: 0.00012, dp: 5, name: "Dólar australiano / Dólar" },
  { id: "USDCAD", base: "USD", quote: "CAD", spread: 0.00018, dp: 5, name: "Dólar / Dólar canadiense" },
  { id: "USDCHF", base: "USD", quote: "CHF", spread: 0.00015, dp: 5, name: "Dólar / Franco suizo" },
  { id: "NZDUSD", base: "NZD", quote: "USD", spread: 0.00018, dp: 5, name: "Dólar neozelandés / Dólar" },
  { id: "USDMXN", base: "USD", quote: "MXN", spread: 0.008, dp: 4, name: "Dólar / Peso mexicano" },
  { id: "EURGBP", base: "EUR", quote: "GBP", spread: 0.00015, dp: 5, name: "Euro / Libra" },
  { id: "EURJPY", base: "EUR", quote: "JPY", spread: 0.018, dp: 3, name: "Euro / Yen" },
  { id: "GBPJPY", base: "GBP", quote: "JPY", spread: 0.025, dp: 3, name: "Libra / Yen" },
];
export const FX_BY_ID = Object.fromEntries(FX_PAIRS.map(p => [p.id, p]));

export function memeImpact(usd, liq) {
  if (!(liq > 0)) return 0.5;
  return Math.min(0.5, usd / (liq / 2));
}

export function stockSpread(px) {
  return Math.max(0.01, px * 0.0001);
}

/** Half the bid/ask gap the trader pays, in the instrument's price units. */
export function halfSpread(inst, px) {
  if (inst.m === "stock") return stockSpread(px) / 2;
  if (inst.m === "fx") return (FX_BY_ID[inst.id]?.spread ?? px * 0.0002) / 2;
  return 0;
}

/** USD value of one unit of the instrument's quote currency. */
export function quoteToUsd(inst, q) {
  if (inst.m === "fx" && inst.quote && inst.quote !== "USD") return q.quoteUsd;
  return 1;
}

function nonUsdQuote(inst) {
  return inst.m === "fx" && inst.quote && inst.quote !== "USD";
}

/**
 * Spend `usd` dollars (fees included) at live quote q = {px, liq?, quoteUsd?}.
 * Returns {qty, eff, fee, slip, impact} or null when there is no usable price.
 * slip is the dollar cost of spread / slippage / impact versus the mid price.
 */
export function quoteBuy(inst, usd, q) {
  const px = q?.px;
  if (!(px > 0) || !(usd > 0)) return null;
  if (inst.m === "meme") {
    const impact = memeImpact(usd, q.liq);
    const eff = px * (1 + impact);
    const fee = usd * MEME_FEE;
    const qty = (usd - fee) / eff;
    return { qty, eff, fee, slip: usd - fee - qty * px, impact };
  }
  if (inst.m === "crypto") {
    const eff = px * (1 + CRYPTO_SLIP);
    const fee = usd * CRYPTO_FEE;
    const qty = (usd - fee) / eff;
    return { qty, eff, fee, slip: usd - fee - qty * px, impact: CRYPTO_SLIP };
  }
  const hs = halfSpread(inst, px);
  const qu = quoteToUsd(inst, q);
  if (!(qu > 0)) return null;
  const eff = px + hs;
  const qty = usd / (eff * qu);
  return { qty, eff, fee: 0, slip: qty * hs * qu, impact: hs / px };
}

/**
 * Sell `frac` (0..1] of position pos at quote q.
 * Returns {qty, eff, fee, slip, proceeds, costPart, pl, plPct, impact}.
 */
export function quoteSell(inst, pos, frac, q) {
  const px = q?.px;
  if (!(px > 0) || !pos || !(pos.qty > 0)) return null;
  frac = Math.min(1, Math.max(0, frac));
  if (!(frac > 0)) return null;
  const qty = pos.qty * frac;
  const costPart = pos.cost * frac;
  let eff, fee = 0, slip, proceeds, impact;
  if (inst.m === "meme") {
    const gross = qty * px;
    impact = memeImpact(gross, q.liq);
    const afterImpact = gross * (1 - impact);
    fee = afterImpact * MEME_FEE;
    proceeds = afterImpact - fee;
    slip = gross * impact;
    eff = afterImpact / qty;
  } else if (inst.m === "crypto") {
    impact = CRYPTO_SLIP;
    eff = px * (1 - CRYPTO_SLIP);
    const gross = qty * eff;
    fee = gross * CRYPTO_FEE;
    proceeds = gross - fee;
    slip = qty * px * CRYPTO_SLIP;
  } else {
    const hs = halfSpread(inst, px);
    impact = hs / px;
    eff = px - hs;
    if (nonUsdQuote(inst)) {
      const qu = q.quoteUsd;
      if (!(qu > 0)) return null;
      proceeds = costPart + qty * (eff - pos.avg) * qu;
      slip = qty * hs * qu;
    } else {
      proceeds = qty * eff;
      slip = qty * hs;
    }
  }
  proceeds = Math.max(0, proceeds);
  const pl = proceeds - costPart;
  return { qty, eff, fee, slip, proceeds, costPart, pl, plPct: costPart > 0 ? pl / costPart : 0, impact };
}

/** Mark-to-market value of a position in USD at the mid / last price (no exit costs). */
export function markValue(inst, pos, q) {
  if (!pos) return 0;
  const px = q?.px;
  if (!(px > 0)) return null;
  if (nonUsdQuote(inst)) {
    if (!(q.quoteUsd > 0)) return null;
    return pos.cost + pos.qty * (px - pos.avg) * q.quoteUsd;
  }
  return pos.qty * px;
}
