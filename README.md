# Outcome Desk

A desktop-first, read-only terminal for Outcome.xyz HIP-4 markets. It uses the official `@outcome.xyz/hip4` SDK against Hyperliquid mainnet public market data. The app does not connect a wallet or submit transactions.

## Run locally

Requires Node.js 20.19 or newer.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. The app fetches market metadata, order book snapshots, trades, and candle history, then subscribes to live public feeds.

The screen is a terminal grid. Market watch sits on the left. The center stacks the underlying chart and the YES contract chart on one shared time axis. Depth of market and the order ticket sit on the right. A bottom terminal holds public trades, and empty read-only tabs for positions, open orders, fills, and balances. The order ticket is a calculator: clicking a book level fills the limit, and Review never submits.

Depth follows the side selected on the ticket. Side labels come from the SDK. Underlying charts use market metadata when it is present and infer BTC, ETH, or HYPE from the contract name when it is not. Both charts show volume. The underlying chart supports candle intervals down to 15 seconds. Fifteen-second candles are aggregated from recent trades and updated live; their backfill is limited to the recent-trade history returned by Hyperliquid. The YES chart plots public trade prices from 0 to 1 USDC and backfills up to 1,000 recent trades. Pan and zoom on either chart move both.

The watchlist loads the full market catalog, ordered by 24-hour volume, so search and filters include markets beyond the initial 100 results. It can filter by market type, deployer venue/address, and time to settlement. Each row shows the settlement or event target and remaining time when the SDK metadata provides one. Panel sizes and which panes are open are stored in the browser. Dark is the default. The app follows the system theme until the sun/moon control or View menu switches it, and that choice is stored in the browser.

## SDK license

`@outcome.xyz/hip4` is licensed under BUSL-1.1. The current grant permits personal, non-commercial projects that are not offered to third parties. Review the SDK's [license](https://github.com/Outcome-xyz/hip4/blob/main/LICENSE) before distributing this app or making it available as a service.
