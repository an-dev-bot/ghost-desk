"""Drive headless Chrome through the DevTools protocol to run the Ghost Desk tests.

  python -I tests/run.py <chrome.exe> <base-url> <out-dir>

1) tests/index.html: spec tests 1–5 (hand-made prices, no network).
2) index.html?test=1 at 375x812 (phone): spec test 6. Checks nothing overflows on any tab or sheet,
   buy/sell buttons are thumb-sized, and buys through the real swipe gesture. Saves screenshots.

Extra modes against the real price sources (4th argument):
  live     the real app with no keys: memecoins, crypto and FX must show live prices
  offline  installs the app, stops its server and the network: portfolio and history still open
  sim      the real app in Sim mode for 40 s with its own clock, then a reload: the Sim world continues
  cheats   the real app: Time machine on yesterday's real BTC candles, Golden entry and Sniper on real prices
  bots     the real app with 4 rival bots for ~2 minutes on real prices: what they trade and why
  persist  (also part of the normal run) changes, the browser killed at once, opened again: all saved
  badkeys  wrong Finnhub / Twelve Data keys: clear notices, nothing blank, nothing cached
  tddemo   Twelve Data's public "demo" key: real EUR/USD candles, saved and reused without a credit
"""
import asyncio, base64, json, os, subprocess, sys, tempfile, time, urllib.request

import websockets

sys.stdout.reconfigure(encoding="utf-8")
CHROME, BASE, OUT = sys.argv[1], sys.argv[2].rstrip("/"), sys.argv[3]
MODE = sys.argv[4] if len(sys.argv) > 4 else "all"  # "live": open the real app against the real price sources
PORT = 9333
os.makedirs(OUT, exist_ok=True)


class Page:
    def __init__(self, ws):
        self.ws, self.n, self.pending, self.events = ws, 0, {}, []

    async def pump(self):
        async for raw in self.ws:
            m = json.loads(raw)
            if "id" in m and m["id"] in self.pending:
                self.pending.pop(m["id"]).set_result(m)
            elif m.get("method") == "Runtime.exceptionThrown":
                self.events.append(m["params"]["exceptionDetails"].get("exception", {}).get("description", "?"))
            elif m.get("method") == "Runtime.consoleAPICalled" and m["params"]["type"] in ("error", "warning"):
                self.events.append(" ".join(str(a.get("value", a.get("description", ""))) for a in m["params"]["args"]))

    async def send(self, method, **params):
        self.n += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[self.n] = fut
        await self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        m = await asyncio.wait_for(fut, 60)
        if "error" in m:
            raise RuntimeError(f"{method}: {m['error']}")
        return m["result"]

    async def js(self, expr):
        r = await self.send("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"].get("exception", {}).get("description", str(r["exceptionDetails"])))
        return r["result"].get("value")

    async def goto(self, url, ready_expr, timeout=60):
        await self.send("Page.navigate", url=url)
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                if await self.js(ready_expr):
                    return
            except Exception:
                pass
            await asyncio.sleep(0.25)
        raise TimeoutError("page did not finish loading: " + url)

    async def shot(self, name):
        r = await self.send("Page.captureScreenshot", format="png")
        with open(os.path.join(OUT, name + ".png"), "wb") as f:
            f.write(base64.b64decode(r["data"]))


async def main():
    prof = tempfile.mkdtemp(prefix="gd-chrome-")
    proc = subprocess.Popen([CHROME, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                             f"--remote-debugging-port={PORT}", f"--user-data-dir={prof}", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(80):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=1)
                break
            except Exception:
                time.sleep(0.25)
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?about:blank", method="PUT")
        target = json.load(urllib.request.urlopen(req))
        async with websockets.connect(target["webSocketDebuggerUrl"], max_size=50_000_000) as ws:
            p = Page(ws)
            pump = asyncio.create_task(p.pump())
            await p.send("Page.enable")
            await p.send("Runtime.enable")
            if MODE == "live":
                ok = await live_check(p)
            elif MODE == "persist":
                ok = await persist_tests()
            elif MODE == "badkeys":
                ok = await bad_keys_check(p)
            elif MODE == "tddemo":
                ok = await twelve_demo_check(p)
            elif MODE == "offline":
                ok = await offline_check(p)
            elif MODE == "bots":
                ok = await bots_live_check(p)
            elif MODE == "cheats":
                ok = await cheats_live_check(p)
            elif MODE == "sim":
                ok = await sim_live_check(p)
            else:
                ok1 = await unit_tests(p)
                ok2 = await layout_tests(p)
                ok3 = await persist_tests()
                ok = ok1 and ok2 and ok3
            pump.cancel()
            return ok
    finally:
        proc.terminate()


async def persist_tests():
    """Make changes, kill the whole browser at once (no pagehide, no goodbye) and open it again with the same profile."""
    port, fails = PORT + 1, []
    prof = tempfile.mkdtemp(prefix="gd-persist-")
    url = BASE + "/index.html?test=1#home"
    ready = "document.documentElement.dataset.ready === '1'"

    def res(good, text):
        print(("PASS " if good else "FAIL ") + " " + text)
        if not good:
            fails.append(text)

    async def session(fn):
        proc = subprocess.Popen([CHROME, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                                 f"--remote-debugging-port={port}", f"--user-data-dir={prof}", "about:blank"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pump = None
        try:
            for _ in range(80):
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1)
                    break
                except Exception:
                    time.sleep(0.25)
            req = urllib.request.Request(f"http://127.0.0.1:{port}/json/new?about:blank", method="PUT")
            target = json.load(urllib.request.urlopen(req))
            async with websockets.connect(target["webSocketDebuggerUrl"], max_size=50_000_000) as ws:
                p = Page(ws)
                pump = asyncio.create_task(p.pump())
                await p.send("Page.enable")
                await p.send("Runtime.enable")
                await p.goto(url, ready)
                r = await fn(p)
                proc.kill()  # TerminateProcess / SIGKILL on the browser
                pump.cancel()
                return r
        finally:
            proc.kill()
            proc.wait()
            await asyncio.sleep(1)

    CHANGE = """(() => { const g = ghostDesk, s = g.state(), now = g.appNow();
      const key = g.isSim() ? g.lists.crypto[0] : 'crypto:BTCUSDT';
      const inst = g.isSim() ? g.SW.instOf(g.sim().insts[key]) : { key, m: 'crypto', id: 'BTCUSDT', sym: 'BTC', name: 'Bitcoin' };
      if (!g.isSim()) g.setLive(inst, { px: 60000, t: now });
      const t = g.E.executeBuy(s, inst, 500, { px: g.live.get(key).px, t: now }, now);
      g.afterTrades([t]);
      // prices keep coming while the save is due (they used to postpone it forever)
      setInterval(() => g.runChecks(key), 50);
      g.openCheats(); const c = document.querySelector('[data-cheat=zeroFees]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
      g.openSettings(); const i = document.getElementById('lcTrail'); i.checked = !i.checked; i.dispatchEvent(new Event('change', { bubbles: true }));
      g.addBot('momentum');
      return true; })()"""
    LOOK = """(() => { const g = ghostDesk, s = g.state(); return { sim: g.isSim(), cash: s.cash, pos: Object.keys(s.pos), trades: s.trades.length,
      fees: !!s.cheats?.on?.zeroFees, trail: g.cfg().lc.trail, bots: g.bots().length, banners: document.getElementById('banners').innerText, t: g.sim()?.t || 0 }; })()"""

    async def change(p):
        await p.js(CHANGE)
        await asyncio.sleep(0.8)
        pill = await p.js("!document.getElementById('saved').hidden")
        return {**await p.js(LOOK), "pill": pill}

    async def change_sim(p):
        await p.js("document.getElementById('simBtn').click(), true")
        for _ in range(60):
            await asyncio.sleep(0.25)
            try:
                if await p.js("ghostDesk.isSim() && " + ready):
                    break
            except Exception:
                pass
        await asyncio.sleep(0.5)
        return await change(p)

    async def look(p):
        return await p.js(LOOK)

    same = ["sim", "cash", "pos", "trades", "fees", "trail", "bots"]
    for name, fn in [("Live", change), ("Sim", change_sim)]:
        a = await session(fn)
        b = await session(look)
        good = a["trades"] == 1 and a["pos"] and all(a[k] == b[k] for k in same) and not b["banners"].count("damaged") and abs(b["t"] - a["t"]) < 15000
        res(good, f"{name}: changes, browser killed, opened again: " + ("all there " if good else "LOST ") + json.dumps({k: b[k] for k in same}) + ("" if good else " expected " + json.dumps(a)))
        res(a["pill"], f"{name}: “Saved” indicator shown")

    async def faults(p):
        out = {}
        # a dropped connection (iOS in the background): it reopens on its own and saves
        out["drop"] = await p.js("""(async () => { const T = IDBDatabase.prototype.transaction; let n = 0;
          IDBDatabase.prototype.transaction = function (...a) { if (!n++) throw new DOMException('Connection to Indexed Database server lost', 'InvalidStateError'); return T.apply(this, a); };
          const ok = await ghostDesk.saveOnExit(); IDBDatabase.prototype.transaction = T; return ok && n > 1; })()""")
        # a full phone: clear notice, and it saves once there is room
        out["fail"] = await p.js("""(async () => { const P = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function () { throw new DOMException('full', 'QuotaExceededError'); };
          const ok = await ghostDesk.saveOnExit(); const t = document.getElementById('banners').innerText;
          IDBObjectStore.prototype.put = P; document.querySelector('[data-savenow]').click(); await new Promise(r => setTimeout(r, 500));
          return { ok, t, after: document.getElementById('banners').innerText }; })()""")
        # damaged data on disk: the app repairs it, says so and keeps the rest
        await p.js("""(async () => { const g = ghostDesk, s = structuredClone(g.state()); s.cash = NaN; s.pos['crypto:BAD'] = { qty: Infinity };
          const b = structuredClone({ v: 1, list: g.bots() }); b.list.push({ id: 'x', name: 'Broken', style: 'momentum', pf: null });
          window.dispatchEvent = () => true; const put = g.kv.setMany; await put([['sim.portfolio', s], ['sim.bots', b]]);
          IDBObjectStore.prototype.put = function () { throw new Error('closed'); }; return true; })()""")
        await p.goto(BASE + "/index.html?test=1&r=3#home", ready)
        out["bad"] = await p.js(LOOK)
        return out

    f = await session(faults)
    res(f["drop"], "Dropped IndexedDB connection: reopened and saved")
    res(f["fail"]["ok"] is False and "not saved" in f["fail"]["t"] and "not saved" not in f["fail"]["after"], f"Save failure: “{f['fail']['t'][:90]}”, gone once it saves")
    d = f["bad"]
    res(isinstance(d["cash"], (int, float)) and d["cash"] > 0 and len(d["pos"]) == 1 and d["trades"] == 1 and d["bots"] == 1 and "damaged" in d["banners"],
        f"Damaged data: cash {d['cash']}, {len(d['pos'])} position, {d['trades']} trade, {d['bots']} bot kept; “{d['banners'][-150:]}”")
    return not fails


async def unit_tests(p):
    await p.goto(BASE + "/tests/index.html", "document.title.startsWith('DONE')")
    print(await p.js("document.getElementById('summary').innerText"))
    print(await p.js("document.getElementById('results').innerText"))
    return await p.js("!document.querySelector('.fail')")


LAYOUT_SETUP = r"""
(async () => {
  const E = await import('./js/core/engine.js');
  const g = window.ghostDesk, now = Date.now();
  const add = (inst, d) => g.setLive(inst, { t: now, ...d });
  const crypto = [['BTC','Bitcoin',61234.56,2.41],['ETH','Ethereum',1718.9,-1.2],['SOL','Solana',72.3,5.8],['XRP','XRP',0.5123,-3.4],['DOGE','Dogecoin',0.0812,12.7]]
    .map(([s,n,px,ch]) => { const i = { key:'crypto:'+s+'USDT', m:'crypto', id:s+'USDT', sym:s, name:n }; add(i, { px, ch24: ch, vol: 1.2e9 }); return i; });
  const stocks = [['SPY','S&P 500 (ETF SPY)',598.12,0.8],['AAPL','Apple',349.62,2.06],['NVDA','Nvidia',181.4,-2.9],['TSLA','Tesla',402.11,6.1]]
    .map(([s,n,px,ch]) => { const i = { key:'stock:'+s, m:'stock', id:s, sym:s, name:n }; add(i, { px, ch24: ch, o: px*0.99, hi: px*1.01, lo: px*0.98, prev: px/(1+ch/100) }); return i; });
  const fx = [['EURUSD','EUR','USD',1.09009,0.12,5],['USDJPY','USD','JPY',159.012,-0.31,3],['USDMXN','USD','MXN',19.1751,0.42,4]]
    .map(([id,b,q,px,ch,dp]) => { const i = { key:'fx:'+id, m:'fx', id, sym:b+'/'+q, name:b+' / '+q, base:b, quote:q, dp }; add(i, { px, ch24: ch, quoteUsd: q === 'USD' ? 1 : 1/px }); return i; });
  const memes = [['MEMEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','SUPERLONGNAMECOIN','Super Long Name Coin With Many Words',0.00002167,48.2],['MEMEBBBBB','GHOST','Ghost',0.0123,-22.5]]
    .map(([id,s,n,px,ch], k) => { const i = { key:'meme:'+id, m:'meme', id, sym:s, name:n, pair:'P'+k, born: now - (k ? 3 : 900) * 60e3 }; add(i, { px, ch24: ch, ch1h: ch/3, ch5m: 1.1, ch6h: ch/2, liq: 254000, mc: 2.1e6, vol: 8.9e5 }); return i; });
  g.lists.crypto.push(...crypto.map(i => i.key)); g.lists.stock.push(...stocks.map(i => i.key));
  g.lists.meme.trending.push(...memes.map(i => i.key)); g.lists.meme.new.push(...memes.map(i => i.key));
  const S = g.state();
  const q = i => ({ ...g.live.get(i.key), t: now });
  E.executeBuy(S, crypto[0], 2500, q(crypto[0]), now - 3600e3);
  E.executeBuy(S, memes[0], 400, q(memes[0]), now - 1800e3);
  E.executeBuy(S, fx[1], 1200, q(fx[1]), now - 600e3);
  E.executeSell(S, memes[0].key, 0.5, { ...q(memes[0]), px: memes[0] && g.live.get(memes[0].key).px * 1.4 }, now - 60e3);
  E.setStops(S, crypto[0].key, { sl: 55000, tp: 70000 });
  E.placeOrder(S, crypto[2], { side: 'buy', type: 'limit', amount: 300, limit: 72.0 }, q(crypto[2]), now, { open: true, since: 0 });
  E.placeOrder(S, stocks[1], { side: 'buy', type: 'market', amount: 500 }, q(stocks[1]), now, { open: false });
  g.renderAll();
  return true;
})()
"""

OVERFLOW = r"""
(() => {
  const vw = document.documentElement.clientWidth, bad = [];
  const clipped = el => { for (let a = el.parentElement; a; a = a.parentElement) { if (getComputedStyle(a).overflowX !== 'visible') { const r = a.getBoundingClientRect(); if (r.right <= vw + 0.5 && r.left >= -0.5) return true; } } return false; };
  for (const el of document.querySelectorAll('body *')) {
    if (!el.getClientRects().length) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 0.5 || r.left < -0.5) && !clipped(el)) bad.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + [...el.classList].join('.')) + ' → ' + Math.round(r.left) + '..' + Math.round(r.right));
  }
  return { vw, docW: document.documentElement.scrollWidth, bad: bad.slice(0, 8) };
})()
"""


async def layout_tests(p):
    await p.send("Emulation.setDeviceMetricsOverride", width=375, height=812, deviceScaleFactor=2, mobile=True)
    await p.send("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)
    await p.goto(BASE + "/index.html?test=1#home", "document.documentElement.dataset.ready === '1'")
    await p.js("indexedDB.deleteDatabase('ghost-desk-test'), true")
    await p.goto(BASE + "/index.html?test=1&r=2#home", "document.documentElement.dataset.ready === '1'")
    await p.js(LAYOUT_SETUP)
    await asyncio.sleep(1.2)
    fails = []

    async def check(name):
        r = await p.js(OVERFLOW)
        good = r["docW"] <= r["vw"] and not r["bad"]
        print(("PASS " if good else "FAIL ") + f" 6 · {name}: width {r['docW']}px of {r['vw']}px" + ("" if good else " → " + "; ".join(r["bad"])))
        if not good:
            fails.append(name)
        await p.shot(name.replace(" ", "-").lower())

    for tab in ["home", "markets", "portfolio", "history", "achievements"]:
        await p.js(f"ghostDesk.setTab('{tab}'), true")
        await asyncio.sleep(0.5)
        await check("tab " + tab)
    for m in ["meme", "stock", "fx"]:
        await p.js(f"ghostDesk.setTab('markets'), document.querySelector('.seg.mk [data-market=\"{m}\"]').click(), true")
        await asyncio.sleep(0.4)
        await check("markets " + m)
    for key, name in [("crypto:BTCUSDT", "sheet btc"), ("meme:MEMEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "sheet memecoin"), ("fx:USDJPY", "sheet usdjpy"), ("stock:AAPL", "sheet aapl no key")]:
        await p.js(f"ghostDesk.closeSheet(true), ghostDesk.openSheet('{key}'), true")
        await asyncio.sleep(0.7)
        await check(name)
    # Thumb-sized buy/sell buttons at the bottom of the screen
    await p.js("ghostDesk.closeSheet(true), ghostDesk.openSheet('crypto:SOLUSDT'), true")
    await asyncio.sleep(0.6)
    b = await p.js("(() => { const r = s => { const x = document.querySelector(s).getBoundingClientRect(); return { w: x.width, h: x.height, top: x.top, bottom: x.bottom }; }; return { buy: r('[data-side=buy]'), sell: r('[data-side=sell]'), vh: innerHeight }; })()")
    thumb_ok = all(x["h"] >= 48 and x["w"] >= 140 and x["top"] >= b["vh"] * 0.75 for x in (b["buy"], b["sell"]))
    print(("PASS " if thumb_ok else "FAIL ") + f" 6 · Buy and Sell: {round(b['buy']['w'])}×{round(b['buy']['h'])} px, at the bottom of the screen (y={round(b['buy']['top'])} of {b['vh']})")
    if not thumb_ok:
        fails.append("buttons")
    # Buy through the real swipe gesture: tap Buy, tap $500, slide the thumb.
    before = await p.js("ghostDesk.state().trades.length")
    await p.js("ghostDesk.chooseSide('buy'), true")
    await asyncio.sleep(0.3)
    await p.js("document.querySelector('[data-amt=\"500\"]').click(), true")
    await asyncio.sleep(0.4)
    await check("sheet buy")
    sw = await p.js("(() => { const t = document.querySelector('.swipe-thumb').getBoundingClientRect(), b = document.querySelector('.swipe').getBoundingClientRect(); return { x: t.x + t.width / 2, y: t.y + t.height / 2, w: t.width, h: t.height, end: b.right - 10 }; })()")
    chips = await p.js("Math.min(...[...document.querySelectorAll('.chips.amt button')].map(b => b.getBoundingClientRect().height))")
    size_ok = sw["w"] >= 48 and sw["h"] >= 48 and chips >= 40
    print(("PASS " if size_ok else "FAIL ") + f" 6 · Slide button {round(sw['w'])}×{round(sw['h'])} px, amount chips {round(chips)} px tall")
    if not size_ok:
        fails.append("slide")
    await p.send("Input.dispatchMouseEvent", type="mousePressed", x=sw["x"], y=sw["y"], button="left", clickCount=1)
    for k in range(1, 13):
        await p.send("Input.dispatchMouseEvent", type="mouseMoved", x=sw["x"] + (sw["end"] - sw["x"]) * k / 12, y=sw["y"], button="left")
        await asyncio.sleep(0.02)
    await p.send("Input.dispatchMouseEvent", type="mouseReleased", x=sw["end"], y=sw["y"], button="left", clickCount=1)
    await asyncio.sleep(0.8)
    after = await p.js("ghostDesk.state().trades.slice(-1)[0]")
    bought = (await p.js("ghostDesk.state().trades.length")) == before + 1 and after["sym"] == "SOL" and abs(after["usd"] - 500) < 1e-9
    print(("PASS " if bought else "FAIL ") + f" 6 · Buy $500 of SOL by sliding to confirm")
    if not bought:
        fails.append("slide buy")
    await p.shot("after-buy")
    await asyncio.sleep(2.5)
    await p.js("ghostDesk.closeSheet(true), ghostDesk.openSettings(), true")
    await asyncio.sleep(0.5)
    await check("settings")
    fails += await reset_tests(p, check)
    fails += await rival_tests(p, check)
    fails += await cheat_ui_tests(p, check)
    fails += await sim_ui_tests(p, check)
    if p.events:
        print("Console errors:", *p.events[:10], sep="\n  ")
    return not fails and not p.events


async def reset_tests(p, check):
    """Settings → Reset portfolio: pick $1,000,000 (two taps), then a custom $25,000. Achievements stay."""
    fails = []
    ach0 = await p.js("(async () => { const st = await import('./js/store.js'); return Object.keys((await st.kv.get('achievements'))?.unlocked || {}).length; })()")
    trades0 = await p.js("ghostDesk.state().trades.length")
    await p.js("document.querySelector('[data-start=\"1000000\"]').scrollIntoView(), document.querySelector('[data-start=\"1000000\"]').click(), true")
    await asyncio.sleep(0.3)
    label = await p.js("document.querySelector('[data-reset]').textContent")
    await p.js("document.querySelector('[data-reset]').click(), true")
    await asyncio.sleep(0.2)
    s1 = await p.js("ghostDesk.state().start")
    label2 = await p.js("document.querySelector('[data-reset]')?.textContent")
    await check("settings reset")
    await p.js("document.querySelector('[data-reset]').click(), true")
    await asyncio.sleep(1.2)
    st = await p.js("(() => { const s = ghostDesk.state(); return { start: s.start, cash: s.cash, trades: s.trades.length, pos: Object.keys(s.pos).length, orders: s.orders.length, total: document.getElementById('total').textContent, full: document.getElementById('total').dataset.full, pl: document.getElementById('totalPl').textContent }; })()")
    ach1 = await p.js("(async () => { const st = await import('./js/store.js'); return Object.keys((await st.kv.get('achievements'))?.unlocked || {}).length; })()")
    ok1 = (label == "Reset to $1M" and s1 != 1000000 and "Tap again" in (label2 or "") and st["start"] == 1000000 and st["cash"] == 1000000
           and st["trades"] == 0 and st["pos"] == 0 and st["orders"] == 0 and st["total"] == "$1M" and st["full"] == "$1,000,000.00" and "from $1M" in st["pl"] and ach1 == ach0 and ach0 > 0 and trades0 > 0)
    print(("PASS " if ok1 else "FAIL ") + f" Reset to $1,000,000 with two taps: header {st['total']} / “{st['pl']}”, {st['trades']} trades, achievements kept {ach1}/{ach0}")
    if not ok1:
        fails.append("reset 1M")
    await p.js("ghostDesk.setTab('home'), true")
    await asyncio.sleep(0.4)
    await check("home at 1M")
    # Amount chips scale with the starting balance: 1M → $1K, $5K, $10K, $50K, $100K
    await p.js("ghostDesk.openSheet('crypto:BTCUSDT'), ghostDesk.chooseSide('buy'), true")
    await asyncio.sleep(0.4)
    chips = await p.js("[...document.querySelectorAll('.chips.amt button')].map(b => b.textContent).join(' ')")
    amt = await p.js("document.getElementById('amtIn').value")
    ok_chips = chips == "$1K $5K $10K $50K $100K Max" and amt == "10000"
    print(("PASS " if ok_chips else "FAIL ") + f" Buy amounts follow the start: {chips} (default {amt})")
    if not ok_chips:
        fails.append("chips")
    await check("sheet buy at 1M")
    # Custom amount
    await p.js("ghostDesk.closeSheet(true), ghostDesk.openSettings(), true")
    await asyncio.sleep(0.4)
    await p.js("document.querySelector('[data-start=custom]').click(), true")
    await asyncio.sleep(0.2)
    bad = await p.js("(() => { const i = document.getElementById('startIn'); i.value = '50'; i.dispatchEvent(new Event('input', { bubbles: true })); const b = document.querySelector('[data-reset]'); return { dis: b.disabled, txt: b.textContent }; })()")
    good = await p.js("(() => { const i = document.getElementById('startIn'); i.value = '25000'; i.dispatchEvent(new Event('input', { bubbles: true })); const b = document.querySelector('[data-reset]'); return { dis: b.disabled, txt: b.textContent }; })()")
    await check("settings custom start")
    await p.js("document.querySelector('[data-reset]').click(), document.querySelector('[data-reset]').click(), true")
    await asyncio.sleep(1)
    s2 = await p.js("(() => { const s = ghostDesk.state(); return { start: s.start, cash: s.cash, total: document.getElementById('total').textContent }; })()")
    ok2 = bad["dis"] and good["txt"] == "Reset to $25K" and not good["dis"] and s2["start"] == 25000 and s2["cash"] == 25000 and s2["total"] == "$25K"
    print(("PASS " if ok2 else "FAIL ") + f" Custom start: $50 refused ({bad['txt']}), $25,000 accepted → {s2['total']}")
    if not ok2:
        fails.append("custom start")
    return fails


async def rival_tests(p, check):
    """Settings → add bots through the real buttons; bots trade on the live prices; leaderboard and bot history."""
    fails = []
    await p.js("ghostDesk.closeSheet(true), ghostDesk.openSettings(), true")
    await asyncio.sleep(0.4)
    for style in ["momentum", "degen", "random", "contrarian"]:
        await p.js(f"document.querySelector('[data-addbot={style}]').scrollIntoView(), document.querySelector('[data-addbot={style}]').click(), true")
        await asyncio.sleep(0.2)
    await p.js("document.querySelector('[data-addbot=momentum]').click(), true")
    await asyncio.sleep(0.3)
    names = await p.js("ghostDesk.bots().map(b => b.name + ':' + b.pf.start)")
    await check("settings bots")
    ok1 = names == ["Momentum:25000", "Degen:25000", "Random:25000", "Contrarian:25000", "Momentum 2:25000"]
    print(("PASS " if ok1 else "FAIL ") + f" Bots added from Settings, each as big as my portfolio: {names}")
    if not ok1:
        fails.append("add bots")
    # fresh live prices (as the app would receive them), then the bots take turns
    await p.js("""(() => { const g = ghostDesk, now = Date.now();
      for (const L of g.live.values()) if (L.px > 0) g.setLive(L.inst, { px: L.px, t: now }, { check: false });
      return true; })()""")
    made = await p.js("ghostDesk.botTick(Date.now()).map(([b, t]) => b.name + ' ' + t.side + ' ' + t.sym + ' $' + t.usd.toFixed(2) + ' (' + t.why + ')')")
    print("  Bot turns:", *made, sep="\n    ")
    mine = await p.js("ghostDesk.state().trades.length")
    ok2 = any(m.startswith("Momentum ") for m in made) and any(m.startswith("Degen ") for m in made) and mine == 0
    print(("PASS " if ok2 else "FAIL ") + f" Bots trade on their own portfolios (my trades still {mine})")
    if not ok2:
        fails.append("bot trades")
    await p.js("ghostDesk.closeSheet(true), ghostDesk.setTab('home'), true")
    await asyncio.sleep(0.4)
    lb = await p.js("[...document.querySelectorAll('#lbSlot .row.lb')].map(r => r.querySelector('.nm b').textContent.trim())")
    await check("home leaderboard")
    await p.js("ghostDesk.setTab('achievements'), true")
    await asyncio.sleep(0.4)
    await check("trophies leaderboard")
    rows = await p.js("[...document.querySelectorAll('#lbSlotFull .row.lb')].map(r => r.innerText.replace(/\\n/g, ' | '))")
    print("  Leaderboard:", *rows, sep="\n    ")
    ok3 = len(lb) == 6 and "You" in lb and all(("Best" in r and "Worst" in r and "%" in r and "$" in r) for r in rows)
    print(("PASS " if ok3 else "FAIL ") + " Leaderboard: me vs each bot with total, % gain, best and worst trade")
    if not ok3:
        fails.append("leaderboard")
    await p.js("[...document.querySelectorAll('#lbSlotFull [data-bot]')].find(r => r.textContent.includes('Degen')).click(), true")
    await asyncio.sleep(0.5)
    sheet = await p.js("document.querySelector('.sheet .sh-title h2')?.textContent + ' / ' + document.querySelectorAll('.sheet .tr').length + ' trades in its history'")
    print("  Bot sheet:", sheet)
    await check("bot sheet")
    ok4 = "trades in its history" in sheet and not sheet.endswith(" 0 trades in its history")
    print(("PASS " if ok4 else "FAIL ") + " Bot history sheet opens from the leaderboard")
    if not ok4:
        fails.append("bot sheet")
    # removing a bot takes two taps
    await p.js("ghostDesk.closeSheet(true), ghostDesk.openSettings(), true")
    await asyncio.sleep(0.3)
    await p.js("document.querySelector('[data-delbot]').click(), true")
    n1 = await p.js("ghostDesk.bots().length")
    await p.js("document.querySelector('[data-delbot]').click(), true")
    n2 = await p.js("ghostDesk.bots().length")
    ok5 = n1 == 5 and n2 == 4
    print(("PASS " if ok5 else "FAIL ") + f" Remove a bot with two taps ({n1} → {n2})")
    if not ok5:
        fails.append("remove bot")
    await p.js("ghostDesk.closeSheet(true), true")
    return fails


async def cheat_ui_tests(p, check):
    """Settings → Cheats with real taps: star on the portfolio, leverage + short through the slider, undo, X-ray, Time machine."""
    fails = []
    def res(good, text, key):
        print(("PASS " if good else "FAIL ") + " " + text)
        if not good:
            fails.append(key)
    enter = "document.querySelector('.swipe-thumb').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), true"
    await p.js("ghostDesk.closeSheet(true), ghostDesk.openSettings(), true")
    await asyncio.sleep(0.3)
    await p.js("document.querySelector('[data-cheats]').scrollIntoView(), document.querySelector('[data-cheats]').click(), true")
    await asyncio.sleep(0.4)
    n = await p.js("document.querySelectorAll('.sheet .cheat').length")
    clean = await p.js("document.querySelector('.sheet .cheat-note b').textContent")
    await check("cheats sheet")
    cash0 = await p.js("ghostDesk.state().cash")
    await p.js("document.querySelector('[data-print=\"10000\"]').click(), true")
    await asyncio.sleep(0.2)
    await p.js("document.querySelector('[data-cheat=zeroFees]').click(), document.querySelector('[data-lev=\"10\"]').click(), document.querySelector('[data-arm=ghost]').click(), true")
    await asyncio.sleep(0.3)
    st = await p.js("(() => { const s = ghostDesk.state(); return { cash: s.cash, zf: s.cheats.on.zeroFees, lev: s.cheats.lev, ghost: s.cheats.armed.ghost, star: !!document.querySelector('#totalPl .star'), note: document.querySelector('.sheet .cheat-note b').textContent }; })()")
    await check("cheats sheet on")
    res(n == 25 and clean == "Clean portfolio" and st["cash"] == cash0 + 10000 and st["zf"] and st["lev"] == 10 and st["ghost"] and st["star"] and "marked" in st["note"],
        f"Cheats menu: {n} cheats; Money printer +$10K ({cash0} → {st['cash']}); Zero fees, 10x and Ghost trade on; ★ in the header", "cheats menu")
    # 10x short through the real slider
    await p.js("ghostDesk.closeSheet(true), ghostDesk.openSheet('crypto:BTCUSDT'), true")
    await asyncio.sleep(0.5)
    btns = await p.js("[...document.querySelectorAll('.bs button')].map(b => b.textContent.trim())")
    await check("sheet btc 10x short buttons")
    await p.js("ghostDesk.chooseSide('short'), true")
    await asyncio.sleep(0.3)
    await p.js("document.querySelector('[data-amt=\"250\"]')?.click(), true")
    await asyncio.sleep(0.2)
    prev = await p.js("document.getElementById('quote').innerText")
    await check("sheet btc short 10x")
    await p.js(enter)
    await asyncio.sleep(0.5)
    mp = await p.js("(() => { const m = Object.values(ghostDesk.state().margin); const t = ghostDesk.state().trades.at(-1); return { n: m.length, lev: m[0]?.lev, dir: m[0]?.dir, fee: t?.fee, cheat: t?.cheat }; })()")
    res(btns == ["Buy 10x", "Sell", "Short 10x"] and "Liquidated at" in prev and mp["n"] == 1 and mp["lev"] == 10 and mp["dir"] == -1 and mp["fee"] == 0 and "Leverage 10x" in mp["cheat"] and "Zero fees" in mp["cheat"],
        f"Short 10x BTC with the slider: buttons {btns}; preview “{prev.splitlines()[1] if len(prev.splitlines()) > 1 else prev}”; trade ★ {mp['cheat']}", "short 10x")
    await p.js("ghostDesk.closeSheet(true), ghostDesk.setTab('portfolio'), true")
    await asyncio.sleep(0.4)
    lev_rows = await p.js("document.querySelectorAll('[data-mv]').length")
    await check("portfolio leveraged")
    await p.js("ghostDesk.setTab('history'), true")
    await asyncio.sleep(0.4)
    hist = await p.js("({ note: !!document.querySelector('.cheat-note'), tag: document.querySelector('.tr .cheat-tag')?.textContent, side: document.querySelector('.tr .side')?.textContent })")
    await check("history cheats star")
    await p.js("ghostDesk.setTab('achievements'), true")
    await asyncio.sleep(0.4)
    me = await p.js("[...document.querySelectorAll('#lbSlotFull .row.lb')].find(r => r.textContent.includes('You'))?.querySelector('.nm b').textContent")
    res(lev_rows == 1 and hist["note"] and "Leverage 10x" in (hist["tag"] or "") and hist["side"] == "short" and "★" in (me or ""),
        f"Star on the portfolio: leaderboard “{me}”, history note + trade “{hist['side']}” {hist['tag']}; leveraged row in Portfolio", "star")
    # X-ray on the leaderboard, then Undo the short
    await p.js("ghostDesk.openCheats(), true")
    await asyncio.sleep(0.3)
    await p.js("document.querySelector('[data-cheat=xray]').click(), true")
    undo_lbl = await p.js("document.querySelector('[data-undo]')?.textContent")
    await p.js("document.querySelector('[data-undo]').click(), true")
    await asyncio.sleep(0.3)
    after = await p.js("({ m: Object.keys(ghostDesk.state().margin).length, cash: ghostDesk.state().cash })")
    await p.js("ghostDesk.closeSheet(true), ghostDesk.setTab('achievements'), true")
    await asyncio.sleep(0.4)
    xr = await p.js("[...document.querySelectorAll('#lbSlotFull .xray')].map(x => x.textContent)")
    await check("leaderboard xray")
    res(after["m"] == 0 and after["cash"] == cash0 + 10000 and len(xr) == 4 and all(x.startswith("🩻") for x in xr),
        f"Undo ({undo_lbl}) → no position, cash {after['cash']}; X-ray on {len(xr)} bots: {xr[0] if xr else ''}", "undo xray")
    # Time machine on hand-made 1-minute candles (the app loads real ones from Binance / GeckoTerminal / Twelve Data)
    await p.js("""(() => { const day = new Date(); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - 1);
      const bars = []; for (let i = 0; i < 1800; i++) { const c = 60000 + 300 * Math.sin(i / 40) + i; bars.push({ t: day.getTime() - 7200e3 + i * 60e3, o: c - 5, h: c + 20, l: c - 25, c }); }
      ghostDesk.startReplay('crypto:BTCUSDT', day.getTime(), bars); return true; })()""")
    await asyncio.sleep(0.6)
    await check("time machine")
    px0 = await p.js("document.getElementById('rpPx').textContent")
    await p.js("document.querySelector('[data-rpspeed=\"60\"]').click(), true")
    await asyncio.sleep(2.2)
    px1 = await p.js("document.getElementById('rpPx').textContent")
    await p.js("document.querySelector('[data-rpbuy=\"0.1\"]').click(), true")
    await asyncio.sleep(0.3)
    await p.js("document.querySelector('[data-rp=peek]').click(), true")
    await asyncio.sleep(0.3)
    await check("time machine peek")
    await p.js("document.querySelector('[data-rp=hour]').click(), true")
    await asyncio.sleep(0.3)
    rp = await p.js("(() => { const r = ghostDesk.replay(); return { trades: r.pf.trades.length, playing: r.playing, peek: r.peek, skips: r.skips, mine: ghostDesk.state().trades.filter(t => t.reason === 'replay').length }; })()")
    await check("time machine skip")
    res(px0 != px1 and rp["trades"] == 1 and rp["skips"] == 1 and rp["mine"] == 0,
        f"Time machine: 60x moved the price {px0} → {px1}, bought in the replay, Peek, +1 hour; real portfolio untouched", "time machine")
    # Always on: the card says so, the list at the top too, and the cheat arms itself again after a trade
    await p.js("ghostDesk.closeSheet(true), ghostDesk.openCheats(), true")
    await asyncio.sleep(0.3)
    await p.js("document.querySelector('[data-always=golden]').click(), document.querySelector('[data-always=sniper]').click(), true")
    await asyncio.sleep(0.3)
    al = await p.js("(() => { const card = document.querySelector('[data-always=golden]').closest('.cheat'); return { cls: card.classList.contains('always'), tag: card.querySelector('.always-tag')?.textContent, list: document.querySelector('.always-list')?.textContent, armed: ghostDesk.state().cheats.armed.golden, n: document.querySelectorAll('[data-always]').length }; })()")
    await check("cheats always on")
    await p.js("ghostDesk.state().cheats.armed.golden = false, ghostDesk.afterTrades([]), true")
    rearmed = await p.js("ghostDesk.state().cheats.armed.golden")
    res(al["cls"] and al["tag"] == "ALWAYS ON" and "Golden entry" in (al["list"] or "") and "Sniper" in (al["list"] or "") and al["armed"] and rearmed and al["n"] == 7,
        f"Always on: {al['n']} one-shot cheats have it; Golden entry card “{al['tag']}”, list “{al['list']}”; used up → armed again: {rearmed}", "always on")
    await p.js("document.querySelector('[data-always=golden]').click(), document.querySelector('[data-always=sniper]').click(), true")
    # Oracle and Skip ahead exist only in Sim: off in Live with "Sim only"
    so = await p.js("(() => { const c = document.querySelector('[data-cheat=oracle]'); return { dis: c?.disabled, note: c?.closest('.cheat').querySelector('.sim-only')?.textContent }; })()")
    await p.js("ghostDesk.closeSheet(true), ghostDesk.openSheet('crypto:BTCUSDT'), true")
    await asyncio.sleep(0.5)
    sk = await p.js("(() => { const r = document.querySelector('.skip'); return { off: r?.classList.contains('off'), dis: [...r.querySelectorAll('[data-skip]')].every(b => b.disabled), note: r?.querySelector('.sim-only')?.textContent }; })()")
    await check("live skip sim only")
    res(so["dis"] and so["note"] == "Sim only" and sk["off"] and sk["dis"] and sk["note"] == "Sim only",
        f"Live: Oracle off “{so['note']}”, Skip ahead buttons off “{sk['note']}”", "sim only")
    # Double or nothing: a confirmation first, every time; a loss drops the whole portfolio to $100
    await p.js("ghostDesk.closeSheet(true), true")
    win = "(() => { const s = ghostDesk.state(); s.trades.push({ id: 'w' + Date.now(), t: Date.now(), side: 'sell', key: 'crypto:BTCUSDT', sym: 'BTC', m: 'crypto', qty: 0.01, px: 66000, usd: 660, cost: 600, pl: 60, plPct: 0.1, fee: 0, reason: 'manual' }); return s.trades.at(-1); })()"
    await p.js(win)
    await p.js("ghostDesk.openCheats(), true")
    await asyncio.sleep(0.3)
    await p.js("document.querySelector('[data-don]').click(), true")
    await asyncio.sleep(0.3)
    cf = await p.js("(() => { const c = document.getElementById('confirm'); return { shown: !c.hidden, warn: c.querySelector('.warn-big')?.textContent, flip: !!c.querySelector('[data-donflip]') }; })()")
    await check("double or nothing confirm")
    await p.js("document.querySelector('[data-donno]').click(), true")
    await asyncio.sleep(0.2)
    kept = await p.js("({ hidden: document.getElementById('confirm').hidden, flip: ghostDesk.state().trades.at(-1).flip || null })")
    total0 = await p.js("ghostDesk.E.totals(ghostDesk.state(), () => null).total")
    await p.js("document.querySelector('[data-don]').click(), true")
    await asyncio.sleep(0.2)
    await p.js("document.querySelector('[data-donflip]').click(), true")
    await asyncio.sleep(0.4)
    fl = await p.js("(() => { const s = ghostDesk.state(); return { flip: s.trades.at(-1).flip, cash: s.cash, pos: Object.keys(s.pos).length + Object.keys(s.margin).length + s.orders.length, pl: s.trades.at(-1).pl }; })()")
    lost_ok = fl["flip"] == "lost" and fl["cash"] == 100 and fl["pos"] == 0
    won_ok = fl["flip"] == "won" and abs(fl["pl"] - 120) < 1e-6
    res(cf["shown"] and cf["warn"] == "If you lose, your whole portfolio drops to $100" and cf["flip"] and kept["hidden"] and kept["flip"] is None and (lost_ok or won_ok),
        f"Double or nothing: confirmation “{cf['warn']}”; “Not this time” keeps it; flipped → {fl['flip']} (cash {fl['cash']}, {fl['pos']} positions left, was {total0:.2f})", "double or nothing")
    # Always on Double or nothing: the confirmation comes back after every win
    await p.js("document.querySelector('[data-always=don]').click(), ghostDesk.closeSheet(true), true")
    t = await p.js(win.replace("return s.trades.at(-1); })()", "ghostDesk.afterTrades([s.trades.at(-1)]); return true; })()"))
    await asyncio.sleep(1.3)
    again = await p.js("({ shown: !document.getElementById('confirm').hidden, warn: document.querySelector('#confirm .warn-big')?.textContent, always: !!document.querySelector('#confirm') && document.getElementById('confirm').textContent.includes('Always on') })")
    await check("double or nothing always on")
    await p.js("document.querySelector('[data-donno]')?.click(), ghostDesk.openCheats(), true")
    await asyncio.sleep(0.3)
    await p.js("document.querySelector('[data-always=don]').click(), ghostDesk.closeSheet(true), true")
    res(again["shown"] and again["warn"] == "If you lose, your whole portfolio drops to $100" and again["always"],
        "Double or nothing on Always on: after the next win the same confirmation shows by itself", "don always")
    # Tap an abbreviated number: the full one
    await p.js("ghostDesk.setTab('portfolio'), true")
    await asyncio.sleep(0.3)
    hd = await p.js("(() => { const s = ghostDesk.state(); s.cash = 1234567.89; ghostDesk.renderAll(); const el = document.getElementById('total'); el.click(); return { txt: el.textContent, full: el.dataset.full, toast: document.getElementById('toast').textContent }; })()")
    await check("tap full number")
    res(hd["txt"] == "$1.23M" and hd["full"] == "$1,234,567.89" and hd["toast"] == "$1,234,567.89",
        f"Big numbers: header {hd['txt']}, tap → “{hd['toast']}”", "abbr tap")
    # Cheats with missing data: the trade always goes on, no red notice
    miss = await p.js("""(async () => { const g = ghostDesk, out = [], wait = ms => new Promise(r => setTimeout(r, ms)); const toastEl = document.getElementById('toast');
      const enter = () => document.querySelector('.swipe-thumb').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const keep = structuredClone(g.state().cheats), now = g.appNow(), bar = (t, l, h) => ({ t, o: l, h, l, c: l });
      const K = { meme: 'meme:MISSINGDATA1', crypto: 'crypto:MISSUSDT' };
      g.setLive({ key: K.meme, m: 'meme', id: 'MISSINGDATA1', sym: 'MISS', name: 'Miss', pair: 'P', born: now - 9e8 }, { px: 1, t: now, liq: 1e9 });
      g.setLive({ key: K.crypto, m: 'crypto', id: 'MISSUSDT', sym: 'MISSC', name: 'Missc' }, { px: 100, t: now });
      g.state().cash = 50000;
      const go = async (id, key, side, candles) => { delete window.__firstCandle; window.__candles = candles; toastEl.hidden = true; toastEl.className = 'toast';
        const c = g.state().cheats; c.on = {}; c.armed = {}; c.always = {}; c.lev = 1; c.armed[id] = true; const n = g.state().trades.length;
        g.closeSheet(true); g.openSheet(key); await wait(150); g.chooseSide(side); await wait(100);
        if (side === 'buy') { document.querySelector('[data-amt="max"]').click(); await wait(50); const a = document.getElementById('amtIn'); a.value = 100; a.oninput(); }
        await wait(80); enter(); await wait(400);
        const t = g.state().trades.slice(n)[0]; out.push({ id, ok: !!t, mid: t?.mid, tag: (t?.cheat || []).join(), armed: !!g.state().cheats.armed[id], red: toastEl.classList.contains('down') && !toastEl.hidden, line: toastEl.textContent }); };
      await go('sniper', K.meme, 'buy', []); await go('golden', K.crypto, 'buy', []); await go('perfect', K.crypto, 'sell', []);
      await go('sniper', K.meme, 'buy', [bar(now - 6e8, 0.4, 2), bar(now - 5e8, 0.25, 2)]); await go('golden', K.crypto, 'buy', [bar(now - 120000, 80, 90)]); await go('perfect', K.crypto, 'sell', [bar(now - 120000, 80, 130)]);
      window.__candles = undefined; g.closeSheet(true); g.state().cheats = keep; for (const k of Object.values(K)) { delete g.state().pos[k]; g.live.delete(k); } return out; })()""")
    await asyncio.sleep(2)
    none, part = miss[:3], miss[3:]
    res(all(x["ok"] and x["armed"] and not x["tag"] and not x["red"] for x in none) and all(x["ok"] and not x["armed"] and not x["red"] and "price available" in x["tag"] for x in part)
        and [x["mid"] for x in part] == [0.25, 80, 130],
        f"Cheats with missing data: none → normal trade, still armed; some → {[(x['tag'], x['mid']) for x in part]}; line “{part[0]['line']}”", "missing data")
    # Money cap: World's richest notice, ladder in Trophies, source and date in Settings
    cap = await p.js("ghostDesk.RICH.WORLD_CAP")
    await p.js(f"(() => {{ const s = ghostDesk.state(); s.cash = {cap} - 5000; ghostDesk.renderAll(); return true; }})()")
    await p.js("ghostDesk.openCheats(), true")
    await asyncio.sleep(0.3)
    await p.js("document.querySelector('[data-print=\"10000\"]').click(), true")
    await asyncio.sleep(1.2)
    rc = await p.js("({ cash: ghostDesk.state().cash, tag: document.querySelector('#totalPl .rich-tag')?.textContent, total: document.getElementById('total').textContent, toast: document.getElementById('toast').textContent })")
    await p.js("ghostDesk.closeSheet(true), ghostDesk.setTab('achievements'), true")
    await asyncio.sleep(0.4)
    fx1 = await p.js("document.getElementById('levelFx').hidden ? '' : document.getElementById('levelFx').innerText.split(String.fromCharCode(10)).join(' ')")
    await check("level unlocked")
    await p.js("document.getElementById('levelFx').click(), true")
    lad = await p.js("(() => { const l = document.querySelector('.ladder'); return { h: l?.previousElementSibling?.textContent, p: l?.querySelector('p')?.textContent, me: l?.querySelector('.lad.me .rk')?.textContent, rows: l?.querySelectorAll('.lad').length, src: l?.querySelector(':scope > small')?.textContent }; })()")
    await check("billionaire ladder")
    await p.js("ghostDesk.openSettings(), true")
    await asyncio.sleep(0.3)
    capbox = await p.js("document.getElementById('capBox')?.textContent || ''")
    res(abs(rc["cash"] - cap) < 0.01 and "World's richest" in (rc["tag"] or "") and "100 richest" in rc["toast"] and rc["total"] == "$7.27T"
        and lad["h"] == "Country ladder" and lad["me"] == "#3" and "China" in (lad["p"] or "") and "World Bank" in (lad["src"] or "") and "UNLOCKED" in fx1 and "Countries" in fx1 and "UBS" in capbox and "2025" in capbox
        and "Forbes Real-Time Billionaires" in capbox and "2026" in capbox,
        f"Money cap: printing at the top keeps it at {rc['total']} (cash {rc['cash'] - cap:+.2f} vs the cap) with “{rc['tag']}”, toast “{rc['toast'][:60]}”; ladder {lad['me']} “{lad['p']}” (heading {lad['h']!r}, source {lad['src'][:40]!r}); Settings: {capbox[capbox.find('Figure'):][:70]}", "money cap")
    # World, the last cap and Prestige
    lv = await p.js("""(async () => { const g = ghostDesk, s = g.state(), fx = document.getElementById('levelFx'), seen = [], wait = ms => new Promise(r => setTimeout(r, ms));
      for (let k = 0; k < 2; k++) { g.E.addCash(s, 1e15); g.renderAll(); await wait(300); seen.push(fx.hidden ? '' : fx.innerText.replace(/\\n/g, ' ')); fx.click(); await wait(100); }
      g.closeSheet(true); g.setTab('achievements'); await wait(300);
      return { seen, level: s.level, reached: s.reached.length, btn: document.querySelector('[data-prestige]')?.textContent, h: document.querySelector('.ladder').previousElementSibling.textContent }; })()""")
    await check("prestige ready")
    pr = await p.js("""(async () => { const g = ghostDesk, wait = ms => new Promise(r => setTimeout(r, ms)); const b = document.querySelector('[data-prestige]'); b.click(); const sure = b.textContent; const before = g.state().start; b.click(); await wait(700);
      const fx = document.getElementById('levelFx').innerText; return { sure, fx, cash: g.state().cash, start: g.state().start, level: g.state().level || 0, bots: g.bots().map(x => x.pf.cash), badges: g.badges().length, tag: document.querySelector('#totalPl .prest')?.textContent,
      disk: (await g.kv.get('achievements')).prestige?.length, diskCash: (await g.kv.get('portfolio')).cash }; })()""")
    await check("prestige done")
    await p.js("document.getElementById('levelFx').click(), ghostDesk.setTab('achievements'), true")
    await asyncio.sleep(0.4)
    await check("prestige badge")
    res("World" in lv["seen"][0] and "THE WORLD" in lv["seen"][1] and lv["level"] == 2 and lv["reached"] == 3 and "Prestige 1" in (lv["btn"] or "") and "Tap again" in pr["sure"] and "PRESTIGE" in pr["fx"]
        and pr["cash"] == 10000 and pr["start"] == 10000 and pr["level"] == 0 and all(x == 10000 for x in pr["bots"]) and pr["badges"] == 1 and pr["disk"] == 1 and pr["diskCash"] == 10000 and pr["tag"],
        f"Levels: {lv['seen']}; “{lv['btn']}” asks first, then $10K for me and {len(pr['bots'])} bots, badge {pr['tag']} kept and saved", "prestige")
    await p.js("ghostDesk.state().cheats || ghostDesk.C.mark(ghostDesk.state(), 'printer', 'test', ghostDesk.appNow()), true")
    await p.js("(() => { const s = ghostDesk.state(); s.cash = 1000; ghostDesk.renderAll(); return true; })()")
    await p.js("ghostDesk.closeSheet(true), ghostDesk.setTab('achievements'), true")
    await asyncio.sleep(0.4)
    lad2 = await p.js("(() => { const l = document.querySelector('.ladder'); return { p: l?.querySelector('p')?.textContent, me: l?.querySelector('.lad.me .rk')?.textContent }; })()")
    res(lad2["me"] == "#101+" and "#100 is" in (lad2["p"] or "") and "to go" in (lad2["p"] or ""), f"Ladder at $1K: {lad2['me']} “{lad2['p']}”", "ladder low")
    # Bots cheat: Rival moves and a ★ on their row; the switch in Settings → Rival bots turns it off
    b0 = await p.js("ghostDesk.bots()[0]?.name")
    await p.js("(() => { const b = ghostDesk.bots()[0]; b.pf.cash *= 0.5; b.printerDay = null; ghostDesk.botTick(); ghostDesk.renderAll(); return true; })()")
    await p.js("ghostDesk.setTab('home'), true")
    await asyncio.sleep(0.4)
    feed = await p.js("[...document.querySelectorAll('#botFeed .feed.cheat')].map(x => x.textContent).find(x => x.includes('Money printer')) || ''")
    await check("bot cheat feed")
    await p.js("ghostDesk.setTab('achievements'), true")
    await asyncio.sleep(0.4)
    bc = await p.js(f"(() => {{ const row = [...document.querySelectorAll('#lbSlotFull .row.lb')].find(r => r.textContent.includes({b0!r})); return {{ star: !!row?.querySelector('.star'), feed: [...document.querySelectorAll('.feed.cheat')].map(x => x.textContent)[0] || '' }}; }})()")
    await check("bot cheat star")
    await p.js("ghostDesk.openSettings(), true")
    await asyncio.sleep(0.3)
    tog = await p.js("(() => { const t = document.getElementById('botCheatsTog'); const was = t.checked; t.click(); return { was, now: ghostDesk.cfg().botCheats }; })()")
    await p.js("document.getElementById('botCheatsTog').click(), true")
    bc["feed"] = feed
    res(bc["star"] and "Money printer" in bc["feed"] and tog["was"] and tog["now"] is False,
        f"Bots cheat: {b0} ★ on the leaderboard, Rival moves “{bc['feed'][:70]}”; “Bots can cheat” on by default and can be turned off", "bot cheats")
    # Reset removes the star
    await p.js("ghostDesk.closeSheet(true), ghostDesk.openSettings(), true")
    await asyncio.sleep(0.3)
    await p.js("document.querySelector('[data-reset]').scrollIntoView(), document.querySelector('[data-reset]').click(), document.querySelector('[data-reset]').click(), true")
    await asyncio.sleep(1)
    gone = await p.js("({ cheats: ghostDesk.state().cheats || null, star: !!document.querySelector('#totalPl .star') })")
    res(gone["cheats"] is None and not gone["star"], "Reset: the ★ is gone from the new portfolio", "reset star")
    return fails


async def cheats_live_check(p):
    """Real app, real sources: Time machine loads yesterday's BTC 1-minute candles; Golden entry and Sniper fill at real prices."""
    await p.send("Emulation.setDeviceMetricsOverride", width=375, height=812, deviceScaleFactor=2, mobile=True)
    await p.goto(BASE + "/index.html#home", "!!document.querySelector('#view .cd-card')")
    await p.js("""(async () => { const st = await import('./js/store.js'), E = await import('./js/core/engine.js');
      await st.openStore(); await st.kv.set('portfolio', E.newPortfolio(Date.now())); await st.kv.set('bots', { v: 1, list: [] }); return true; })()""")
    await p.goto(BASE + "/index.html?r=4#markets", "!!document.querySelector('#view .row')")
    await asyncio.sleep(15)
    click = lambda sel: p.js(f"(() => {{ const e = document.querySelector({sel!r}); if (!e) return false; e.scrollIntoView(); e.click(); return true; }})()")
    # Time machine: BTC, yesterday
    await click("[data-tab=home]")
    await p.js("document.querySelector('[data-settings], .gear, #gear')?.click() || true")
    await asyncio.sleep(0.5)
    await click("[data-cheats]")
    await asyncio.sleep(0.5)
    await p.js("(() => { const s = document.getElementById('tmInst'); s.value = 'crypto:BTCUSDT'; return true; })()")
    await click("[data-tm]")
    await asyncio.sleep(10)
    clock = await p.js("document.getElementById('rpClock')?.textContent")
    px = await p.js("document.getElementById('rpPx')?.textContent")
    print("Time machine:", clock, "| price", px)
    await click("[data-rp=peek]")
    await asyncio.sleep(0.4)
    await p.shot("live-time-machine")
    await click("[data-rp=hour]")
    await asyncio.sleep(0.4)
    print("After +1 hour:", await p.js("document.getElementById('rpClock')?.textContent"), "| price", await p.js("document.getElementById('rpPx')?.textContent"))
    tm_ok = bool(clock) and "$" in (px or "")
    await click("[data-close]")
    await asyncio.sleep(0.5)
    # Golden entry on BTC: arm it, buy $1,000 with the slider (keyboard), read the fill
    await p.js("document.querySelector('[data-settings], .gear, #gear')?.click() || true")
    await asyncio.sleep(0.4)
    await click("[data-cheats]")
    await asyncio.sleep(0.4)
    await click("[data-arm=golden]")
    await click("[data-arm=sniper]")
    await click("[data-close]")
    await asyncio.sleep(0.4)
    await p.js("(() => { const b = document.createElement('button'); b.dataset.open = 'crypto:BTCUSDT'; b.hidden = true; document.body.append(b); b.click(); b.remove(); return true; })()")
    await asyncio.sleep(5)
    live_px = await p.js("document.querySelector('.sh-body .big')?.textContent")
    await click("[data-side=buy]")
    await asyncio.sleep(0.3)
    await p.js("(() => { const i = document.getElementById('amtIn'); i.value = '1000'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()")
    await asyncio.sleep(0.3)
    print("Trade box:", (await p.js("document.getElementById('quote').innerText")).replace(chr(10), " | "))
    await p.js("document.querySelector('.swipe-thumb').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), true")
    await asyncio.sleep(6)
    await click("[data-close]")
    await asyncio.sleep(0.4)
    # Sniper on the newest memecoin of the "New" list
    await click("[data-tab=markets]")
    await click(".seg.mk [data-market=meme]")
    await click("[data-memeview=new]")
    await asyncio.sleep(10)
    await click("#view .row")
    await asyncio.sleep(5)
    meme_px = await p.js("document.querySelector('.sh-body .big')?.textContent")
    await click("[data-side=buy]")
    await asyncio.sleep(0.3)
    await p.js("(() => { const i = document.getElementById('amtIn'); i.value = '100'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()")
    await p.js("document.querySelector('.swipe-thumb').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), true")
    await asyncio.sleep(8)
    toast = await p.js("document.getElementById('toast').innerText")
    await p.shot("live-sniper")
    await asyncio.sleep(1)
    st = await p.js("""(async () => { const st = await import('./js/store.js'); const s = await st.kv.get('portfolio');
      return { trades: s.trades.map(t => [t.sym, t.side, +t.mid.toPrecision(8), t.cheat || []]), armed: s.cheats?.armed }; })()""")
    print("Live BTC price on the sheet:", live_px, "| memecoin price:", meme_px, "| last notice:", toast)
    for t in st["trades"]:
        print("  trade:", *t)
    print("  still armed:", {k: v for k, v in (st["armed"] or {}).items() if v})
    golden = [t for t in st["trades"] if "Golden entry" in t[3]]
    live_num = float((live_px or "0").replace("$", "").replace(",", "") or 0)
    g_ok = bool(golden) and golden[0][2] <= live_num * 1.0001
    print(("PASS " if tm_ok else "FAIL ") + " Time machine loaded yesterday's real BTC candles")
    print(("PASS " if g_ok else "FAIL ") + f" Golden entry filled BTC at {golden[0][2] if golden else '—'}, the 15-minute low (live was {live_px})")
    print("INFO  Sniper:", "filled at the first candle" if any("Sniper" in t[3] for t in st["trades"]) else "not filled: " + (toast or ""))
    if p.events:
        print("Console:", *p.events[:10], sep=chr(10) + "  ")
    await p.js("""(async () => { const st = await import('./js/store.js'), E = await import('./js/core/engine.js'); await st.kv.set('portfolio', E.newPortfolio(Date.now())); return true; })()""")
    return tm_ok and g_ok and not p.events


async def sim_ui_tests(p, check):
    """Live / Sim switch with a real tap; invented markets; event banner; combo; jackpot; records; Live untouched."""
    fails = []
    def res(good, text, key):
        print(("PASS " if good else "FAIL ") + " " + text)
        if not good:
            fails.append(key)
    async def wait(expr, timeout):
        t0 = time.time()
        while time.time() - t0 < timeout:
            await asyncio.sleep(0.3)
            try:
                if await p.js(expr):
                    return True
            except Exception:
                pass
        return False
    enter = "document.querySelector('.swipe-thumb').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), true"
    await p.js("ghostDesk.closeSheet(true), ghostDesk.setTab('home'), true")
    await asyncio.sleep(0.3)
    live0 = await p.js("({ cash: ghostDesk.state().cash, trades: ghostDesk.state().trades.length, start: ghostDesk.state().start })")
    sw = await p.js("[...document.querySelectorAll('.mode button')].map(b => b.textContent.trim() + ':' + b.getAttribute('aria-pressed'))")
    await p.js("document.getElementById('simBtn').click(), true")
    await wait("document.body.classList.contains('sim') && document.documentElement.dataset.ready === '1'", 15)
    await asyncio.sleep(0.6)
    info = await p.js("""(() => { const g = ghostDesk, L = g.lists; return { sim: g.isSim(), label: document.querySelector('.total-box small').textContent,
      pressed: document.getElementById('simBtn').getAttribute('aria-pressed'), crypto: L.crypto.length, stock: L.stock.length, fx: L.fx.length, meme: L.meme.new.length,
      names: L.crypto.slice(0, 3).map(k => g.live.get(k).inst.sym), real: L.crypto.includes('crypto:BTCUSDT'), cash: g.state().cash, trades: g.state().trades.length }; })()""")
    await check("sim home")
    res(sw == ["Connecting:true", "Sim:false"] or sw[1] == "Sim:false", f"Live / Sim switch at the top: {sw}", "switch")
    res(info["sim"] and info["pressed"] == "true" and info["label"] == "Your Sim portfolio" and info["crypto"] == 14 and info["stock"] == 14 and info["fx"] == 8 and info["meme"] >= 20 and not info["real"] and info["trades"] == 0,
        f"Sim mode: “{info['label']}”, {info['crypto']} crypto ({', '.join(info['names'])}…), {info['stock']} stocks, {info['fx']} forex, {info['meme']} memecoins; own portfolio {info['cash']}", "sim mode")
    for m in ["meme", "crypto", "stock", "fx"]:
        await p.js(f"ghostDesk.setTab('markets'), document.querySelector('.seg.mk [data-market=\"{m}\"]').click(), true")
        await asyncio.sleep(0.4)
        await check("sim markets " + m)
    # prices move each second; new coins appear
    mv = await p.js("""(() => { const g = ghostDesk, w = g.sim(), k = g.lists.crypto[0], a = g.live.get(k).px, n0 = w.coinN;
      for (let i = 1; i <= 12; i++) g.simAdvance(w.t + 1000);
      return { a, b: g.live.get(k).px, coins: w.coinN - n0, open: !!document.querySelector('.mkt.open, .cd-strip.sim') || true }; })()""")
    res(mv["a"] != mv["b"] and mv["coins"] >= 1, f"Prices move every second ({mv['a']:.6g} → {mv['b']:.6g}); {mv['coins']} new memecoins in 12 s", "moves")
    # a memecoin sheet: Sim candles, buy with the slider
    key = await p.js("(() => { const w = ghostDesk.sim(); const i = ghostDesk.lists.meme.new.map(k => w.insts[k]).find(i => !i.dead && i.b1.length > 3); i.fate.rugAt = null; i.fate.mult = 0; return i.key; })()")
    await p.js(f"ghostDesk.closeSheet(true), ghostDesk.openSheet('{key}'), true")
    await asyncio.sleep(0.7)
    await check("sim sheet memecoin")
    note = await p.js("document.getElementById('chartNote')?.textContent")
    await p.js("ghostDesk.chooseSide('buy'), true")
    await asyncio.sleep(0.2)
    await p.js("document.querySelector('[data-amt=\"500\"]').click(), true")
    await asyncio.sleep(0.2)
    await p.js(enter)
    await asyncio.sleep(0.5)
    t = await p.js("(() => { const t = ghostDesk.state().trades.at(-1); return t ? { sym: t.sym, usd: t.usd, fee: t.fee } : null; })()")
    res(bool(t) and abs(t["usd"] - 500) < 1e-9 and abs(t["fee"] - 5) < 1e-9 and "Sim candles" in (note or ""),
        f"Bought $500 of {t and t['sym']} (fee {t and t['fee']}, same 1% as Live); chart “{note}”", "sim buy")
    # Jackpot: the coin goes 12x
    await p.js(f"(() => {{ const g = ghostDesk, w = g.sim(); w.insts['{key}'].px *= 12; g.simAdvance(w.t + 1000); return true; }})()")
    await asyncio.sleep(0.5)
    jp = await p.js("({ shown: !document.getElementById('jackpot').hidden, text: document.getElementById('jackpot').innerText.replace(/\\n/g, ' '), shake: document.getElementById('app').classList.contains('shake') || true, rec: ghostDesk.rec().jackpot })")
    await p.shot("sim-jackpot")
    res(jp["shown"] and "JACKPOT" in jp["text"] and jp["rec"] and jp["rec"]["mult"] >= 10, f"JACKPOT at 10x+: “{jp['text']}”", "jackpot")
    await p.js("document.getElementById('jackpot').click(), true")
    # sell it (a win), then two more wins on crypto: combo x2, x3
    await p.js("ghostDesk.chooseSide('sell'), true")
    await asyncio.sleep(0.2)
    await p.js("document.querySelector('[data-frac=\"1\"]')?.click(), true")
    await asyncio.sleep(0.2)
    await p.js(enter)
    await asyncio.sleep(0.5)
    for k in range(2):
        ck = await p.js(f"ghostDesk.lists.crypto[{k + 1}]")
        await p.js(f"ghostDesk.closeSheet(true), ghostDesk.openSheet('{ck}'), true")
        await asyncio.sleep(0.4)
        await p.js("ghostDesk.chooseSide('buy'), true")
        await asyncio.sleep(0.15)
        await p.js("document.querySelector('[data-amt=\"500\"]').click(), true")
        await asyncio.sleep(0.15)
        await p.js(enter)
        await asyncio.sleep(0.4)
        await p.js(f"(() => {{ const g = ghostDesk, w = g.sim(); w.insts['{ck}'].px *= 1.2; g.simAdvance(w.t + 1000); return true; }})()")
        await p.js("ghostDesk.chooseSide('sell'), true")
        await asyncio.sleep(0.15)
        await p.js("document.querySelector('[data-frac=\"1\"]')?.click(), true")
        await asyncio.sleep(0.15)
        await p.js(enter)
        await asyncio.sleep(0.5)
    await p.js("ghostDesk.closeSheet(true), document.getElementById('jackpot').hidden = true, true")
    await asyncio.sleep(0.3)
    combo = await p.js("({ text: document.getElementById('combo').hidden ? '' : document.getElementById('combo').textContent, wins: ghostDesk.rec().wins, sells: ghostDesk.state().trades.filter(t => t.side === 'sell').map(t => +t.pl.toFixed(2)) })")
    await check("sim combo")
    res(combo["wins"] == 3 and "x3" in combo["text"], f"Combo: “{combo['text']}” after sales {combo['sells']}", "combo")
    # Event with a giant banner and a real countdown
    ev = await p.js("(() => { const e = ghostDesk.simForce('elonTweet'); return { title: e.title, until: e.until }; })()")
    await asyncio.sleep(1.3)
    ban = await p.js("({ t: document.querySelector('.sim-event .se-t b')?.textContent, cd1: document.querySelector('.sim-event .se-cd')?.textContent, h: document.querySelector('.sim-event')?.getBoundingClientRect().height })")
    await asyncio.sleep(1.1)
    cd2 = await p.js("document.querySelector('.sim-event .se-cd')?.textContent")
    await check("sim event banner")
    res(ban["t"] == "Elon tweet" and ban["cd1"] and ban["cd1"] != cd2 and ban["h"] >= 60, f"Event banner “{ban['t']}”, {round(ban['h'] or 0)} px tall, countdown {ban['cd1']} → {cd2}", "event")
    # Records on the Trophies tab; sounds off by default
    await p.js("ghostDesk.setTab('achievements'), true")
    await asyncio.sleep(0.5)
    rec = await p.js("[...document.querySelectorAll('.rec > div')].map(d => d.innerText.replace(/\\n/g, ' '))")
    await check("sim records")
    await p.js("ghostDesk.openSettings(), true")
    await asyncio.sleep(0.3)
    snd = await p.js("document.getElementById('simSoundTog')?.checked")
    await check("sim settings")
    res(len(rec) == 4 and "x3" in rec[0] and "x" in rec[1] and "3 wins" in rec[3] and snd is False, f"Sim records: {rec}; Sim sounds start off", "records")
    # A rug pull on a coin you hold: RUG PULL screen and the worst-rug record
    rk = await p.js("(() => { const w = ghostDesk.sim(); const i = ghostDesk.lists.meme.new.map(k => w.insts[k]).find(i => !i.dead); i.fate.rugAt = null; return i.key; })()")
    await p.js(f"ghostDesk.closeSheet(true), ghostDesk.openSheet('{rk}'), true")
    await asyncio.sleep(0.5)
    await p.js("ghostDesk.chooseSide('buy'), true")
    await asyncio.sleep(0.15)
    await p.js("document.querySelector('[data-amt=\"500\"]').click(), true")
    await asyncio.sleep(0.15)
    await p.js(enter)
    await asyncio.sleep(0.4)
    await p.js(f"(() => {{ const g = ghostDesk, w = g.sim(); w.insts['{rk}'].fate.rugAt = w.t + 500; g.simAdvance(w.t + 1000); return true; }})()")
    await asyncio.sleep(0.4)
    rug = await p.js("({ text: document.getElementById('result').hidden ? '' : document.getElementById('result').innerText.split(String.fromCharCode(10)).join(' '), rec: ghostDesk.rec().rug })")
    await p.shot("sim-rug")
    res("RUG PULL" in rug["text"] and rug["rec"] and rug["rec"]["usd"] > 400, f"Rug pull on a coin you hold: “{rug['text']}”; worst rug {rug['rec'] and round(rug['rec']['usd'], 2)}", "rug")
    await p.js("ghostDesk.closeSheet(true), true")
    # Cheats work in Sim, on the Sim portfolio
    c0 = await p.js("ghostDesk.state().cash")
    await p.js("ghostDesk.openCheats(), true")
    await asyncio.sleep(0.3)
    await p.js("document.querySelector('[data-print=\"10000\"]').click(), true")
    await asyncio.sleep(0.3)
    c1 = await p.js("({ cash: ghostDesk.state().cash, star: !!document.querySelector('#totalPl .star') })")
    res(abs(c1["cash"] - c0 - 10000) < 1e-6 and c1["star"], f"Cheats in Sim: Money printer {c0:.2f} → {c1['cash']:.2f}, ★ on the Sim portfolio", "sim cheats")
    # Last chance: buy, the price falls 15% from its high → big warning with a Sell button
    await p.js("ghostDesk.closeSheet(true), document.getElementById('jackpot').hidden = true, document.getElementById('result').hidden = true, true")
    earlier = await p.js("(() => { const el = document.getElementById('lastChance'); const t = el.hidden ? '' : el.innerText.split(String.fromCharCode(10))[1]; document.querySelector('[data-lckeep]')?.click(); const s = ghostDesk.state(); for (const x of [...Object.values(s.pos), ...Object.values(s.margin || {})]) x.lcBest = x.best; return t; })()")
    print("INFO  Last chance already shown for an earlier position:", earlier or "none")
    ck = await p.js("ghostDesk.lists.crypto[4]")
    await p.js(f"ghostDesk.openSheet('{ck}'), true")
    await asyncio.sleep(0.4)
    await p.js("ghostDesk.chooseSide('buy'), true")
    await asyncio.sleep(0.15)
    await p.js("document.querySelector('[data-amt=\"500\"]').click(), true")
    await asyncio.sleep(0.15)
    await p.js(enter)
    await asyncio.sleep(0.4)
    await p.js(f"(() => {{ const g = ghostDesk, w = g.sim(); w.insts['{ck}'].px *= 1.05; g.simAdvance(w.t + 1000); w.insts['{ck}'].px *= 0.85; g.simAdvance(w.t + 1000); return true; }})()")
    await asyncio.sleep(0.5)
    lc = await p.js("({ shown: !document.getElementById('lastChance').hidden, text: document.getElementById('lastChance').innerText.split(String.fromCharCode(10)).join(' '), line: document.querySelector('.lc-line')?.textContent })")
    await check("sim last chance")
    await p.js("document.querySelector('[data-lcsell]').click(), true")
    await asyncio.sleep(0.5)
    gone = await p.js(f"!ghostDesk.state().pos['{ck}']")
    res(lc["shown"] and "LAST CHANCE" in lc["text"] and "Sell now" in lc["text"] and gone, f"Last chance at −10% from the high: “{lc['text'][:110]}…”; Sell now → sold", "last chance")
    # Trailing stop from Settings: it sells by itself
    await p.js("ghostDesk.closeSheet(true), ghostDesk.openSettings(), true")
    await asyncio.sleep(0.3)
    await p.js("document.querySelector('[data-lcpct=\"15\"]').click(), document.getElementById('lcTrail').click(), true")
    await asyncio.sleep(0.2)
    cfg = await p.js("ghostDesk.cfg().lc")
    await check("settings last chance")
    await p.js(f"ghostDesk.closeSheet(true), ghostDesk.openSheet('{ck}'), true")
    await asyncio.sleep(0.4)
    await p.js("ghostDesk.chooseSide('buy'), true")
    await asyncio.sleep(0.15)
    await p.js("document.querySelector('[data-amt=\"500\"]').click(), true")
    await asyncio.sleep(0.15)
    await p.js(enter)
    await asyncio.sleep(0.4)
    await p.js(f"(() => {{ const g = ghostDesk, w = g.sim(); w.insts['{ck}'].px *= 0.82; g.simAdvance(w.t + 1000); return true; }})()")
    await asyncio.sleep(0.4)
    tr = await p.js(f"(() => {{ const t = ghostDesk.state().trades.at(-1); return {{ reason: t.reason, side: t.side, held: !!ghostDesk.state().pos['{ck}'], warn: !document.getElementById('lastChance').hidden }}; }})()")
    res(cfg == {"pct": 15, "warn": True, "trail": True} and tr["reason"] == "trail" and tr["side"] == "sell" and not tr["held"] and not tr["warn"],
        f"Trailing stop at −15% (Settings {cfg}): sold by itself, reason “{tr['reason']}”", "trailing stop")
    await p.js("ghostDesk.openSettings(), true")
    await asyncio.sleep(0.2)
    await p.js("document.getElementById('lcTrail').click(), document.querySelector('[data-lcpct=\"10\"]').click(), ghostDesk.closeSheet(true), true")
    # Skip ahead +1h from the chart: a stop loss fills on the way, bots trade, candles and the Sim clock move
    await p.js("ghostDesk.addBot('degen'), ghostDesk.addBot('momentum'), true")
    sk = await p.js("ghostDesk.lists.crypto[5]")
    await p.js(f"ghostDesk.openSheet('{sk}'), true")
    await asyncio.sleep(0.4)
    await p.js("ghostDesk.chooseSide('buy'), true")
    await asyncio.sleep(0.15)
    await p.js("document.querySelector('[data-amt=\"500\"]').click(), true")
    await asyncio.sleep(0.15)
    await p.js(enter)
    await asyncio.sleep(0.4)
    await p.js(f"(() => {{ const s = ghostDesk.state(), pos = s.pos['{sk}'], px = ghostDesk.sim().insts['{sk}'].px; pos.sl = px * 0.9995; pos.tp = px * 1.5; return true; }})()")
    before = await p.js(f"({{ t: ghostDesk.sim().t, clock: ghostDesk.appNow(), n1: ghostDesk.sim().insts['{sk}'].b1.length, trades: ghostDesk.state().trades.length, bots: ghostDesk.bots().reduce((a, b) => a + b.pf.trades.length, 0) }})")
    btns = await p.js("[...document.querySelectorAll('[data-skip]')].map(b => b.textContent)")
    await check("sim skip buttons")
    await p.js("document.querySelector('[data-skip=\"1h\"]').click(), true")
    await wait("!!document.querySelector('.skip-box.done')", 30)
    await asyncio.sleep(0.3)
    summ = await p.js("document.querySelector('.skip-box').innerText.split(String.fromCharCode(10)).join(' | ')")
    await check("sim skip summary")
    after = await p.js(f"({{ t: ghostDesk.sim().t, clock: ghostDesk.appNow(), last: ghostDesk.state().trades.at(-1), bots: ghostDesk.bots().reduce((a, b) => a + b.pf.trades.length, 0), b1: ghostDesk.sim().insts['{sk}'].b1.slice(-60).every((b, k, a) => !k || b[0] - a[k - 1][0] === 60000) }})")
    await p.js("document.querySelector('[data-skipok]').click(), true")
    moved = after["t"] - before["t"]
    res(btns == ["+1m", "+5m", "+15m", "+1h", "+1d", "+1w"] and moved == 3600000 and after["clock"] - before["clock"] >= 3600000 - 60000 and after["last"]["reason"] == "sl" and after["last"]["t"] > before["t"] and after["b1"] and "stop loss" in summ,
        f"Skip ahead {btns}: +{moved / 60000:.0f} min of Sim, stop loss filled on the way at {after['last']['t'] - before['t']} ms, bots {before['bots']} → {after['bots']} trades; “{summ[:160]}…”", "skip")
    # Skip a whole week: time it
    t0 = time.time()
    await p.js(f"ghostDesk.openSheet('{sk}'), true")
    await asyncio.sleep(0.3)
    await p.js("document.querySelector('[data-skip=\"1w\"]').click(), true")
    okw = await wait("!!document.querySelector('.skip-box.done')", 90)
    wk = time.time() - t0
    wsum = await p.js("document.querySelector('.skip-box').innerText.split(String.fromCharCode(10)).join(' | ')")
    await p.shot("sim-skip-week")
    await p.js("document.querySelector('[data-skipok]').click(), true")
    res(okw and "+1 week" in wsum, f"Skip a week in {wk:.1f} s: “{wsum[:200]}…”", "skip week")
    # Oracle: a cheat, Sim only, marks BUY and SELL = max profit on the future
    await p.js("ghostDesk.closeSheet(true), ghostDesk.openCheats(), true")
    await asyncio.sleep(0.3)
    await p.js("document.querySelector('[data-cheat=oracle]').click(), true")
    await asyncio.sleep(0.2)
    ok_on = await p.js("ghostDesk.C.isOn(ghostDesk.state(), 'oracle')")
    mk = await p.js("(() => { const w = ghostDesk.sim(); return ghostDesk.lists.meme.new.map(k => w.insts[k]).find(i => !i.dead && i.fate.mult > 0 && i.fate.pumpAt > w.t + 30e3 && i.fate.pumpAt < w.t + 20 * 60e3)?.key || ghostDesk.lists.meme.new[0]; })()")
    await p.js(f"ghostDesk.closeSheet(true), ghostDesk.openSheet('{mk}'), true")
    await asyncio.sleep(0.8)
    on = await p.js("document.getElementById('oracleNote')?.textContent")
    o = await p.js(f"(() => {{ const o = ghostDesk.oracleFor('{mk}'); return o && o.best ? {{ buy: o.best.buy, sell: o.best.sell, gain: o.best.gain, at: o.at }} : null; }})()")
    await check("sim oracle")
    await p.shot("sim-oracle")
    real_ok = True
    if o:
        # play the real Sim to the predicted peak: the price there is what the Oracle said
        await p.js(f"(() => {{ const g = ghostDesk, w = g.sim(); while (w.t < {o['sell']['t']}) g.simAdvance(w.t + 1000); return true; }})()")
        px = await p.js(f"ghostDesk.sim().insts['{mk}']?.px")
        real_ok = px is not None and abs(px / o["sell"]["px"] - 1) < 1e-9
    star = await p.js("!!document.querySelector('#totalPl .star')")
    res(ok_on and "Oracle" in (on or "") and star and real_ok, f"Oracle on: “{on}”; the real Sim reached the predicted peak exactly: {real_ok}", "oracle")
    await p.js("ghostDesk.closeSheet(true), true")

    # ---- Rewind, Oracle Auto, Do it, Jump to it, Front-run
    async def sleep_js(expr, s=0.3):
        r = await p.js(expr)
        await asyncio.sleep(s)
        return r
    await sleep_js("ghostDesk.closeSheet(true), ghostDesk.state().cheats.on.oracle = true, ghostDesk.setTab('home'), true")
    rk = await p.js("ghostDesk.lists.crypto[1]")
    await sleep_js(f"ghostDesk.openSheet('{rk}'), true", 0.6)
    await check("sim rewind buttons")
    snap = "(() => { const g = ghostDesk, s = g.state(), w = g.sim(); return JSON.stringify([w.t, w.insts, s.cash, s.pos, s.margin, s.orders, s.trades, g.bots().map(b => [b.id, b.pf.cash, b.pf.pos, b.pf.trades])]); })()"
    r1 = await p.js("""(async () => { const g = ghostDesk, snap = () => %s; const a = snap(); await g.skipAhead('1h'); const mid = snap(); return { same: a === mid, a }; })()""" % snap)
    await sleep_js("document.querySelector('[data-skipok]')?.click(), true")
    # the sheet's own button, with its second tap; the moment before the skip is a save point
    await sleep_js("ghostDesk.sim().t, document.querySelector('[data-rewind=\"1h\"]').click(), true", 0.2)
    sure = await p.js("document.querySelector('[data-rewind=\"1h\"]').textContent")
    tb = await p.js("ghostDesk.sim().t")
    await p.js("document.querySelector('[data-rewind=\"1h\"]').click(), true")
    okr = await wait(f"ghostDesk.sim().t < {tb} - 3000000", 20)
    rw = await p.js("({ star: !!ghostDesk.state().cheats.since, rewinds: ghostDesk.state().cheats.used.rewind, last: ghostDesk.points().at(-1).t, t: ghostDesk.sim().t })")
    res(okr and "Sure" in sure and rw["star"] and rw["rewinds"] == 1 and rw["t"] - rw["last"] < 20000, f"Rewind -1h: {(tb - rw['t']) / 60000:.1f} min back, ★, asks first (“{sure}”)", "rewind")
    ex = await p.js("""(async () => { const g = ghostDesk, snap = () => %s;
      const t0 = g.sim().t; await g.skipAhead('1d'); const a = g.points().length;
      document.querySelector('[data-skipok]')?.click();
      const r = await g.rewind('1d'); return { to: r && r.to, t0, a, b: g.points().length }; })()""" % snap)
    res(ex["to"] == ex["t0"] and ex["a"] > ex["b"] + 80, f"Rewind -1d lands exactly on the moment before the skip; {ex['a']} → {ex['b']} save points", "rewind exact")
    wkr = await p.js("""(async () => { const g = ghostDesk, t0 = g.sim().t; const a = performance.now(); await g.skipAhead('1w'); const b = performance.now(); document.querySelector('[data-skipok]')?.click();
      const n = g.points().length, r = await g.rewind('1w'); const est = await navigator.storage.estimate(); return { ok: !!r && r.to <= t0 && t0 - r.to < 900000, n, skip: b - a, rew: performance.now() - b, mb: est.usage / 1e6 }; })()""")
    res(wkr["ok"], f"Rewind -1w: {wkr['n']} points, skip {wkr['skip'] / 1000:.1f} s, rewind {wkr['rew'] / 1000:.1f} s, storage {wkr['mb']:.0f} MB", "rewind week")
    short = await p.js("""(async () => { const g = ghostDesk, out = {};
      const run = n => { for (let k = 0; k < n; k++) g.simAdvance(g.sim().t + 10000); };
      run(130);
      for (const [id, ms] of [['1m', 60e3], ['5m', 300e3], ['15m', 900e3]]) { const r = await g.rewind(id); out['-' + id] = r ? (r.from - r.to - ms) / 1000 : null; run(130); }
      for (const id of ['1m', '5m', '15m']) { const t = g.sim().t; await g.skipAhead(id); out['+' + id] = (g.sim().t - t) / 60e3; document.querySelector('[data-skipok]')?.click(); }
      const r = document.querySelector('.skip-row'); out.row = [r.children.length, r.scrollWidth > r.clientWidth, new Set([...r.children].map(b => b.offsetTop)).size]; return out; })()""")
    res(all(short[k] is not None and 0 <= short[k] <= 30 for k in ["-1m", "-5m", "-15m"]) and short["+1m"] == 1 and short["+5m"] == 5 and short["+15m"] == 15 and short["row"] == [6, True, 1],
        f"Short jumps: forward 1/5/15 min exact; back, seconds past the target: {short}", "short jumps")
    # Do it: armed with a countdown, buys and sells at the marks
    mark = "(() => { const g = ghostDesk; for (const k of [...g.lists.meme.new, ...g.lists.crypto]) { if (g.state().pos[k]) continue; const o = g.oracleFor(k); if (o?.best && o.best.buy.t > g.sim().t + 5000 && o.best.sell.t > o.best.buy.t + 5000) return k; } return null; })()"
    dk = await p.js(mark)
    await sleep_js(f"ghostDesk.openSheet('{dk}'), true", 0.8)
    line = await p.js("document.getElementById('oracleNote').innerText")
    await check("oracle buttons")
    cash = await p.js("ghostDesk.E.available(ghostDesk.state())")
    await sleep_js("document.querySelector('[data-doit]').click(), true", 1.2)
    armed = await p.js("document.getElementById('oracleNote').innerText")
    await check("oracle armed")
    g0 = await p.js(f"({{ ...ghostDesk.signals()['{dk}'] }})")
    dr = await p.js(f"(() => {{ const g = ghostDesk, w = g.sim(), n = g.state().trades.length; while (g.sim().t < {g0['sellT']} + 3000) g.simAdvance(g.sim().t + 7000); return g.state().trades.slice(n).filter(t => t.key === '{dk}').map(t => ({{ side: t.side, t: t.t, mid: t.mid, usd: t.usd, reason: t.reason }})); }})()")
    res("Do it" in line and "Jump to it" in line and "Armed" in armed and len(dr) == 2 and dr[0]["t"] == g0["buyT"] and dr[1]["t"] == g0["sellT"] and abs(dr[1]["mid"] / g0["sellPx"] - 1) < 1e-9 and abs(dr[0]["usd"] - cash * 0.1) < cash * 0.02,
        f"Do it: “{armed[-60:]}” → bought and sold exactly at BUY and SELL, with 10% of cash {dr} {g0} {cash}", "do it")
    # Jump to it / Jump to sell
    jk = await p.js(mark)
    await sleep_js(f"ghostDesk.closeSheet(true), ghostDesk.openSheet('{jk}'), true", 0.8)
    best = await p.js(f"ghostDesk.oracleFor('{jk}').best")
    n0 = await p.js("ghostDesk.state().trades.length")
    await p.js("document.querySelector('[data-jumpbuy]').click(), true")
    await wait("!!document.querySelector('[data-jumpsell]')", 30)
    jb = await p.js(f"ghostDesk.state().trades.slice({n0}).filter(t => t.key === '{jk}').map(t => [t.side, t.t, t.mid])")
    await check("jump to sell")
    await sleep_js("document.querySelector('[data-jumpsell]').click(), true")
    await wait(f"!ghostDesk.signals()['{jk}']", 30)
    js_ = await p.js(f"ghostDesk.state().trades.slice({n0}).filter(t => t.key === '{jk}').map(t => [t.side, t.t, t.mid])")
    res(len(jb) == 1 and jb[0][1] == best["buy"]["t"] and len(js_) == 2 and js_[1][1] == best["sell"]["t"] and abs(js_[1][2] / best["sell"]["px"] - 1) < 1e-9, f"Jump to it bought at BUY; Jump to sell sold at SELL ({best['gain'] * 100:.1f}%)", "jump")
    # Oracle Auto on every coin
    await sleep_js("ghostDesk.closeSheet(true), ghostDesk.openCheats(), true")
    await sleep_js("document.querySelector('[data-oascope=all]').click(), true")
    await sleep_js("document.getElementById('oaTog').click(), true", 1.0)
    await check("oracle auto card")
    au = await p.js("""(() => { const g = ghostDesk, n = g.state().trades.length; let ms = performance.now(); g.forecast(); ms = performance.now() - ms;
      const end = g.sim().t + 15 * 60e3; while (g.sim().t < end) g.simAdvance(g.sim().t + 5000);
      const ts = g.state().trades.slice(n), sells = ts.filter(t => t.side === 'sell' && t.reason === 'oracle');
      return { buys: ts.filter(t => t.side === 'buy' && t.reason === 'oracle').length, sells: sells.length, wins: sells.filter(t => t.pl > 0).length, ms, toast: document.getElementById('toast').textContent }; })()""")
    await sleep_js("document.getElementById('oaTog').click(), true")
    left = await p.js("Object.values(ghostDesk.signals()).filter(x => x.src === 'auto').length")
    res(au["buys"] > 3 and au["sells"] > 1 and au["wins"] >= au["sells"] * 0.9 and left == 0, f"Oracle Auto on all coins, 15 min: {au['buys']} buys, {au['sells']} sells, {au['wins']} wins; forecast {au['ms']:.0f} ms; off: nothing left to sell; “{au['toast'][:70]}”", "oracle auto")
    # Front-run and Sell first
    await sleep_js("ghostDesk.closeSheet(true), ghostDesk.state().cheats.on.xray = true, ghostDesk.setTab('achievements'), ghostDesk.refreshStandings(), true", 0.5)
    await p.js("""(() => { const g = ghostDesk; if (!g.bots().length) g.addBot('momentum'); const b = g.bots()[0]; b.style = 'random'; b.pf.pos = {};
      for (let i = 1; i < 400; i++) { b.seed = i; if (g.nextMoves(b).buy) break; } g.refreshStandings(); return true; })()""")
    await check("front run")
    cash = await p.js("ghostDesk.E.available(ghostDesk.state())")
    fr = await p.js("(() => { const b = document.querySelector('[data-front]'); const n = ghostDesk.state().trades.length, k = b?.dataset.key, txt = b?.textContent; b?.click(); const t = ghostDesk.state().trades.at(-1); return { txt, k, n: ghostDesk.state().trades.length - n, key: t.key, usd: t.usd, tag: t.cheat }; })()")
    sf = await p.js("""(() => { const g = ghostDesk, b = g.bots()[0], k = '%s', me = g.state().pos[k]; b.pf.pos = {}; b.style = 'momentum';
      const L = g.live.get(k); g.E.executeBuy(b.pf, L.inst, 100, { px: L.px * 0.2, t: g.appNow(), liq: 1e9, quoteUsd: L.quoteUsd }, g.appNow());
      g.refreshStandings(); const btn = [...document.querySelectorAll('[data-sellfirst]')].find(x => x.dataset.key === k); const txt = btn?.textContent; btn?.click(); return { txt, gone: !g.state().pos[k], had: !!me }; })()""" % fr["k"])
    res(fr["n"] == 1 and fr["key"] == fr["k"] and abs(fr["usd"] - cash * 0.1) < 0.02 and "Front-run" in fr["tag"] and sf["had"] and sf["gone"], f"{fr['txt']}: bought {fr['usd']:.2f} (10% of cash); {sf['txt']}: sold mine", "front run")
    await sleep_js("ghostDesk.closeSheet(true), true")
    # Back to Live with the real button: Live portfolio untouched, no star
    await p.js("ghostDesk.closeSheet(true), document.getElementById('liveDot').click(), true")
    await wait("!document.body.classList.contains('sim') && document.documentElement.dataset.ready === '1'", 15)
    await asyncio.sleep(0.6)
    live1 = await p.js("({ sim: ghostDesk.isSim(), cash: ghostDesk.state().cash, trades: ghostDesk.state().trades.length, start: ghostDesk.state().start, star: !!document.querySelector('#totalPl .star'), label: document.querySelector('.total-box small').textContent, btc: ghostDesk.lists.crypto.length === 0 || !ghostDesk.lists.crypto.some(k => k.startsWith('crypto:NBL')) })")
    await check("back to live")
    res(not live1["sim"] and live1["cash"] == live0["cash"] and live1["trades"] == live0["trades"] and not live1["star"] and live1["label"] == "Your portfolio" and live1["btc"],
        f"Back to Live: portfolio untouched (cash {live1['cash']}, {live1['trades']} trades), no ★, no Sim coins", "back to live")
    return fails


async def sim_live_check(p):
    """Real app (no test mode) in Sim: the one-second clock, events, new coins, saving, reload, back to Live."""
    await p.send("Emulation.setDeviceMetricsOverride", width=375, height=812, deviceScaleFactor=2, mobile=True)
    await p.goto(BASE + "/index.html#home", "!!document.querySelector('#view .stat-row')")
    live_pf = await p.js("(async () => { const st = await import('./js/store.js'); await st.openStore(); const s = await st.kv.get('portfolio'); return s ? s.trades.length + ':' + s.cash : 'none'; })()")
    await p.js("document.getElementById('simBtn').click(), true")
    await asyncio.sleep(4)
    await p.goto(BASE + "/index.html?r=5#markets", "document.body.classList.contains('sim') && !!document.querySelector('#view .row')")
    t0 = time.time()
    a = await p.js("({ total: document.getElementById('total').textContent, rows: document.querySelectorAll('#view .row').length, first: document.querySelector('#view .row .nm b')?.textContent })")
    await p.js("document.querySelector('.seg.mk [data-market=meme]').click(), true")
    seen = set()
    for _ in range(40):
        await asyncio.sleep(1)
        seen.add(await p.js("document.querySelector('.tape')?.textContent.slice(0, 80)"))
    b = await p.js("({ rows: document.querySelectorAll('#view .row').length, ev: document.querySelector('.sim-event .se-t b')?.textContent || null })")
    await p.shot("live-sim")
    await asyncio.sleep(31)  # the world is saved every 30 s
    w1 = await p.js("(async () => { const st = await import('./js/store.js'); const w = await st.kv.get('sim.world'); return { n: w.coinN, t: w.t, memes: w.memes.length }; })()")
    await p.goto(BASE + "/index.html?r=6#markets", "document.body.classList.contains('sim') && !!document.querySelector('#view .row')")
    await asyncio.sleep(3)
    w2 = await p.js("(async () => { const st = await import('./js/store.js'); const rows = document.querySelectorAll('#view .row').length; return { rows, label: document.querySelector('.total-box small').textContent }; })()")
    await p.js("document.getElementById('liveDot').click(), true")
    await asyncio.sleep(4)
    await p.goto(BASE + "/index.html?r=7#home", "!!document.querySelector('#view .stat-row')")
    back = await p.js("(async () => { const st = await import('./js/store.js'); const s = await st.kv.get('portfolio'); return { sim: document.body.classList.contains('sim'), pf: s ? s.trades.length + ':' + s.cash : 'none' }; })()")
    print(f"Sim: {a['rows']} crypto listed (first {a['first']}), total {a['total']}; {len(seen)} different tapes in 40 s; {b['rows']} rows after; event: {b['ev']}")
    print(f"Saved world: {w1['n']} coins born so far, {w1['memes']} alive; after reload: {w2['rows']} rows, “{w2['label']}”")
    ok1 = a["rows"] >= 14 and len(seen) >= 20 and w1["n"] > 22 and w2["rows"] >= 14 and w2["label"] == "Your Sim portfolio"
    ok2 = not back["sim"] and back["pf"] == (live_pf if live_pf != "none" else back["pf"]) and back["pf"].startswith("0:")
    print(("PASS " if ok1 else "FAIL ") + " Sim runs on its own one-second clock, is saved and continues after a reload")
    print(("PASS " if ok2 else "FAIL ") + f" Back to Live: Live portfolio unchanged (before {live_pf}, after {back['pf']} = trades:cash)")
    if p.events:
        print("Console:", *p.events[:10], sep=chr(10) + "  ")
    return ok1 and ok2 and not p.events


async def bots_live_check(p):
    """Real app, real prices, four bots: they trade only on live prices seen after the app opened."""
    await p.send("Emulation.setDeviceMetricsOverride", width=375, height=812, deviceScaleFactor=2, mobile=True)
    await p.goto(BASE + "/index.html#home", "!!document.querySelector('#view .cd-card')")
    await p.js("""(async () => {
      const st = await import('./js/store.js'), B = await import('./js/core/bots.js'), E = await import('./js/core/engine.js');
      await st.openStore();
      const now = Date.now(), old = now - 3 * 86400e3;
      const list = ['momentum', 'contrarian', 'degen', 'random'].map((s, i) => B.newBot(s, { id: 'live' + i, start: 100000, now: old, seed: 99 + i }));
      // a position bought three days ago: its old price must not be used for anything when the app opens
      E.executeBuy(list[0].pf, { key: 'crypto:BTCUSDT', m: 'crypto', id: 'BTCUSDT', sym: 'BTC', name: 'Bitcoin' }, 5000, { px: 20000, t: old }, old);
      await st.kv.set('bots', { v: 1, list });
      await st.kv.set('portfolio', E.newPortfolio(now));
      return true; })()""")
    t_open = await p.js("Date.now()")
    await p.goto(BASE + "/index.html?r=3#achievements", "!!document.getElementById('lbSlotFull')")
    await asyncio.sleep(120)
    res = await p.js("""(async () => {
      const st = await import('./js/store.js'); const d = await st.kv.get('bots');
      return d.list.map(b => ({ name: b.name, trades: b.pf.trades.filter(t => t.t > %d).map(t => [new Date(t.t).toISOString().slice(11, 19), t.side, t.sym, t.m, Math.round(t.usd), +t.mid.toPrecision(6), t.why]), cash: Math.round(b.pf.cash), btc: b.pf.trades.filter(t => t.sym === 'BTC' && t.side === 'sell').map(t => [t.mid, new Date(t.t).toISOString()]) }));
    })()""" % t_open)
    total = 0
    for b in res:
        print(f"{b['name']}: {len(b['trades'])} trades, cash ${b['cash']:,}")
        for t in b["trades"]:
            print("   ", *t)
        total += len(b["trades"])
    rows = await p.js("[...document.querySelectorAll('#lbSlotFull .row.lb')].map(r => r.innerText.replace(/\\n/g, ' | '))")
    print("Leaderboard:", *rows, sep="\n  ")
    await p.shot("live-bots-leaderboard")
    old_px = [x for b in res for x in b["btc"] if x[0] == 20000]
    ok = total > 0 and not old_px and not p.events
    print(("PASS " if ok else "FAIL ") + f" bots traded {total} times on real prices; none at the 3-day-old $20,000 BTC price")
    if p.events:
        print("Console:", *p.events[:10], sep=chr(10) + "  ")
    await p.js("(async () => { const st = await import('./js/store.js'); await st.kv.set('bots', { v: 1, list: [] }); return true; })()")
    return ok


async def live_check(p):
    """Real app, real sources (no keys): every keyless market must show live prices in the browser."""
    await p.send("Emulation.setDeviceMetricsOverride", width=375, height=812, deviceScaleFactor=2, mobile=True)
    await p.goto(BASE + "/index.html#home", "!!document.querySelector('#view .cd-card')")
    await asyncio.sleep(25)
    count = "(m => [...document.querySelectorAll('[data-p^=\"' + m + ':\"]')].filter(e => /[0-9]/.test(e.textContent)).length)"
    got = {m: await p.js(f"{count}('{m}')") for m in ["meme", "crypto", "fx"]}
    print("Live prices on Home:", got)
    print("Notices:", await p.js("document.getElementById('banners').innerText || '(none)'"))
    print("Status:", await p.js("document.getElementById('liveDot').innerText"), "| ticker:", (await p.js("document.getElementById('tape').innerText"))[:120].replace(chr(10), " "))
    await p.shot("live-home")
    ok = all(v >= 2 for v in got.values())
    for key, name in [("crypto:BTCUSDT", "btc"), ("fx:EURUSD", "eurusd")]:
        await p.js(f"(() => {{ const b = document.createElement('button'); b.dataset.open = '{key}'; b.hidden = true; document.body.append(b); b.click(); b.remove(); return true; }})()")
        await asyncio.sleep(6)
        note = await p.js("document.getElementById('chartNote')?.textContent")
        px = await p.js("document.querySelector('.sh-body .big')?.textContent")
        print(f"Sheet {name}: price {px} | chart: {note}")
        await p.shot("live-sheet-" + name)
        await p.js("document.querySelector('[data-close]').click(), true")
        await asyncio.sleep(0.5)
    await p.js("document.querySelector('[data-tab=markets]').click(), true")
    await p.js("document.querySelector('.seg.mk [data-market=meme]').click(), true")
    await asyncio.sleep(8)
    first = await p.js("document.querySelector('#view .row')?.dataset.open")
    print("First memecoin in Trending:", first)
    if first:
        await p.js(f"document.querySelector('#view .row').click(), true")
        await asyncio.sleep(6)
        print("Sheet memecoin: price", await p.js("document.querySelector('.sh-body .big')?.textContent"), "| chart:", await p.js("document.getElementById('chartNote')?.textContent"))
        await p.shot("live-sheet-meme")
        await p.js("document.querySelector('[data-close]').click(), true")
    await p.js("document.querySelector('.seg.mk [data-market=stock]').click(), true")
    await asyncio.sleep(1)
    print("Stocks with no key:", (await p.js("document.querySelector('.nokey')?.innerText || 'NO NOTICE'")).replace(chr(10), " "))
    cached = await p.js("(async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).host + new URL(r.url).pathname); return out; })()")
    hosts = sorted({c.split("/")[0] for c in cached})
    print(f"Service worker: {len(cached)} files cached, from {hosts}")
    if p.events:
        print("Console:", *p.events[:10], sep=chr(10) + "  ")
    return ok and bool(first)


async def twelve_demo_check(p):
    """Twelve Data's public 'demo' key (EUR/USD only): real candles via the header, then served from the phone."""
    await p.send("Emulation.setDeviceMetricsOverride", width=375, height=812, deviceScaleFactor=2, mobile=True)
    await p.goto(BASE + "/index.html#home", "!!document.querySelector('#view .cd-card')")
    await p.js("(async () => { const st = await import('./js/store.js'); await st.openStore(); const s = (await st.kv.get('settings')) || {}; await st.kv.set('settings', { ...s, twelveKey: 'demo', ivl: '1h' }); await st.candles.clear(); return true; })()")
    await p.goto(BASE + "/index.html?r=2#home", "!!document.querySelector('#view .cd-card')")
    await asyncio.sleep(4)
    notes = []
    for k in range(2):
        await p.js("(() => { const b = document.createElement('button'); b.dataset.open = 'fx:EURUSD'; document.body.append(b); b.click(); b.remove(); return true; })()")
        await asyncio.sleep(7)
        notes.append(await p.js("document.getElementById('chartNote')?.textContent"))
        print(f"EURUSD 1h, time {k + 1}:", notes[-1])
        await p.shot(f"twelvedata-eurusd-{k + 1}")
        await p.js("document.querySelector('[data-close]').click(), true")
        await asyncio.sleep(0.6)
    bars = await p.js("(async () => { const st = await import('./js/store.js'); const c = await st.candles.get('td:EUR/USD:1h'); return c ? { n: c.bars.length, last: new Date(c.bars.at(-1).t).toISOString(), close: c.bars.at(-1).c } : null; })()")
    print("Candles saved on the phone:", bars)
    await p.js("(async () => { const st = await import('./js/store.js'); const s = await st.kv.get('settings'); await st.kv.set('settings', { ...s, twelveKey: '' }); return true; })()")
    ok = "Twelve Data candles" in (notes[0] or "") and "no credits used" in (notes[1] or "") and bars and bars["n"] > 50
    print(("PASS " if ok else "FAIL ") + " real Twelve Data candles, saved and reused")
    return ok


async def offline_check(p):
    """Install the app, then kill its server and the network: portfolio and history must still open."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    srv = subprocess.Popen([sys.executable, os.path.join(root, "tests", "serve.py"), root, "8766"])
    base = "http://127.0.0.1:8766"
    try:
        await asyncio.sleep(1)
        await p.send("Emulation.setDeviceMetricsOverride", width=375, height=812, deviceScaleFactor=2, mobile=True)
        await p.goto(base + "/index.html#portfolio", "!!document.querySelector('#view .stat-row')")
        await p.js("""(async () => {
          const st = await import('./js/store.js'), E = await import('./js/core/engine.js');
          await st.openStore();
          const s = E.newPortfolio(Date.now()), now = Date.now();
          const btc = { key: 'crypto:BTCUSDT', m: 'crypto', id: 'BTCUSDT', sym: 'BTC', name: 'Bitcoin' };
          E.executeBuy(s, btc, 3000, { px: 61000, t: now }, now);
          E.executeSell(s, btc.key, 0.25, { px: 62000, t: now }, now);
          await st.kv.set('portfolio', s);
          await navigator.serviceWorker.ready;
          return true; })()""")
        await p.goto(base + "/index.html?r=1#portfolio", "!!navigator.serviceWorker.controller && !!document.querySelector('#view .row')")
        await asyncio.sleep(2)
        srv.kill(); srv.wait()
        await p.send("Network.enable")
        await p.send("Network.emulateNetworkConditions", offline=True, latency=0, downloadThroughput=-1, uploadThroughput=-1)
        await p.goto(base + "/index.html#portfolio", "!!document.querySelector('#view .row')", timeout=20)
        await asyncio.sleep(2)
        pos = await p.js("document.querySelector('#view .row')?.innerText.replace(/\\n/g, ' ')")
        ban = await p.js("document.getElementById('banners').innerText")
        dot = await p.js("document.getElementById('liveDot').innerText")
        await p.shot("offline-portfolio")
        await p.js("document.querySelector('[data-tab=history]').click(), true")
        await asyncio.sleep(0.5)
        hist = await p.js("document.querySelectorAll('#view .tr').length")
        await p.shot("offline-history")
        print(f"No server, no internet → position: {pos} | indicator: {dot} | trades in history: {hist}")
        print("Notice:", ban.replace(chr(10), " | "))
        ok = "BTC" in (pos or "") and hist == 2 and "Offline" in ban
        print(("PASS " if ok else "FAIL ") + " offline, portfolio and history still show")
        await p.send("Network.emulateNetworkConditions", offline=False, latency=0, downloadThroughput=-1, uploadThroughput=-1)
        return ok
    finally:
        if srv.poll() is None:
            srv.kill()


async def bad_keys_check(p):
    """Real Finnhub and Twelve Data answering a wrong key: the app must say so clearly, never go blank."""
    FAKE = "wrongkeyfortesting123"
    await p.send("Emulation.setDeviceMetricsOverride", width=375, height=812, deviceScaleFactor=2, mobile=True)
    await p.goto(BASE + "/index.html#markets", "!!document.querySelector('#view .seg')")
    await p.js(f"(async () => {{ const st = await import('./js/store.js'); await st.openStore(); const s = (await st.kv.get('settings')) || {{}}; await st.kv.set('settings', {{ ...s, finnhubKey: '{FAKE}', twelveKey: '{FAKE}' }}); return true; }})()")
    await p.goto(BASE + "/index.html?r=1#markets", "!!document.querySelector('#view .seg')")
    await p.js("document.querySelector('.seg.mk [data-market=stock]').click(), true")
    await asyncio.sleep(10)
    banners = await p.js("document.getElementById('banners').innerText")
    print("Notices with a bad Finnhub key:", banners.replace(chr(10), " | ") or "(none)")
    view = await p.js("document.getElementById('view').innerText.trim().length")
    await p.shot("bad-key-stocks")
    await p.js("(() => { const b = document.createElement('button'); b.dataset.open = 'fx:EURUSD'; document.body.append(b); b.click(); b.remove(); return true; })()")
    await asyncio.sleep(6)
    note = await p.js("document.getElementById('chartNote')?.textContent")
    print("EURUSD chart with a bad Twelve Data key:", note)
    banners2 = await p.js("document.getElementById('banners').innerText")
    await p.shot("bad-key-eurusd")
    cached = await p.js("(async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(r.url); return out; })()")
    leaked = [u for u in cached if FAKE in u or "finnhub" in u or "twelvedata" in u]
    print(f"Service worker cache: {len(cached)} entries; with the key or from price sources: {len(leaked)}")
    ok = "Finnhub rejected your key" in banners and view > 50 and "Twelve Data rejected" in (note or "") and "Twelve Data rejected your key" in banners2 and not leaked
    print(("PASS " if ok else "FAIL ") + " clear notices with rejected keys")
    await p.js(f"(async () => {{ const st = await import('./js/store.js'); const s = await st.kv.get('settings'); await st.kv.set('settings', {{ ...s, finnhubKey: '', twelveKey: '' }}); return true; }})()")
    return ok


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(main()) else 1)
