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
With a fourth argument it runs against the real sources: `live`, `badkeys`, `tddemo` or `offline` (see `tests/run.py`).
You can also open `http://127.0.0.1:8765/tests/` in the browser.
