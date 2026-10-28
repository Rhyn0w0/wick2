# Personal HIP-4 trading terminal

Draft product spec

## Goal

A desktop-first terminal for following an outcome market's underlying asset and YES contract, reading its order book, and placing and managing orders. Assume Hyperliquid for the first version.

## Screen layout

```text
┌ Menu · market selector · timeframe · connection · account ─────────┐
├ Market Watch ───┬ Underlying chart ─────────────────┬ Depth of Market ┤
│ Search / list   ├ YES contract chart ───────────────┤ Order ticket     │
│                 └ Compact stats / indicators ──────┴──────────────────┤
├ Positions · Open orders · Fills · Activity · Balances ────────────────┤
└ Status bar: network · data age · selected market · account ────────────┘
```

Panels should be resizable and dockable, with the charts taking most of the space. The bottom terminal shows positions, open orders, fills, and recent order status.

## Market and charts

- The market selector shows the question, selected outcome side, underlying symbol, expiry or resolution time, and a short settlement rule.
- The underlying chart shows the price source relevant to that market. The YES chart shows the contract's own price history, with a probability-oriented scale for binary YES contracts.
- Keep the charts' time axes and crosshair synchronized, but give each chart its own price scale and units.
- Use candles, interval selection, zoom, and pan. Show the source and latest update time.
- The selected market's metadata must determine its underlying and YES/NO asset identifiers. Hyperliquid represents outcome sides separately, with identifiers derived from the outcome ID and side. [Hyperliquid asset ID docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids)

## Stats and depth

- Reserve a compact dock beneath the charts for custom indicators and stats. Keep it configurable, but leave its contents open until the metrics are chosen.
- Show the selected side's live L2 book with bid, ask, size, and spread. Clicking a level fills the order ticket's price field without submitting an order.
- Hyperliquid documents live L2 book and candle subscriptions; its snapshot endpoint returns up to 20 levels per side. [WebSocket subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions), [Info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)

## Order ticket

- Make the outcome side, Buy/Sell action, limit price, and quantity explicit.
- Show estimated cost, maximum loss, potential settlement value, fees, and available balance before submission.
- Require a review step before sending an order. Show clear submitted, partially filled, filled, cancelled, rejected, and unknown states.
- Include open-order cancellation and a position summary for the selected contract.
- If the connection drops or an order response is unclear, show the unresolved state and reconcile it before allowing a blind retry. Hyperliquid documents that delayed actions can be accepted after reconnection, which can lead to duplicate orders if users retry. [Hyperliquid "Action already expired" guidance](https://hyperliquid.gitbook.io/hyperliquid-docs/support/faq/trade-outcome-looks-incorrect/what-does-action-already-expired-mean)

## Visual direction

Use MetaTrader 5 as a reference for a compact, tool-first workstation: small controls, dense tables, clear separators, flat panes, and charts with visible grids. Use restrained blue for selection, green for bids, and muted red for asks. Keep corners square or only slightly rounded and use consistent spacing and aligned numbers.

## Assumptions and open decisions

Assume a desktop browser, Hyperliquid, and binary YES/NO markets for the first pass. The official API docs currently label `outcomeMeta` as testnet-only, so mainnet metadata support needs checking before the integration design is fixed. [Hyperliquid Spot API docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot)

The two choices that most affect the next draft are whether this should be a browser app or native desktop app, and whether version one should place real mainnet orders or start read-only/on testnet.
