"""Drive headless Chrome through the DevTools protocol to run the Ghost Desk tests.

  python -I tests/run.py <chrome.exe> <base-url> <out-dir>

1) tests/index.html: spec tests 1–5 (hand-made prices, no network).
2) index.html?test=1 at 375x812 (phone): spec test 6. Checks nothing overflows on any tab or sheet,
   buy/sell buttons are thumb-sized, and buys through the real swipe gesture. Saves screenshots.

Extra modes against the real price sources (4th argument):
  live     the real app with no keys: memecoins, crypto and FX must show live prices
  offline  installs the app, stops its server and the network: portfolio and history still open
  bots     the real app with 4 rival bots for ~2 minutes on real prices: what they trade and why
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
            elif MODE == "badkeys":
                ok = await bad_keys_check(p)
            elif MODE == "tddemo":
                ok = await twelve_demo_check(p)
            elif MODE == "offline":
                ok = await offline_check(p)
            elif MODE == "bots":
                ok = await bots_live_check(p)
            else:
                ok1 = await unit_tests(p)
                ok2 = await layout_tests(p)
                ok = ok1 and ok2
            pump.cancel()
            return ok
    finally:
        proc.terminate()


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
    st = await p.js("(() => { const s = ghostDesk.state(); return { start: s.start, cash: s.cash, trades: s.trades.length, pos: Object.keys(s.pos).length, orders: s.orders.length, total: document.getElementById('total').textContent, pl: document.getElementById('totalPl').textContent }; })()")
    ach1 = await p.js("(async () => { const st = await import('./js/store.js'); return Object.keys((await st.kv.get('achievements'))?.unlocked || {}).length; })()")
    ok1 = (label == "Reset to $1,000,000" and s1 != 1000000 and "Tap again" in (label2 or "") and st["start"] == 1000000 and st["cash"] == 1000000
           and st["trades"] == 0 and st["pos"] == 0 and st["orders"] == 0 and st["total"] == "$1,000,000.00" and "from $1,000,000" in st["pl"] and ach1 == ach0 and ach0 > 0 and trades0 > 0)
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
    ok2 = bad["dis"] and good["txt"] == "Reset to $25,000" and not good["dis"] and s2["start"] == 25000 and s2["cash"] == 25000 and s2["total"] == "$25,000.00"
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
