# HIP-4 terminal prototype

This prototype explores a desktop trading terminal for binary outcome markets. It is a standalone HTML file with no build step or external dependencies.

Files:

- [Project spec](HIP4-terminal-spec.md)
- [Chosen option: Terminal Grid](hip4-terminal-prototype.html?variant=grid)

## Chosen option

Option 1, Terminal Grid, is the selected design and the default when the page opens without a variant parameter. The other two layouts remain available for comparison.

## Layouts

The page has three switchable layouts. Use the bottom switcher or set `?variant=grid`, `?variant=trade`, or `?variant=studio` in the page URL.

- **Terminal Grid** uses a market watch and navigator at left, two stacked charts in the center, and the order book and ticket at right. Account tabs span the bottom.
- **Order First** gives the YES contract chart more room and places the order ticket above the order book.
- **Chart Studio** puts the underlying and YES charts side by side, with market stats below and a wide ticket dock.

## Included interactions

- Selecting a market updates the displayed question, underlying price, YES price, expiry, and settlement rule.
- Timeframe buttons update the interval labels on both charts. The sample candle series stays fixed.
- Clicking an order-book level copies its price into the ticket.
- Buy and sell selections update the estimated proceeds or cost, fees, and maximum loss.
- Reviewing an order opens a confirmation step. Confirming adds an in-memory mock order. The Open orders tab can cancel it.
- The bottom tabs show sample positions, orders, fills, activity statuses, and balances.

## Visual direction

The latest pass follows the supplied MetaTrader 5 reference. It uses compact gray toolbars, flat docked panes, square controls, and denser tables. The charts use a black background, bright candles, dotted grid lines, and green, red, and blue indicator lines. The layout keeps the underlying and YES charts visible alongside the order book and ticket.

## Prototype limits

All markets, prices, balances, chart values, positions, and order states are fictional. The page makes no network or exchange calls, and its state resets when the page reloads. Confirm and cancel actions only change the current page's mock data. The prototype does not implement real market feeds, order execution, chart crosshairs, panel resizing, or docking.
