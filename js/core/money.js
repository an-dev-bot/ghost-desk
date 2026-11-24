// Cost model per market. Pure functions: every number the trade sheet shows comes from here.
//
//   meme   1% commission + price impact by pool liquidity (same as version 0)
//   crypto 0.1% commission + 0.02% slippage
//   stock  $0 commission, pays half the bid/ask spread (max($0.01, 0.01% of price))
//   fx     $0 commission, pays half the pair's typical retail spread (FX_PAIRS)
//
// A position is {qty, cost, avg}: qty in units of the asset (base currency for fx), cost in USD
// actually paid (fees included), avg the weighted execution price in the instrument's quote currency.

export const START_CASH = 100000;
// Starting balances offered when resetting; any other amount in [START_MIN, START_MAX] is allowed too.
export const START_CHOICES = [10000, 100000, 1000000];
export const START_MIN = 100, START_MAX = 1e9;
export const MEME_FEE = 0.01;
export const CRYPTO_FEE = 0.001;
export const CRYPTO_SLIP = 0.0002;

// Typical retail spreads (full spread, in price units of the pair).
export const FX_PAIRS = [
  { id: "EURUSD", base: "EUR", quote: "USD", spread: 0.0001, dp: 5, name: "Euro / US Dollar" },
  { id: "GBPUSD", base: "GBP", quote: "USD", spread: 0.00015, dp: 5, name: "British Pound / US Dollar" },
  { id: "USDJPY", base: "USD", quote: "JPY", spread: 0.01, dp: 3, name: "US Dollar / Japanese Yen" },
  { id: "AUDUSD", base: "AUD", quote: "USD", spread: 0.00012, dp: 5, name: "Australian Dollar / US Dollar" },
  { id: "USDCAD", base: "USD", quote: "CAD", spread: 0.00018, dp: 5, name: "US Dollar / Canadian Dollar" },
  { id: "USDCHF", base: "USD", quote: "CHF", spread: 0.00015, dp: 5, name: "US Dollar / Swiss Franc" },
  { id: "NZDUSD", base: "NZD", quote: "USD", spread: 0.00018, dp: 5, name: "New Zealand Dollar / US Dollar" },
  { id: "USDMXN", base: "USD", quote: "MXN", spread: 0.008, dp: 4, name: "US Dollar / Mexican Peso" },
  { id: "EURGBP", base: "EUR", quote: "GBP", spread: 0.00015, dp: 5, name: "Euro / British Pound" },
  { id: "EURJPY", base: "EUR", quote: "JPY", spread: 0.018, dp: 3, name: "Euro / Japanese Yen" },
  { id: "GBPJPY", base: "GBP", quote: "JPY", spread: 0.025, dp: 3, name: "British Pound / Japanese Yen" },
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
export function quoteBuy(inst, usd, q, mods = {}) {
  const px = q?.px;
  if (!(px > 0) || !(usd > 0)) return null;
  if (inst.m === "meme") {
    const impact = mods.zeroFees || mods.marketMaker ? 0 : memeImpact(usd, q.liq);
    const eff = px * (1 + impact);
    const fee = mods.zeroFees ? 0 : usd * MEME_FEE;
    const qty = (usd - fee) / eff;
    return { qty, eff, fee, slip: usd - fee - qty * px, impact };
  }
  if (inst.m === "crypto") {
    const sl = mods.zeroFees || mods.marketMaker ? 0 : CRYPTO_SLIP;
    const eff = px * (1 + sl);
    const fee = mods.zeroFees ? 0 : usd * CRYPTO_FEE;
    const qty = (usd - fee) / eff;
    return { qty, eff, fee, slip: usd - fee - qty * px, impact: sl };
  }
  const hs = mods.zeroFees ? 0 : halfSpread(inst, px);
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
export function quoteSell(inst, pos, frac, q, mods = {}) {
  const px = q?.px;
  if (!(px > 0) || !pos || !(pos.qty > 0)) return null;
  frac = Math.min(1, Math.max(0, frac));
  if (!(frac > 0)) return null;
  const qty = pos.qty * frac;
  const costPart = pos.cost * frac;
  let eff, fee = 0, slip, proceeds, impact;
  if (inst.m === "meme") {
    const gross = qty * px;
    impact = mods.zeroFees || mods.marketMaker ? 0 : memeImpact(gross, q.liq);
    const afterImpact = gross * (1 - impact);
    fee = mods.zeroFees ? 0 : afterImpact * MEME_FEE;
    proceeds = afterImpact - fee;
    slip = gross * impact;
    eff = afterImpact / qty;
  } else if (inst.m === "crypto") {
    impact = mods.zeroFees || mods.marketMaker ? 0 : CRYPTO_SLIP;
    eff = px * (1 - impact);
    const gross = qty * eff;
    fee = mods.zeroFees ? 0 : gross * CRYPTO_FEE;
    proceeds = gross - fee;
    slip = qty * px * impact;
  } else {
    const hs = mods.zeroFees ? 0 : halfSpread(inst, px);
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
  if (isMargin(pos)) {
    const qu = quoteToUsd(inst, q);
    if (!(qu > 0)) return null;
    return marginEquity(pos, px, qu);
  }
  if (nonUsdQuote(inst)) {
    if (!(q.quoteUsd > 0)) return null;
    return pos.cost + pos.qty * (px - pos.avg) * q.quoteUsd;
  }
  return pos.qty * px;
}

// ---------------------------------------------------------------- leverage and shorts (Cheats)
// A margin position: you put `cost` dollars of margin, it controls cost × lev dollars of the asset,
// long (dir 1) or short (dir -1). Same fees and slippage as a normal trade, charged on the full size.
// Its value is margin − entry fee ± qty × (price − entry); when that reaches 0 it is liquidated.

export const isMargin = p => !!p && ((p.lev || 1) > 1 || (p.dir || 1) === -1);

function feeRate(inst, mods) {
  if (mods.zeroFees) return 0;
  return inst.m === "meme" ? MEME_FEE : inst.m === "crypto" ? CRYPTO_FEE : 0;
}
/** Price slippage as a fraction of the price for a trade of `usd` dollars. */
function slipFrac(inst, usd, q, mods) {
  if (inst.m === "meme") return mods.zeroFees || mods.marketMaker ? 0 : memeImpact(usd, q.liq);
  if (inst.m === "crypto") return mods.zeroFees || mods.marketMaker ? 0 : CRYPTO_SLIP;
  return mods.zeroFees ? 0 : halfSpread(inst, q.px) / q.px;
}

/** Open margin × lev, long (dir 1) or short (dir -1). Returns {qty, eff, fee, slip, notional, impact}. */
export function quoteOpenMargin(inst, margin, lev, dir, q, mods = {}) {
  const px = q?.px, qu = quoteToUsd(inst, q || {});
  if (!(px > 0) || !(margin > 0) || !(qu > 0)) return null;
  const notional = margin * lev;
  const fee = notional * feeRate(inst, mods);
  const sf = slipFrac(inst, notional, q, mods);
  const eff = px * (1 + dir * sf);
  const qty = notional / (px * qu);
  return { qty, eff, fee, slip: notional * sf, notional, impact: sf };
}

/** Equity of a margin position at price px (USD per unit of quote currency: qu). */
export function marginEquity(pos, px, qu = 1) {
  return pos.cost - (pos.entryFee || 0) + (pos.dir || 1) * pos.qty * (px - pos.avg) * qu;
}

/** Price at which the equity reaches 0 (liquidation). */
export function liquidationPrice(pos, qu = 1) {
  return pos.avg - (pos.dir || 1) * (pos.cost - (pos.entryFee || 0)) / (pos.qty * qu);
}

/** Close `frac` of a margin position. Proceeds can't go below 0 unless allowNegative (Diamond hands). */
export function quoteCloseMargin(inst, pos, frac, q, mods = {}, allowNegative = false) {
  const px = q?.px, qu = quoteToUsd(inst, q || {});
  if (!(px > 0) || !(qu > 0) || !pos) return null;
  frac = Math.min(1, Math.max(0, frac));
  if (!(frac > 0)) return null;
  const dir = pos.dir || 1, qty = pos.qty * frac, costPart = pos.cost * frac;
  const size = qty * px * qu;
  const sf = slipFrac(inst, size, q, mods);
  const eff = px * (1 - dir * sf);
  const fee = size * feeRate(inst, mods);
  let proceeds = frac * (pos.cost - (pos.entryFee || 0)) + dir * qty * (eff - pos.avg) * qu - fee;
  if (!allowNegative) proceeds = Math.max(0, proceeds);
  const pl = proceeds - costPart;
  return { qty, eff, fee, slip: size * sf, proceeds, costPart, pl, plPct: costPart > 0 ? pl / costPart : 0, impact: sf };
}
