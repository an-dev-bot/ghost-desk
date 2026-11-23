// Achievements. Stored apart from the portfolio, so they survive a reset.
// Each one unlocks from something that really happened (a trade, an order fill, the real clock).

import { greenStreak, winStreak } from "./stats.js";

export const ACHIEVEMENTS = [
  { id: "first_trade", icon: "🎯", name: "Primer disparo", desc: "Haz tu primera operación." },
  { id: "first_win", icon: "💚", name: "Primera ganancia", desc: "Cierra una operación en verde." },
  { id: "trades_10", icon: "🔟", name: "10 operaciones", desc: "Llega a 10 operaciones." },
  { id: "trades_50", icon: "⚡", name: "50 operaciones", desc: "Llega a 50 operaciones." },
  { id: "trades_100", icon: "💯", name: "100 operaciones", desc: "Llega a 100 operaciones." },
  { id: "win_50", icon: "🚀", name: "+50% en una", desc: "Gana 50% o más en una sola operación." },
  { id: "win_100", icon: "🌕", name: "La duplicaste", desc: "Gana 100% o más en una sola operación." },
  { id: "survivor", icon: "🛡️", name: "Sobreviviste a la caída", desc: "Aguanta una caída de 30% en una posición y ciérrala en verde." },
  { id: "four_markets", icon: "🌎", name: "Los 4 mercados", desc: "Opera memecoins, cripto, acciones y divisas." },
  { id: "streak_3", icon: "🔥", name: "Racha de 3", desc: "Cierra 3 días seguidos en verde." },
  { id: "streak_7", icon: "🏆", name: "Semana en verde", desc: "Cierra 7 días seguidos en verde." },
  { id: "wins_5", icon: "🎰", name: "5 ganadoras seguidas", desc: "Cierra 5 operaciones seguidas con ganancia." },
  { id: "sniper", icon: "🔭", name: "Francotirador", desc: "Compra una memecoin en sus primeros 10 minutos de vida." },
  { id: "limit_fill", icon: "⏳", name: "Paciencia", desc: "Que se llene una orden límite." },
  { id: "stop_loss", icon: "🧊", name: "Sangre fría", desc: "Que tu stop loss te saque a tiempo." },
  { id: "take_profit", icon: "💰", name: "A cobrar", desc: "Que se active tu take profit." },
  { id: "opening_bell", icon: "🔔", name: "Campanazo", desc: "Opera una acción en los primeros 5 minutos de Wall Street." },
  { id: "profit_1000", icon: "💵", name: "+$1,000", desc: "Acumula $1,000 de ganancia realizada." },
  { id: "value_15k", icon: "📈", name: "Cartera de $15,000", desc: "Haz crecer tu cartera a $15,000." },
];

export function newAchievements() {
  return { v: 1, unlocked: {}, lifetime: { trades: 0, markets: {} } };
}

/**
 * Update lifetime counters with new trades and return the achievements unlocked now.
 * ctx = {trades (current portfolio), total, now, stockOpenSince (ms or null)}
 */
export function evaluate(ach, newTrades, ctx) {
  const got = [];
  const unlock = id => { if (!ach.unlocked[id]) { ach.unlocked[id] = ctx.now; got.push(id); } };
  for (const t of newTrades) {
    ach.lifetime.trades++;
    ach.lifetime.markets[t.m] = true;
    unlock("first_trade");
    if (t.side === "sell") {
      if (t.pl > 0) unlock("first_win");
      if (t.plPct >= 0.5) unlock("win_50");
      if (t.plPct >= 1) unlock("win_100");
      if (t.dip >= 0.3 && t.pl > 0) unlock("survivor");
      if (t.reason === "sl") unlock("stop_loss");
      if (t.reason === "tp") unlock("take_profit");
    }
    if (t.reason === "limit") unlock("limit_fill");
    if (t.m === "meme" && t.side === "buy" && t.bornAgo != null && t.bornAgo <= 10 * 60e3) unlock("sniper");
    if (t.m === "stock" && ctx.stockOpenSince && t.t - ctx.stockOpenSince <= 5 * 60e3 && t.t >= ctx.stockOpenSince) unlock("opening_bell");
  }
  const n = ach.lifetime.trades;
  if (n >= 10) unlock("trades_10");
  if (n >= 50) unlock("trades_50");
  if (n >= 100) unlock("trades_100");
  if (["meme", "crypto", "stock", "fx"].every(m => ach.lifetime.markets[m])) unlock("four_markets");
  const trades = ctx.trades || [];
  const streak = greenStreak(trades, ctx.now);
  if (streak >= 3) unlock("streak_3");
  if (streak >= 7) unlock("streak_7");
  if (winStreak(trades) >= 5) unlock("wins_5");
  const realized = trades.reduce((a, t) => a + (t.side === "sell" ? t.pl : 0), 0);
  if (realized >= 1000) unlock("profit_1000");
  if (ctx.total >= 15000) unlock("value_15k");
  return got;
}

export function achievementById(id) {
  return ACHIEVEMENTS.find(a => a.id === id);
}
