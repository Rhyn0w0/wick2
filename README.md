# Outcome Desk

A desktop-first, read-only terminal for Outcome.xyz HIP-4 markets. It uses the official `@outcome.xyz/hip4` SDK against Hyperliquid mainnet public market data. The app does not connect a wallet or submit transactions.

## Run locally

Requires Node.js 20.19 or newer.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. The app fetches market metadata, order book snapshots, trades, and candle history, then subscribes to live public feeds.

The selected market's Yes and No headers show each side's best bid and best offer. The depth panel shows the Yes book, and the trade tape shows recent public trades. The SDK's market metadata supplies the side labels. Underlying charts use the market metadata when available and infer BTC, ETH, or HYPE from the contract name when it is not.

Both charts show volume. The underlying chart supports candle intervals down to 15 seconds. Fifteen-second candles are aggregated from recent trades and updated live; their backfill is limited to the recent-trade history returned by Hyperliquid. The outcome chart connects public trade prices as a line, backfills up to 1,000 recent trades on load, and adds new trades live. Its window controls select how much of that trade series is visible.

The watchlist loads the full market catalog, ordered by 24-hour volume, so search and filters include markets beyond the initial 100 results. It can filter by market type, deployer venue/address, and time to settlement. Each row shows the settlement or event target and remaining time when the SDK metadata provides one.

## SDK license

`@outcome.xyz/hip4` is licensed under BUSL-1.1. The current grant permits personal, non-commercial projects that are not offered to third parties. Review the SDK's [license](https://github.com/Outcome-xyz/hip4/blob/main/LICENSE) before distributing this app or making it available as a service.
