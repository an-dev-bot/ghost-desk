// Memecoins on Solana: DexScreener (prices, trending, new, search) and GeckoTerminal (candles).
// No key. DexScreener: 300 req/min for pairs and search, 60/min for boosts/profiles. GeckoTerminal: ~30/min.

import { getJSON, RateLimiter, SourceError } from "./http.js";

const DS = "https://api.dexscreener.com";
const GT = "https://api.geckoterminal.com/api/v2";
const dsLim = new RateLimiter(200, 60e3);
const gtLim = new RateLimiter(25, 60e3);

async function ds(path) { await dsLim.take(); return getJSON(DS + path, { source: "dexscreener" }); }

/** Best (most liquid) Solana pair per token. */
function bestPairs(pairs) {
  const best = {};
  for (const p of pairs || []) {
    if (p?.chainId !== "solana" || !p.baseToken?.address) continue;
    const a = p.baseToken.address;
    if (!best[a] || (p.liquidity?.usd || 0) > (best[a].liquidity?.usd || 0)) best[a] = p;
  }
  return best;
}

const httpsOnly = u => (typeof u === "string" && u.startsWith("https://") ? u : "");

export function toInst(p) {
  const a = p.baseToken.address;
  return {
    key: "meme:" + a, m: "meme", id: a, sym: p.baseToken.symbol || "?", name: p.baseToken.name || "",
    img: httpsOnly(p.info?.imageUrl), pair: p.pairAddress, dex: p.dexId, url: httpsOnly(p.url),
    born: p.pairCreatedAt || null,
    px: Number(p.priceUsd), liq: p.liquidity?.usd || 0, mc: p.marketCap ?? p.fdv ?? null, vol: p.volume?.h24 ?? null,
    ch: { m5: p.priceChange?.m5 ?? null, h1: p.priceChange?.h1 ?? null, h6: p.priceChange?.h6 ?? null, h24: p.priceChange?.h24 ?? null },
  };
}

/** Live data for up to any number of token addresses (chunks of 30). */
export async function tokens(addrs) {
  const out = [];
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    const d = await ds("/tokens/v1/solana/" + chunk.map(encodeURIComponent).join(","));
    out.push(...Object.values(bestPairs(Array.isArray(d) ? d : d?.pairs)).map(toInst));
  }
  return out.filter(t => t.px > 0);
}

const solAddrs = list => [...new Set((list || []).filter(x => x?.chainId === "solana" && x.tokenAddress).map(x => x.tokenAddress))];

export async function trending() {
  const d = await ds("/token-boosts/top/v1");
  const addrs = solAddrs(d).slice(0, 30);
  const toks = await tokens(addrs);
  const by = Object.fromEntries(toks.map(t => [t.id, t]));
  return addrs.map(a => by[a]).filter(Boolean);
}

export async function newest() {
  const d = await ds("/token-profiles/latest/v1");
  const toks = await tokens(solAddrs(d).slice(0, 30));
  return toks.sort((a, b) => (b.born || 0) - (a.born || 0));
}

export async function search(q) {
  const d = await ds("/latest/dex/search?q=" + encodeURIComponent(q));
  return Object.values(bestPairs(d?.pairs)).map(toInst).filter(t => t.px > 0).sort((a, b) => b.liq - a.liq).slice(0, 30);
}

const GT_TF = { "1m": ["minute", 1], "5m": ["minute", 5], "1h": ["hour", 1], "1d": ["day", 1] };

/** Candles for a pool from GeckoTerminal. Throws notfound if the pool is not indexed there. */
export async function candles(pool, ivl) {
  if (!pool) throw new SourceError("geckoterminal", "notfound", "Sin pool");
  const [tf, agg] = GT_TF[ivl];
  await gtLim.take();
  const d = await getJSON(`${GT}/networks/solana/pools/${encodeURIComponent(pool)}/ohlcv/${tf}?aggregate=${agg}&limit=300&currency=usd&token=base`, { source: "geckoterminal" });
  const list = d?.data?.attributes?.ohlcv_list || [];
  return list.map(r => ({ t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4] })).filter(b => b.c > 0).sort((a, b) => a.t - b.t);
}
