// Backup file: move the portfolio from the PC to the phone (or back).
// API keys are never written to the file: each device keeps its own.

import { validBots } from "./bots.js";

export const BACKUP_APP = "ghost-desk";
const SECRET_FIELDS = ["finnhubKey", "twelveKey"];

export function publicSettings(settings) {
  const s = structuredClone(settings || {});
  for (const k of SECRET_FIELDS) delete s[k];
  return s;
}

export function buildBackup({ portfolio, achievements, settings, bots }, now = Date.now()) {
  return JSON.stringify({
    app: BACKUP_APP, format: 1, exportedAt: new Date(now).toISOString(),
    portfolio, achievements, settings: publicSettings(settings), bots: bots || [],
  }, null, 1);
}

export class BackupError extends Error {}

function isNum(n) { return typeof n === "number" && isFinite(n); }

export function parseBackup(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new BackupError("That file is not a Ghost Desk backup (it could not be read)."); }
  if (!d || d.app !== BACKUP_APP || d.format !== 1) throw new BackupError("That file is not a Ghost Desk backup.");
  const p = d.portfolio;
  if (!p || !isNum(p.cash) || !isNum(p.start) || !(p.start > 0) || typeof p.pos !== "object" || !Array.isArray(p.orders) || !Array.isArray(p.trades)) {
    throw new BackupError("The backup is incomplete or damaged.");
  }
  for (const k in p.pos) {
    const x = p.pos[k];
    if (!x?.inst?.m || !isNum(x.qty) || !isNum(x.cost)) throw new BackupError("A position in the backup is damaged.");
  }
  for (const t of p.trades) if (!isNum(t.t) || !isNum(t.usd) || !t.m) throw new BackupError("A trade in the backup is damaged.");
  p.days ||= {};
  if (p.margin != null && typeof p.margin !== "object") throw new BackupError("A position in the backup is damaged.");
  p.margin ||= {};
  for (const k in p.margin) {
    const x = p.margin[k];
    if (!x?.inst?.m || !isNum(x.qty) || !isNum(x.cost) || !isNum(x.lev) || !isNum(x.avg)) throw new BackupError("A position in the backup is damaged.");
  }
  delete p.undo;
  p.seq = Math.max(p.seq || 0, ...p.trades.map(t => t.id || 0), ...p.orders.map(o => o.id || 0));
  // Older backups have no bots: keep the ones on this phone. A damaged bot list is ignored, not imported.
  const bots = d.bots === undefined ? null : validBots(d.bots) ? d.bots : null;
  return { portfolio: p, achievements: d.achievements || null, settings: publicSettings(d.settings), bots };
}

/** Union of two achievement records: keeps the earliest unlock and the larger counters. */
export function mergeAchievements(a, b) {
  if (!b) return a;
  const out = structuredClone(a);
  for (const [id, t] of Object.entries(b.unlocked || {})) out.unlocked[id] = Math.min(out.unlocked[id] ?? Infinity, t);
  out.lifetime.trades = Math.max(out.lifetime.trades, b.lifetime?.trades || 0);
  Object.assign(out.lifetime.markets, b.lifetime?.markets || {});
  // An achievement stays marked "with cheats" only if every copy that has it earned it with cheats.
  const cheated = {};
  for (const id in out.unlocked) {
    const ca = !a.unlocked[id] || a.cheated?.[id], cb = !b.unlocked?.[id] || b.cheated?.[id];
    if (ca && cb) cheated[id] = (a.cheated?.[id] || b.cheated?.[id]);
  }
  out.cheated = cheated;
  // Prestige badges: the copy with more of them.
  if ((b.prestige?.length || 0) > (a.prestige?.length || 0)) out.prestige = structuredClone(b.prestige);
  return out;
}
