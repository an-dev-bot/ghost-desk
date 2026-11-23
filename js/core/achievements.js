// Achievements. Stored apart from the portfolio, so they survive a reset.
// Each one unlocks from something that really happened (a trade, an order fill, the real clock).

import { greenStreak, winStreak } from "./stats.js";

export const ACHIEVEMENTS = [
  { id: "first_trade", icon: "🎯", name: "First Shot", desc: "Make your first trade." },
  { id: "first_win", icon: "💚", name: "First Win", desc: "Close a trade in the green." },
  { id: "trades_10", icon: "🔟", name: "10 Trades", desc: "Reach 10 trades." },
  { id: "trades_50", icon: "⚡", name: "50 Trades", desc: "Reach 50 trades." },
  { id: "trades_100", icon: "💯", name: "100 Trades", desc: "Reach 100 trades." },
  { id: "win_50", icon: "🚀", name: "+50% in One", desc: "Make 50% or more on a single trade." },
  { id: "win_100", icon: "🌕", name: "Doubled It", desc: "Make 100% or more on a single trade." },
  { id: "survivor", icon: "🛡️", name: "Survived the Dip", desc: "Hold through a 30% drop on a position and close it in the green." },
  { id: "four_markets", icon: "🌎", name: "All 4 Markets", desc: "Trade memecoins, crypto, stocks and forex." },
  { id: "streak_3", icon: "🔥", name: "3-Day Streak", desc: "Close 3 days in a row in the green." },
  { id: "streak_7", icon: "🏆", name: "Green Week", desc: "Close 7 days in a row in the green." },
  { id: "wins_5", icon: "🎰", name: "5 Wins in a Row", desc: "Close 5 trades in a row at a profit." },
  { id: "sniper", icon: "🔭", name: "Sniper", desc: "Buy a memecoin in its first 10 minutes of life." },
  { id: "limit_fill", icon: "⏳", name: "Patience", desc: "Get a limit order filled." },
  { id: "stop_loss", icon: "🧊", name: "Cold Blood", desc: "Let your stop loss get you out in time." },
  { id: "take_profit", icon: "💰", name: "Cash Out", desc: "Have your take profit trigger." },
  { id: "opening_bell", icon: "🔔", name: "Opening Bell", desc: "Trade a stock in the first 5 minutes of Wall Street." },
  { id: "profit_10", icon: "💵", name: "+10% Realized", desc: "Bank realized profit worth 10% of your starting balance." },
  { id: "value_150", icon: "📈", name: "Portfolio +50%", desc: "Grow your portfolio to 1.5× your starting balance." },
];

export function newAchievements() {
  return { v: 1, unlocked: {}, lifetime: { trades: 0, markets: {} } };
}

/**
 * Update lifetime counters with new trades and return the achievements unlocked now.
 * ctx = {trades (current portfolio), total, start (starting balance), now, stockOpenSince (ms or null)}
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
  // Money goals scale with the starting balance the owner picked ($10K, $100K, $1M or her own).
  const base = ctx.start > 0 ? ctx.start : 0;
  if (base && realized >= base * 0.1) unlock("profit_10");
  if (base && ctx.total >= base * 1.5) unlock("value_150");
  return got;
}

export function achievementById(id) {
  return ACHIEVEMENTS.find(a => a.id === id);
}
