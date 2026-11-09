# hook

Launch a coin hooked to real-world assets.

Every coin launches on the hook launchpad on Raydium LaunchLab, hooked to one asset (NVDA, TSLA, SPY, gold, BTC and more) with a pull from 1x to 10x. 1% of every curve trade fills the coin's reserve. On a day its asset is green, the reserve spends the asset's 24h move × the pull (up to 50%) buying the coin through Jupiter and burning it, in one transaction with a memo.

- `index.html`, `assets/` — the site
- `api/hook.js` — the API (Vercel function): prices, coins, launches, hooks, profiles
- `api/hook-config.json` — the assets and the rules

Not financial advice. Not affiliated with any company, index, issuer, Raydium or Jupiter.
