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
            elif MODE == "cheats":
                ok = await cheats_live_check(p)
            elif MODE == "sim":
                ok = await sim_live_check(p)
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
    res(n == 24 and clean == "Clean portfolio" and st["cash"] == cash0 + 10000 and st["zf"] and st["lev"] == 10 and st["ghost"] and st["star"] and "marked" in st["note"],
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
