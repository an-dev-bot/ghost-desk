# Ghost Desk G1

A personal trading game: **fake money, real prices**. You start with a $100,000 portfolio to trade Solana
memecoins, crypto (the 30 largest), US stocks and forex. It's a web app you install on your phone (PWA).
There is no server: everything runs and is saved on the phone.

When you reset the portfolio (Settings → Reset portfolio) you can pick the starting balance:
$10,000, $100,000, $1,000,000 or your own amount ($100 to $1,000,000,000).

## Price sources (all free)

| Market | Prices | Charts | Key |
|---|---|---|---|
| Memecoins | DexScreener, every 10 s | GeckoTerminal | No |
| Crypto | Binance live (Coinbase if Binance doesn't answer); list of the top 30 from CoinGecko | Binance / Coinbase | No |
| Stocks | Finnhub, real time | Twelve Data | **Yes**: Finnhub. Twelve Data is optional |
| Forex | Coinbase (mid rate, updates every 30–60 s) | Twelve Data | Twelve Data, optional |

Without keys, memecoins, crypto and forex work. Stocks ask for the Finnhub key.
Without the Twelve Data key, stock and forex charts are drawn from the live prices since you opened the app.

## The keys

- **Finnhub**: create your account at https://finnhub.io/register. The key shows on your Dashboard.
- **Twelve Data** (optional): create your account at https://twelvedata.com/register, then go to Dashboard → API Keys.

Paste them in the app, in **Settings** (the gear at the top right). They're saved only on that phone:
they never go in the code, the repo or the backup file. You paste them again on each device where you use the app.

## Publish on GitHub Pages, step by step

1. Go to https://github.com/new.
   - Repository name: `ghost-desk`
   - Choose **Public** (free GitHub Pages needs a public repo).
   - Don't check "Add a README" (there's one here already).
   - Click **Create repository**.
2. In the terminal, inside this folder (`~/Desktop/ghost-desk`), run this. Replace `YOUR-USERNAME` with your GitHub username:
   ```
   git init
   git add .
   git commit -m "Ghost Desk G1"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/ghost-desk.git
   git push -u origin main
   ```
   The `.gitignore` file leaves out `ESPEC_G1_GHOST_DESK.md`. If you also want to leave out version 0
   (`ghost-desk.html`), add it to `.gitignore` before `git add`.
3. On GitHub, open your repo → **Settings** → **Pages** (left menu).
   - Under "Build and deployment", Source: **Deploy from a branch**.
   - Branch: **main**, folder **/ (root)** → **Save**.
4. Wait a minute or two and reload that page: at the top it says "Your site is live at
   `https://YOUR-USERNAME.github.io/ghost-desk/`".

## Open and install it on your phone

- **Android (Chrome)**: open `https://YOUR-USERNAME.github.io/ghost-desk/` → ⋮ menu → **Install app**
  (or "Add to Home screen"). There's also an "Install" button in Settings.
- **iPhone (Safari)**: open the address → Share button ⬆️ → **Add to Home Screen**.
  On iPhone, notifications only work this way, installed, with iOS 16.4 or later.

Then: Settings → paste the Finnhub key → **Save** (the app tests it and tells you if it works) →
**Allow notifications** and choose which ones you want.

## Move the portfolio from the PC to the phone

Open the same address on the PC → Settings → **Export file**. Send that `.json` to the phone
(email, Drive, WhatsApp) → on the phone, Settings → **Import file**.
Version 0 (`ghost-desk.html`) saved in a different place in the browser and can't be imported.

## Update the app later

Change files, then:
```
git add .
git commit -m "Changes"
git push
```
GitHub Pages publishes on its own in a minute or two. On the phone, close and reopen the app twice so it
picks up the new version. If you change app files, also bump the `VERSION` string in `sw.js`.

## How it works

- **Costs per trade**: memecoins 1% + price impact based on liquidity; crypto 0.1% + 0.02% slippage;
  stocks $0 commission + half the spread (the greater of $0.01 or 0.01% of the price);
  forex $0 + half of each pair's typical spread (EURUSD 1 pip, USDMXN 80 pips, etc.).
  Costs are per trade, so they don't depend on the starting balance; a bigger ticket on a thin memecoin
  does pay more price impact, as it would for real.
- **Buy amounts**: the quick-amount buttons are 0.1%, 0.5%, 1%, 5% and 10% of your starting balance
  ($100 to $10K on $100,000), plus Max.
- **Achievements**: the money goals (+10% realized, portfolio +50%) are measured against your starting balance.
  Achievements stay when you reset.
- **Rival bots** (Settings → Rival bots, up to 6 at once): each bot has its own portfolio, as big as yours,
  and decides by itself what to buy, how much and when to sell, with your same costs and market hours.
  Styles: **Momentum** (buys the fastest risers in all 4 markets, cuts losers early), **Contrarian** (buys the
  biggest drops and sells the bounce), **Degen** (memecoins only, big bets on new and pumping coins, sized to the
  pool's liquidity) and **Random**. They trade only while the app is on screen and only on live prices seen after
  it opened: nothing is made up for the time it was closed. The leaderboard (Trophies, and Home when you have bots)
  shows you vs. each bot: total, % gain, best and worst trade; tap a bot for its positions and history.
  Resetting your portfolio restarts the bots with the same balance. Bots are included in the backup file.
- **Cheats** (Settings → Cheats, 25 of them): Money printer, Zero fees, Market maker, Leverage 10x/50x/100x
  (real liquidation when the loss reaches the margin), Short anything, Magic limit, Whale mode, Golden entry,
  Perfect exit, Sniper, 2x Lucky trade, Ghost trade, Insurance, Double or nothing, Undo, Rug shield, Diamond hands,
  Second chance, Moon boost, Airdrop, Time machine and Time skip (replay a past day on real 1-minute candles in a
  separate replay portfolio), Copycat and X-ray. Golden entry, Perfect exit, Sniper and the Time machine use real
  candles (Binance/Coinbase, GeckoTerminal, Twelve Data). Using any cheat marks your portfolio
  with a ★ on the leaderboard and in the history, and achievements earned with cheats are kept apart (earning one
  again without cheats moves it back). Resetting the portfolio removes the star. Cheats work the same in Live and
  Sim, except Oracle, Rewind and Skip ahead, which exist only in Sim (in Live they show off, marked "Sim only").
- **Missing data never stops a trade**: Golden entry, Perfect exit and Sniper use the best price available (the trade
  says so, "Perfect exit: highest price available"); with no data at all the trade is a normal one and they stay armed.
- **Always on**: the one-shot cheats (Golden entry, Perfect exit, Sniper, 2x Lucky trade, Ghost trade, Insurance,
  Double or nothing) have an "Always on" switch that arms them again after every trade; those cards show an
  ALWAYS ON tag and the list sits at the top of the Cheats menu.
- **Double or nothing**: heads doubles the profit of your last winning sale; tails drops the whole portfolio (cash,
  positions, leveraged positions, waiting orders) to $100. A confirmation screen ("If you lose, your whole portfolio
  drops to $100") comes before every flip, also after every win when it's Always on.
- **Bots cheat too** (Settings → Rival bots → "Bots can cheat", on by default): each bot arms cheats
  whenever they suit its next trade, with no daily limit (Money printer: once a day per bot): Zero fees for 1 hour, Insurance 50%, 2x Lucky trade, Rug shield 20% for 1 hour, Golden entry (15-minute
  low), Perfect exit, Leverage 10x or 20x, Money printer 10% of its balance. Never Undo, Ghost trade, Oracle, X-ray,
  Time machine, Skip ahead or Always on. Their cheats show in Rival moves and give their row a ★.
- **Money cap by levels** (Live, Sim and bots; figures and dates in `js/core/rich.js` and Settings): Billionaires, up to
  $7.27T (Forbes, Nov 23, 2026); Countries, up to the United States' GDP, $30.77T (World Bank, 2025); World, up to
  $517.69T (UBS Global Wealth Report 2026, end of 2025, 56 markets). A gain past the cap is cut; reaching it unlocks
  the next level. At the last one, **Prestige** starts you and the bots again at $10K with a permanent badge. On the
  same cap, the first to get there ranks higher. Trophies shows the ladder of your level.
- **Big numbers** are abbreviated everywhere ($1.25K, $3.4M, $12.7B, $1.05T, +1.2M%), never in scientific notation;
  tap one to see it in full. The live price at the top of a coin's page and the trade inputs stay full.
- **Sim mode** (the Live / Sim switch at the top): invented markets with invented names in all four types, prices
  that move on their own every second, always open. Memecoins: a new one every few seconds, pumps of +1,000% in
  minutes (gold candles), very rare 100x moonshots, rug pulls to near zero, whales. Crypto is volatile, stocks have
  crashes and rallies, forex is calm except on news. Random events (Bull run, Black swan, Whale alert, Short squeeze,
  Fed surprise, Elon tweet) with a big banner and a countdown; liquidation cascades when many are leveraged. Effects:
  screen shake, slot-machine total, big confetti, vibration, a combo multiplier for wins in a row, and a JACKPOT
  when a position reaches 10x. Sim sounds are off until you turn them on in Settings. Sim has its own portfolio,
  bots, achievements and records table (best multiplier, biggest jackpot, worst rug, longest streak), with the same
  costs, orders, bots and cheats as Live. Nothing in Sim is real. The Sim world only moves while the app is open.
- **Sim limits**: no Sim coin goes past a $10T market cap ($1T for memecoins), and Whale mode moves a price 25% per
  trade at most.
- **Skip ahead** (Sim only, +1m / +5m / +15m / +1h / +1d / +1w under the chart): plays the whole Sim world forward: candles, events,
  new coins, rugs and the bots' trades; your limit orders, stop loss, take profit and trailing stop fill on the way.
- **Rewind** (cheat, Sim only, -1m / -5m / -15m / -1h / -1d / -1w next to Skip ahead): the Sim world, your Sim portfolio and the bots go
  back to a save point (every 15 Sim minutes and before every jump, up to 1 week; every 20 seconds in the last 20 minutes). Your cheat switches and the star stay.
- **Oracle Auto** (in the Oracle card): buys at BUY and sells at SELL by itself, with a % of your cash, on the coin
  you're viewing or on all of them; marks that costs would turn into a loss are left alone. **Do it** arms one signal;
  **Jump to it** plays the Sim to BUY, and **Jump to sell** to SELL.
- **Front-run / Sell first** (with X-ray): buy or sell what a bot is about to trade, before it does.
- **Saving**: after every change and when the app is hidden or closed; damaged data is repaired piece by piece.
- **Oracle** (cheat, Sim only): plays the next 30 minutes of the coin you're viewing on a copy of the Sim world and
  marks BUY and SELL = max profit on the chart; that future then happens exactly, unless you change it (leverage).
- **Last chance** (Live and Sim, Settings): after a buy the app follows the high since your buy; at −X% from it
  (10% by default) a big warning offers to sell, or an optional trailing stop sells by itself.
- **Real hours**: stocks 9:30 AM to 4:00 PM New York time (with NYSE holidays and early closes);
  outside hours the order waits and fills at the first price after the open.
  Forex Sunday 5:00 PM to Friday 5:00 PM New York time. Crypto and memecoins always.
- **Limit orders, stop loss and take profit**: they fill when the live price hits them while the app is open;
  when you open it, they're checked against the current price.
- **Notifications**: they arrive while the app is open or recently minimized. With the app fully closed it
  would need a notification server (Web Push), which this version doesn't have.
- **Offline**: the portfolio and history show with the last saved prices.
- **Economic calendar**: there's no free source that works from the browser, so it isn't shown.

## Tests

They need Python 3 with the `websockets` package, and Google Chrome:

```
python tests/serve.py . 8765        (in another terminal; leave it running)
python tests/run.py "C:/Program Files/Google/Chrome/Application/chrome.exe" http://127.0.0.1:8765 screenshots
```

This runs the spec tests with hand-made prices (math, hours, orders, backup, keys, starting balance) and
checks the app at 375 px wide, buying for real with the slide gesture and resetting from Settings.
With a fourth argument it runs against the real sources: `live`, `badkeys`, `tddemo`, `offline`, `bots` or `cheats`, or `sim` for the real app in Sim mode (see `tests/run.py`).
You can also open `http://127.0.0.1:8765/tests/` in the browser.
