import {
  createHIP4Adapter,
  createPerpPriceFeed,
  readDeployedOutcome,
  type HIP4Market,
} from "@outcome.xyz/hip4";
import "./style.css";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  lastTradeAt?: number;
};

type TradeTick = { price: number; size: number; timestamp: number };
type PerpTrade = {
  coin: string;
  side: "B" | "A";
  px: string;
  sz: string;
  time: number;
  hash: string;
  tid: number;
};

type OrderBook = {
  marketId: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: number;
};

type RawBookSnapshot = {
  coin?: string;
  time?: number;
  levels?: Array<Array<{ px: string; sz: string }>>;
};

type Trade = {
  id: string;
  marketId: string;
  outcome: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  timestamp: number;
};

type MarketKind = HIP4Market["type"] | "all";
type Interval = "15s" | "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
type OutcomeWindow = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
type SettlementFilter = "all" | "under15m" | "15mTo1h" | "1hTo24h" | "over24h" | "past" | "unknown";

const DISPLAY_LEVELS = 9;
const DISPLAY_TRADES = 40;
const CHART_TRADE_BACKFILL_LIMIT = 1000;
const PROTOCOL_DEPLOYER = "__protocol__";
const INTERVALS: Interval[] = ["15s", "1m", "5m", "15m", "1h", "4h", "1d"];
const OUTCOME_WINDOWS: OutcomeWindow[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
const INTERVAL_MS: Record<Interval, number> = {
  "15s": 15_000,
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};
const OUTCOME_WINDOW_MS: Record<OutcomeWindow, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};
const marketKinds: Array<{ value: MarketKind; label: string }> = [
  { value: "all", label: "All market types" },
  { value: "defaultBinary", label: "Recurring binary" },
  { value: "labelledBinary", label: "Custom binary" },
  { value: "multiOutcome", label: "Multi-outcome" },
  { value: "priceBucket", label: "Price buckets" },
];
const settlementFilters: Array<{ value: SettlementFilter; label: string }> = [
  { value: "all", label: "Any settlement time" },
  { value: "under15m", label: "Within 15 minutes" },
  { value: "15mTo1h", label: "15 minutes to 1 hour" },
  { value: "1hTo24h", label: "1 to 24 hours" },
  { value: "over24h", label: "More than 24 hours" },
  { value: "past", label: "Target time passed" },
  { value: "unknown", label: "No target time" },
];

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) throw new Error("App root element was not found.");

const requestedMarket = new URLSearchParams(location.search).get("market");

const state: {
  adapter: ReturnType<typeof createHIP4Adapter> | null;
  markets: HIP4Market[];
  selectedMarketId: string | null;
  kindFilter: MarketKind;
  deployerFilter: string;
  settlementFilter: SettlementFilter;
  deployerAddressesByVenue: Record<string, string>;
  search: string;
  underlyingInterval: Interval;
  outcomeWindow: OutcomeWindow;
  underlyingZoom: number;
  underlyingOffset: number;
  outcomeZoom: number;
  outcomeOffsetMs: number;
  pricesByCoin: Record<string, string>;
  selectedBook: OrderBook | null;
  secondaryBook: OrderBook | null;
  trades: Trade[];
  outcomeChartTrades: Trade[];
  underlyingCandles: Candle[];
  underlyingPrice: number | null;
  seenOutcomeTradeIds: Set<string>;
  seenUnderlyingTradeIds: Set<string>;
  loadingMarkets: boolean;
  loadingMarketData: boolean;
  connection: "starting" | "ready" | "error";
  error: string | null;
  lastUpdateAt: number | null;
} = {
  adapter: null,
  markets: [],
  selectedMarketId: requestedMarket,
  kindFilter: "all",
  deployerFilter: "all",
  settlementFilter: "all",
  deployerAddressesByVenue: {},
  search: "",
  underlyingInterval: "1h",
  outcomeWindow: "1h",
  underlyingZoom: 0,
  underlyingOffset: 0,
  outcomeZoom: 0,
  outcomeOffsetMs: 0,
  pricesByCoin: {},
  selectedBook: null,
  secondaryBook: null,
  trades: [],
  outcomeChartTrades: [],
  underlyingCandles: [],
  underlyingPrice: null,
  seenOutcomeTradeIds: new Set(),
  seenUnderlyingTradeIds: new Set(),
  loadingMarkets: true,
  loadingMarketData: false,
  connection: "starting",
  error: null,
  lastUpdateAt: null,
};

let unsubscribeAllMids: (() => void) | null = null;
let selectedUnsubscribers: Array<() => void> = [];
let selectedMarketLoad = 0;
let chartDrag: { kind: "underlying" | "contract"; lastX: number } | null = null;

const DEFAULT_VISIBLE_CANDLES = 70;
const MAX_CHART_ZOOM = 8;
const CHART_ZOOM_FACTOR = 1.5;

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

function currentMarket(): HIP4Market | undefined {
  return state.markets.find(
    (market) => String(market.outcomeId) === state.selectedMarketId,
  );
}

function marketId(market: HIP4Market): string {
  return String(market.outcomeId);
}

function marketTitle(market: HIP4Market): string {
  return market.parsedName ||
    ("parsedQuestionName" in market ? market.parsedQuestionName : undefined) ||
    market.name ||
    `Outcome ${market.outcomeId}`;
}

function marketUnderlying(market: HIP4Market): string | null {
  if ("underlying" in market && market.underlying) return market.underlying;
  const title = marketTitle(market);
  if (/\b(?:BTC|BITCOIN)\b/i.test(title)) return "BTC";
  if (/\b(?:ETH|ETHER|ETHEREUM)\b/i.test(title)) return "ETH";
  if (/\b(?:HYPE|HYPER|HYPERLIQUID)\b/i.test(title)) return "HYPE";
  return null;
}

type MarketStrikeLine = { price: number; label: string };

function marketStrikeLines(market: HIP4Market): MarketStrikeLine[] {
  const validPrice = (value: unknown): number | null => {
    const price = typeof value === "number" ? value : Number(value);
    return Number.isFinite(price) && price > 0 ? price : null;
  };

  if ("targetPrice" in market) {
    const price = validPrice(market.targetPrice);
    if (price !== null) return [{ price, label: "STRIKE" }];
  }
  if (market.type === "priceBucket") {
    const lines: MarketStrikeLine[] = [];
    const lower = validPrice(market.lowerBound);
    const upper = validPrice(market.upperBound);
    if (lower !== null) lines.push({ price: lower, label: "LOWER" });
    if (upper !== null) lines.push({ price: upper, label: "UPPER" });
    if (lines.length > 0) return lines;
  }

  const decoded = readDeployedOutcome(
    market.raw,
    "rawQuestion" in market ? market.rawQuestion : null,
  );
  const publishedThreshold = validPrice(decoded.threshold);
  if (publishedThreshold !== null) return [{ price: publishedThreshold, label: "STRIKE" }];

  const thresholdPattern = /(?:\b(?:above|over|greater than|higher than|at least|below|under|less than|lower than|at most)\b|[<>]=?)\s*(?:USD\s*)?\$?\s*(\d[\d,]*(?:\.\d+)?)/gi;
  const contractText = `${marketTitle(market)} ${market.description}`;
  const parsedLines: MarketStrikeLine[] = [];
  for (const match of contractText.matchAll(thresholdPattern)) {
    const price = validPrice(match[1].replaceAll(",", ""));
    if (price === null || parsedLines.some((line) => line.price === price)) continue;
    parsedLines.push({ price, label: "STRIKE" });
  }
  return parsedLines.slice(0, 2);
}

function sideName(market: HIP4Market, index: 0 | 1): string {
  const side = market.sides[index];
  return side?.parsedName || side?.name || `Side ${index}`;
}

function marketSummary(market: HIP4Market): string {
  const firstSide = sideName(market, 0);
  const price = state.pricesByCoin[market.sides[0]?.coin ?? ""];
  const quote = formatQuote(price);
  return `${firstSide} ${quote}`;
}

function typeLabel(type: HIP4Market["type"]): string {
  return marketKinds.find((kind) => kind.value === type)?.label ?? type;
}

function marketVenue(market: HIP4Market): string {
  return market.raw.venue?.trim().toLocaleLowerCase() ?? "";
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function deployerFilterKey(market: HIP4Market): string {
  const venue = marketVenue(market);
  if (!venue) return PROTOCOL_DEPLOYER;
  return state.deployerAddressesByVenue[venue]?.toLocaleLowerCase() ?? `venue:${venue}`;
}

function deployerLabel(market: HIP4Market): string {
  const venue = marketVenue(market);
  if (!venue) return "Protocol";
  const address = state.deployerAddressesByVenue[venue];
  return address ? `${venue.toLocaleUpperCase()} · ${shortAddress(address)}` : `Venue ${venue.toLocaleUpperCase()}`;
}

function deployerFilterOptions(): Array<{ value: string; label: string }> {
  const deployers = new Map<string, { address: string | null; venues: Set<string> }>();
  let hasProtocolMarkets = false;
  for (const market of state.markets) {
    const venue = marketVenue(market);
    if (!venue) {
      hasProtocolMarkets = true;
      continue;
    }
    const address = state.deployerAddressesByVenue[venue]?.toLocaleLowerCase() ?? null;
    const key = address ?? `venue:${venue}`;
    const entry = deployers.get(key) ?? { address, venues: new Set<string>() };
    entry.venues.add(venue);
    deployers.set(key, entry);
  }

  const options = [{ value: "all", label: "All deployers" }];
  if (hasProtocolMarkets) options.push({ value: PROTOCOL_DEPLOYER, label: "Protocol markets" });
  for (const [value, entry] of deployers) {
    const venues = [...entry.venues].sort().map((venue) => venue.toLocaleUpperCase()).join(", ");
    options.push({
      value,
      label: entry.address ? `${shortAddress(entry.address)} · ${venues}` : `${venues} (venue)`,
    });
  }
  return [options[0], ...options.slice(1).sort((left, right) => left.label.localeCompare(right.label))];
}

function settlementTarget(market: HIP4Market): { timestamp: number; label: string } | null {
  if ("expiry" in market && market.expiry) {
    const timestamp = market.expiry.getTime();
    return Number.isFinite(timestamp) ? { timestamp, label: "Settlement" } : null;
  }
  const decoded = readDeployedOutcome(
    market.raw,
    "rawQuestion" in market ? market.rawQuestion : null,
  );
  const deadline = decoded.resolutionDeadline;
  const target = deadline ?? decoded.eventAt;
  if (!target) return null;
  return {
    timestamp: target.getTime(),
    label: deadline ? "Resolution deadline" : "Event target",
  };
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

function formatCountdown(milliseconds: number): string {
  if (milliseconds <= 0) return "Target passed";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatUtcClock(): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(Date.now());
}

function formatUtcTarget(timestamp: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(timestamp);
}

function formatVolume(volume: number | undefined, unit: string): string {
  if (volume === undefined || !Number.isFinite(volume) || volume < 0) return "—";
  const compact = new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(volume);
  return `${compact} ${unit}`;
}

function candleBucket(timestampMs: number, interval: Interval): number {
  return Math.floor(timestampMs / INTERVAL_MS[interval]) * INTERVAL_MS[interval] / 1000;
}

function ticksToCandles(ticks: TradeTick[], interval: Interval): Candle[] {
  const candles = new Map<number, Candle>();
  for (const tick of [...ticks].sort((left, right) => left.timestamp - right.timestamp)) {
    if (![tick.timestamp, tick.price, tick.size].every(Number.isFinite) || tick.price <= 0 || tick.size < 0) continue;
    const time = candleBucket(tick.timestamp, interval);
    const candle = candles.get(time);
    if (!candle) {
      candles.set(time, {
        time,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: tick.size,
        lastTradeAt: tick.timestamp,
      });
      continue;
    }
    candle.high = Math.max(candle.high, tick.price);
    candle.low = Math.min(candle.low, tick.price);
    candle.close = tick.price;
    candle.volume += tick.size;
    candle.lastTradeAt = tick.timestamp;
  }
  return [...candles.values()].sort((left, right) => left.time - right.time);
}

function addTradeToCandles(candles: Candle[], tick: TradeTick, interval: Interval): Candle[] {
  if (![tick.timestamp, tick.price, tick.size].every(Number.isFinite) || tick.price <= 0 || tick.size < 0) return candles;
  const time = candleBucket(tick.timestamp, interval);
  const next = [...candles];
  let candle = next.find((entry) => entry.time === time);
  if (!candle) {
    candle = {
      time,
      open: tick.price,
      high: tick.price,
      low: tick.price,
      close: tick.price,
      volume: 0,
      lastTradeAt: tick.timestamp,
    };
    next.push(candle);
  }
  candle.high = Math.max(candle.high, tick.price);
  candle.low = Math.min(candle.low, tick.price);
  candle.volume += tick.size;
  if (candle.lastTradeAt === undefined || tick.timestamp >= candle.lastTradeAt) {
    candle.close = tick.price;
    candle.lastTradeAt = tick.timestamp;
  }
  return next.sort((left, right) => left.time - right.time).slice(-2000);
}

function underlyingTick(trade: PerpTrade): TradeTick {
  return { price: Number(trade.px), size: Number(trade.sz), timestamp: trade.time };
}

function formatSettlementTarget(market: HIP4Market): string {
  const target = settlementTarget(market);
  if (!target) return "No settlement time";
  const date = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(target.timestamp);
  const remaining = target.timestamp - Date.now();
  const relative = remaining <= 0 ? "target passed" : `in ${formatDuration(remaining)}`;
  return `${target.label}: ${date} · ${relative}`;
}

function matchesSettlementFilter(market: HIP4Market): boolean {
  if (state.settlementFilter === "all") return true;
  const target = settlementTarget(market);
  if (!target) return state.settlementFilter === "unknown";
  const remaining = target.timestamp - Date.now();
  switch (state.settlementFilter) {
    case "under15m": return remaining > 0 && remaining <= 15 * 60_000;
    case "15mTo1h": return remaining > 15 * 60_000 && remaining <= 60 * 60_000;
    case "1hTo24h": return remaining > 60 * 60_000 && remaining <= 24 * 60 * 60_000;
    case "over24h": return remaining > 24 * 60 * 60_000;
    case "past": return remaining <= 0;
    case "unknown": return false;
  }
}

function bestBidOffer(book: OrderBook | null): { bid: string; offer: string } {
  const bids = book ? sortBookLevels(book.bids, "desc") : [];
  const offers = book ? sortBookLevels(book.asks, "asc") : [];
  const price = (raw: string | undefined) => {
    if (raw === undefined) return "—";
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed.toFixed(3) : "—";
  };
  return {
    bid: price(bids[0]?.price),
    offer: price(offers[0]?.price),
  };
}

function mapRawBook(snapshot: unknown, id: string, expectedCoin: string): OrderBook | null {
  const raw = snapshot as RawBookSnapshot;
  if (raw?.coin !== expectedCoin || !Array.isArray(raw.levels) || raw.levels.length < 2) return null;
  const [bids, offers] = raw.levels;
  return {
    marketId: id,
    bids: bids.map((level) => ({ price: level.px, size: level.sz })),
    asks: offers.map((level) => ({ price: level.px, size: level.sz })),
    timestamp: raw.time ?? Date.now(),
  };
}

function formatQuote(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined || raw === "" || raw === "0") return "—";
  const price = Number(raw);
  if (!Number.isFinite(price) || price <= 0) return "—";
  return price.toFixed(3);
}

function formatNumber(raw: string | number | null | undefined, digits = 3): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatUnderlying(raw: number | null | undefined): string {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return "—";
  return `$${raw.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatTime(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function formatAge(timestamp: number | null): string {
  if (!timestamp) return "Waiting for data";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `Updated ${seconds}s ago`;
  return `Updated ${Math.floor(seconds / 60)}m ago`;
}

function formatExpiry(market: HIP4Market): string {
  if (!("expiry" in market) || !market.expiry) return "No expiry in market metadata";
  const expiry = market.expiry instanceof Date ? market.expiry : new Date(market.expiry);
  if (Number.isNaN(expiry.getTime())) return "Expiry unavailable";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(expiry);
}

function filteredMarkets(): HIP4Market[] {
  const query = state.search.trim().toLocaleLowerCase();
  return state.markets.filter((market) => {
    if (state.kindFilter !== "all" && market.type !== state.kindFilter) return false;
    if (state.deployerFilter !== "all" && deployerFilterKey(market) !== state.deployerFilter) return false;
    if (!matchesSettlementFilter(market)) return false;
    if (!query) return true;
    const searchable = [
      market.name,
      market.parsedName,
      market.description,
      market.type,
      sideName(market, 0),
      sideName(market, 1),
      "underlying" in market ? market.underlying : "",
      "questionName" in market ? market.questionName : "",
      "parsedQuestionName" in market ? market.parsedQuestionName : "",
      marketVenue(market),
      state.deployerAddressesByVenue[marketVenue(market)] ?? "",
      formatSettlementTarget(market),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return searchable.includes(query);
  });
}

function renderMarketRows(): string {
  const markets = filteredMarkets();
  if (state.loadingMarkets && markets.length === 0) {
    return `<div class="empty-state">Loading Outcome markets…</div>`;
  }
  if (markets.length === 0) {
    return `<div class="empty-state">No markets match this filter.</div>`;
  }
  return markets
    .map((market) => {
      const id = marketId(market);
      const selected = id === state.selectedMarketId;
      return `
        <button class="market-row ${selected ? "selected" : ""}" data-market-id="${esc(id)}" aria-pressed="${selected}">
          <span class="market-row-title">${esc(marketTitle(market))}</span>
          <span class="market-row-price mono" data-market-price="${esc(id)}">${esc(marketSummary(market))}</span>
          <span class="market-row-meta">${esc(typeLabel(market.type))} · ${esc(deployerLabel(market))} · #${esc(id)}</span>
          <span class="market-row-settlement">${esc(formatSettlementTarget(market))}</span>
        </button>`;
    })
    .join("");
}

function renderMarketWatch(): string {
  const visibleCount = filteredMarkets().length;
  const deployers = deployerFilterOptions();
  return `
    <section class="panel market-watch" aria-label="Outcome market watch">
      <div class="panel-heading"><span>Market watch</span><span class="panel-count">${visibleCount} / ${state.markets.length}</span></div>
      <div class="watch-controls">
        <label class="sr-only" for="market-search">Search markets</label>
        <input id="market-search" type="search" placeholder="Search markets or deployers" value="${esc(state.search)}" autocomplete="off" />
        <label class="sr-only" for="market-type">Market type</label>
        <select id="market-type" aria-label="Filter market type">
          ${marketKinds
            .map(
              (kind) =>
                `<option value="${kind.value}" ${state.kindFilter === kind.value ? "selected" : ""}>${esc(kind.label)}</option>`,
            )
            .join("")}
        </select>
        <label class="sr-only" for="market-deployer">Deployer</label>
        <select id="market-deployer" aria-label="Filter by deployer">
          ${deployers
            .map(
              (deployer) =>
                `<option value="${esc(deployer.value)}" ${state.deployerFilter === deployer.value ? "selected" : ""}>${esc(deployer.label)}</option>`,
            )
            .join("")}
        </select>
        <label class="sr-only" for="market-settlement">Time to settlement</label>
        <select id="market-settlement" aria-label="Filter by time to settlement">
          ${settlementFilters
            .map(
              (filter) =>
                `<option value="${filter.value}" ${state.settlementFilter === filter.value ? "selected" : ""}>${esc(filter.label)}</option>`,
            )
            .join("")}
        </select>
      </div>
      <div class="market-list" id="market-list">${renderMarketRows()}</div>
      <div class="watch-footer">
        <span>${state.loadingMarkets ? "Loading markets…" : `${state.markets.length} markets available`}</span>
      </div>
    </section>`;
}

function renderIntervals(kind: "contract" | "underlying"): string {
  const intervals = kind === "underlying" ? INTERVALS : OUTCOME_WINDOWS;
  const selected = kind === "underlying" ? state.underlyingInterval : state.outcomeWindow;
  return intervals.map(
    (interval) =>
      `<button class="interval-button ${selected === interval ? "active" : ""}" data-chart-kind="${kind}" data-interval="${interval}" aria-pressed="${selected === interval}">${interval}</button>`,
  ).join("");
}

function metadataChips(market: HIP4Market | undefined): string {
  if (!market) return "";
  const chips = [
    `<span class="chip">${esc(typeLabel(market.type))}</span>`,
    `<span class="chip mono">Outcome #${esc(market.outcomeId)}</span>`,
  ];
  const underlying = marketUnderlying(market);
  if (underlying) {
    const inferred = !("underlying" in market && market.underlying);
    chips.push(`<span class="chip">Underlying ${esc(underlying)}${inferred ? " · inferred" : ""}</span>`);
  }
  if ("period" in market && market.period) {
    chips.push(`<span class="chip">${esc(market.period)}</span>`);
  }
  if ("expiry" in market && market.expiry) {
    chips.push(`<span class="chip">Resolves ${esc(formatExpiry(market))}</span>`);
  }
  return chips.join("");
}

function renderSelectedContext(): string {
  const market = currentMarket();
  if (!market) {
    return `<section class="market-context panel"><div class="context-empty">${state.loadingMarkets ? "Connecting to Outcome…" : "Select a market to view its data."}</div></section>`;
  }
  const yes = bestBidOffer(state.selectedBook);
  const no = bestBidOffer(state.secondaryBook);
  return `
    <section class="market-context panel" aria-label="Selected market">
      <div class="market-heading-row">
        <div class="market-heading-copy">
          <div class="eyebrow">Selected Outcome market</div>
          <h1>${esc(marketTitle(market))}</h1>
        </div>
        <div class="side-quotes">
          <div class="side-quote" title="Best bid / best offer">
            <span>${esc(sideName(market, 0))} · bid / offer</span>
            <strong class="mono" id="side-zero-price">${esc(`${yes.bid} / ${yes.offer}`)}</strong>
          </div>
          <div class="side-quote secondary" title="Best bid / best offer">
            <span>${esc(sideName(market, 1))} · bid / offer</span>
            <strong class="mono" id="side-one-price">${esc(`${no.bid} / ${no.offer}`)}</strong>
          </div>
        </div>
      </div>
      <div class="context-meta">
        <div class="context-chips">${metadataChips(market)}</div>
        <div class="context-timing">
          <span class="utc-clock"><span>UTC</span><strong class="mono" id="utc-clock">${esc(formatUtcClock())}</strong></span>
          <span class="settlement-clock mono" id="settlement-clock">${esc(settlementClockText(market))}</span>
        </div>
      </div>
    </section>`;
}

function settlementClockText(market: HIP4Market): string {
  const target = settlementTarget(market);
  if (!target) return "No settlement target";
  return `${target.label} ${formatUtcTarget(target.timestamp)} UTC · ${formatCountdown(target.timestamp - Date.now())}`;
}

function chartZoomScale(zoom: number): number {
  return CHART_ZOOM_FACTOR ** zoom;
}

function visibleUnderlyingCandleCount(zoom = state.underlyingZoom): number {
  return Math.max(6, Math.round(DEFAULT_VISIBLE_CANDLES / chartZoomScale(zoom)));
}

function maximumUnderlyingOffset(zoom = state.underlyingZoom): number {
  return Math.max(0, state.underlyingCandles.length - visibleUnderlyingCandleCount(zoom));
}

function outcomeChartRange(
  window: OutcomeWindow,
  zoom: number,
  offsetMs: number,
): { startTime: number; endTime: number; duration: number; maxOffsetMs: number } {
  const now = Date.now();
  const duration = OUTCOME_WINDOW_MS[window] / chartZoomScale(zoom);
  const oldestTrade = state.outcomeChartTrades.reduce(
    (oldest, trade) => Math.min(oldest, trade.timestamp),
    now,
  );
  const maxOffsetMs = Math.max(0, now - oldestTrade - duration);
  const endTime = now - Math.max(0, Math.min(offsetMs, maxOffsetMs));
  return { startTime: endTime - duration, endTime, duration, maxOffsetMs };
}

function renderChartControls(kind: "underlying" | "contract"): string {
  const zoom = kind === "underlying" ? state.underlyingZoom : state.outcomeZoom;
  const offset = kind === "underlying" ? state.underlyingOffset : state.outcomeOffsetMs;
  const maximumOffset = kind === "underlying"
    ? maximumUnderlyingOffset()
    : outcomeChartRange(state.outcomeWindow, zoom, offset).maxOffsetMs;
  const isAtLiveEdge = offset <= 0;
  const canPanOlder = offset < maximumOffset;
  const zoomPercent = Math.round(chartZoomScale(zoom) * 100);
  const control = (action: string, label: string, title: string, disabled: boolean) =>
    `<button class="chart-control" type="button" data-chart-kind="${kind}" data-chart-action="${action}" aria-label="${label}" title="${title}" ${disabled ? "disabled" : ""}>${label}</button>`;
  return `<div class="chart-controls" aria-label="Chart navigation">
    ${control("older", "←", "Pan to older data", !canPanOlder)}
    ${control("newer", "→", "Pan to newer data", isAtLiveEdge)}
    ${control("zoom-out", "−", "Zoom out", zoom <= 0)}
    <span class="chart-zoom mono" aria-label="Zoom level">${zoomPercent}%</span>
    ${control("zoom-in", "+", "Zoom in", zoom >= MAX_CHART_ZOOM)}
    ${control("reset", "Fit", "Reset zoom and return to live data", zoom === 0 && isAtLiveEdge)}
  </div>`;
}

function candleChart(
  candles: Candle[],
  kind: "contract" | "underlying",
  livePrice: number | null,
  strikeLines: MarketStrikeLine[],
): string {
  const validCandles = candles
    .filter((candle) =>
      [candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite),
    );
  const zoom = state.underlyingZoom;
  const visibleCount = visibleUnderlyingCandleCount(zoom);
  const offset = Math.min(Math.round(state.underlyingOffset), maximumUnderlyingOffset(zoom));
  const endIndex = validCandles.length - offset;
  const visible = validCandles.slice(Math.max(0, endIndex - visibleCount), endIndex);
  if (visible.length === 0) {
    return `<div class="chart-empty">${state.loadingMarketData ? "Loading candle history…" : "No candle history is available for this market."}</div>`;
  }

  const width = 760;
  const height = 218;
  const left = 62;
  const right = 12;
  const top = 14;
  const bottom = 16;
  const volumeHeight = 32;
  const volumeGap = 7;
  const plotWidth = width - left - right;
  const plotBottom = height - bottom - volumeHeight - volumeGap;
  const plotHeight = plotBottom - top;
  const volumeTop = plotBottom + volumeGap;
  const volumeBottom = height - bottom;
  let minimum = Math.min(...visible.map((candle) => candle.low));
  let maximum = Math.max(...visible.map((candle) => candle.high));
  if (kind === "contract") {
    minimum = Math.max(0, Math.min(minimum, 0));
    maximum = Math.min(1, Math.max(maximum, 1));
  }
  if (livePrice !== null && Number.isFinite(livePrice)) {
    minimum = Math.min(minimum, livePrice);
    maximum = Math.max(maximum, livePrice);
  }
  for (const strike of strikeLines) {
    minimum = Math.min(minimum, strike.price);
    maximum = Math.max(maximum, strike.price);
  }
  const span = maximum - minimum || Math.max(Math.abs(maximum) * 0.02, 0.01);
  const padding = span * (kind === "contract" ? 0.04 : 0.1);
  minimum = Math.max(kind === "contract" ? 0 : -Infinity, minimum - padding);
  maximum = Math.min(kind === "contract" ? 1 : Infinity, maximum + padding);
  const adjustedSpan = maximum - minimum || 1;
  const y = (price: number) => top + ((maximum - price) / adjustedSpan) * plotHeight;
  const x = (index: number) => left + (index / Math.max(visible.length - 1, 1)) * plotWidth;
  const candleWidth = Math.max(2, Math.min(8, (plotWidth / visible.length) * 0.58));
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = maximum - (adjustedSpan * index) / 4;
    const lineY = top + (plotHeight * index) / 4;
    return `<g><line class="chart-gridline" x1="${left}" y1="${lineY}" x2="${width - right}" y2="${lineY}"/><text class="chart-axis-label" x="${left - 8}" y="${lineY + 3}" text-anchor="end">${esc(kind === "underlying" ? formatUnderlying(value) : value.toFixed(2))}</text></g>`;
  }).join("");
  const bars = visible
    .map((candle, index) => {
      const candleX = x(index);
      const topY = y(Math.max(candle.open, candle.close));
      const bottomY = y(Math.min(candle.open, candle.close));
      const bodyHeight = Math.max(1, bottomY - topY);
      const direction = candle.close >= candle.open ? "up" : "down";
      return `<g class="candle ${direction}"><line x1="${candleX}" y1="${y(candle.high)}" x2="${candleX}" y2="${y(candle.low)}"/><rect x="${candleX - candleWidth / 2}" y="${topY}" width="${candleWidth}" height="${bodyHeight}"/></g>`;
    })
    .join("");
  const maxVolume = Math.max(1, ...visible.map((candle) => Number(candle.volume) || 0));
  const volumeBars = visible
    .map((candle, index) => {
      const candleX = x(index);
      const volume = Math.max(0, Number(candle.volume) || 0);
      const barHeight = volume > 0 ? Math.max(1, (volume / maxVolume) * (volumeBottom - volumeTop)) : 0;
      const direction = candle.close >= candle.open ? "up" : "down";
      return barHeight > 0
        ? `<rect class="volume-bar ${direction}" x="${candleX - candleWidth / 2}" y="${volumeBottom - barHeight}" width="${candleWidth}" height="${barHeight}"/>`
        : "";
    })
    .join("");
  const labels = [0, Math.floor((visible.length - 1) / 2), visible.length - 1]
    .filter((index, position, all) => all.indexOf(index) === position)
    .map((index) => {
      const date = new Date(visible[index].time * 1000);
      const label = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
      return `<text class="chart-axis-label" x="${x(index)}" y="${height - 7}" text-anchor="middle">${esc(label)}</text>`;
    })
    .join("");
  const strikeMarkers = strikeLines.map((strike, index) => {
    const lineY = y(strike.price);
    const labelY = Math.min(plotBottom - 2, Math.max(top + 9, lineY - 3 + index * 10));
    return `<g class="strike-marker"><line class="strike-price-line" x1="${left}" y1="${lineY}" x2="${width - right}" y2="${lineY}"/><text class="strike-price-label" x="${width - right - 3}" y="${labelY}" text-anchor="end">${esc(`${strike.label} ${formatUnderlying(strike.price)}`)}</text></g>`;
  }).join("");
  const volumeLabel = `<g><line class="volume-divider" x1="${left}" y1="${volumeTop - 3}" x2="${width - right}" y2="${volumeTop - 3}"/><text class="volume-axis-label" x="${left - 8}" y="${volumeTop + 8}" text-anchor="end">VOL</text></g>`;
  const strikeDescription = strikeLines.length > 0
    ? `; ${strikeLines.map((strike) => `${strike.label} ${formatUnderlying(strike.price)}`).join(", ")}`
    : "; contract strike unavailable";

  return `<svg class="candle-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(`${kind === "underlying" ? "Underlying asset" : "Outcome side"} candlestick chart with volume${strikeDescription}`)}">${grid}${bars}${strikeMarkers}${volumeLabel}${volumeBars}${labels}</svg>`;
}

function outcomeTradesInWindow(
  trades: Trade[],
  window: OutcomeWindow,
  zoom: number,
  offsetMs: number,
): Trade[] {
  const { startTime, endTime } = outcomeChartRange(window, zoom, offsetMs);
  return trades
    .filter((trade) => {
      const price = Number(trade.price);
      return trade.timestamp >= startTime && trade.timestamp <= endTime && Number.isFinite(price) && price >= 0;
    })
    .sort((left, right) => left.timestamp - right.timestamp);
}

function outcomeLineChart(trades: Trade[], window: OutcomeWindow, zoom: number, offsetMs: number): string {
  const visible = outcomeTradesInWindow(trades, window, zoom, offsetMs).slice(-400);
  if (visible.length === 0) {
    return `<div class="chart-empty">${state.loadingMarketData ? "Loading recent trade history…" : "No trade prices in this window."}</div>`;
  }

  const width = 760;
  const height = 218;
  const left = 62;
  const right = 12;
  const top = 14;
  const bottom = 16;
  const volumeHeight = 32;
  const volumeGap = 7;
  const plotWidth = width - left - right;
  const plotBottom = height - bottom - volumeHeight - volumeGap;
  const plotHeight = plotBottom - top;
  const volumeTop = plotBottom + volumeGap;
  const volumeBottom = height - bottom;
  const { startTime, endTime, duration } = outcomeChartRange(window, zoom, offsetMs);
  const prices = visible.map((trade) => Number(trade.price));
  const rawMinimum = Math.min(...prices);
  const rawMaximum = Math.max(...prices);
  const rawSpan = rawMaximum - rawMinimum || Math.max(Math.abs(rawMaximum) * 0.02, 0.01);
  const padding = rawSpan * 0.08;
  let minimum = Math.max(0, rawMinimum - padding);
  let maximum = Math.min(1, rawMaximum + padding);
  if (maximum <= minimum) {
    minimum = Math.max(0, minimum - 0.01);
    maximum = Math.min(1, maximum + 0.01);
  }
  const priceSpan = maximum - minimum || 1;
  const x = (timestamp: number) => left + Math.max(0, Math.min(1, (timestamp - startTime) / duration)) * plotWidth;
  const y = (price: number) => top + ((maximum - price) / priceSpan) * plotHeight;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = maximum - (priceSpan * index) / 4;
    const lineY = top + (plotHeight * index) / 4;
    return `<g><line class="chart-gridline" x1="${left}" y1="${lineY}" x2="${width - right}" y2="${lineY}"/><text class="chart-axis-label" x="${left - 8}" y="${lineY + 3}" text-anchor="end">${value.toFixed(3)}</text></g>`;
  }).join("");
  const linePath = visible
    .map((trade, index) => `${index === 0 ? "M" : "L"}${x(trade.timestamp).toFixed(2)},${y(Number(trade.price)).toFixed(2)}`)
    .join(" ");
  const points = visible
    .map((trade) => `<circle class="trade-point" cx="${x(trade.timestamp)}" cy="${y(Number(trade.price))}" r="1.5"/>`)
    .join("");
  const bucketCount = 60;
  const bucketSize = duration / bucketCount;
  const volumes = Array.from({ length: bucketCount }, () => 0);
  for (const trade of visible) {
    const index = Math.max(0, Math.min(bucketCount - 1, Math.floor((trade.timestamp - startTime) / bucketSize)));
    volumes[index] += Math.max(0, Number(trade.size) || 0);
  }
  const maxVolume = Math.max(1, ...volumes);
  const volumeBarWidth = (plotWidth / bucketCount) * 0.72;
  const volumeBars = volumes
    .map((volume, index) => {
      if (volume <= 0) return "";
      const barHeight = Math.max(1, (volume / maxVolume) * (volumeBottom - volumeTop));
      const centerX = left + ((index + 0.5) / bucketCount) * plotWidth;
      return `<rect class="volume-bar neutral" x="${centerX - volumeBarWidth / 2}" y="${volumeBottom - barHeight}" width="${volumeBarWidth}" height="${barHeight}"/>`;
    })
    .join("");
  const labels = [startTime, startTime + duration / 2, endTime]
    .map((timestamp, index) => {
      const date = new Date(timestamp);
      const label = new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
      const labelX = left + (index / 2) * plotWidth;
      return `<text class="chart-axis-label" x="${labelX}" y="${height - 7}" text-anchor="middle">${esc(label)}</text>`;
    })
    .join("");
  const volumeLabel = `<g><line class="volume-divider" x1="${left}" y1="${volumeTop - 3}" x2="${width - right}" y2="${volumeTop - 3}"/><text class="volume-axis-label" x="${left - 8}" y="${volumeTop + 8}" text-anchor="end">VOL</text></g>`;
  return `<svg class="candle-chart trade-price-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Outcome trade prices connected over time with volume">${grid}${volumeLabel}${volumeBars}<path class="trade-line" d="${linePath}"/>${points}${labels}</svg>`;
}

function renderChartPanel(
  title: string,
  marketId: string | null,
  candles: Candle[],
  kind: "contract" | "underlying",
  livePrice: number | null,
): string {
  const market = currentMarket();
  const zoom = kind === "contract" ? state.outcomeZoom : state.underlyingZoom;
  const offset = kind === "contract" ? state.outcomeOffsetMs : state.underlyingOffset;
  const outcomeTrades = kind === "contract"
    ? outcomeTradesInWindow(state.outcomeChartTrades, state.outcomeWindow, zoom, offset).slice(-400)
    : [];
  const lastOutcomeTrade = outcomeTrades.at(-1);
  const price = kind === "contract" ? (lastOutcomeTrade ? Number(lastOutcomeTrade.price) : null) : livePrice;
  const priceLabel = kind === "contract" ? formatQuote(price) : formatUnderlying(price);
  const underlying = market ? marketUnderlying(market) : null;
  const strikeLines = kind === "underlying" && market ? marketStrikeLines(market) : [];
  const inferredUnderlying = Boolean(market && underlying && !("underlying" in market && market.underlying));
  const subtitle = kind === "contract"
    ? `${market ? sideName(market, 0) : "First side"} · public trade prices`
    : underlying
      ? `${underlying} · Hyperliquid perp${inferredUnderlying ? " · inferred from market name" : " mark"}`
      : "Underlying asset feed unavailable for this market type";
  const noUnderlying = kind === "underlying" && !underlying;
  const latestVolume = kind === "contract"
    ? outcomeTrades.reduce((total, trade) => total + (Number(trade.size) || 0), 0)
    : candles.at(-1)?.volume;
  const volumeUnit = kind === "contract" ? "shares" : underlying ?? "units";
  const timeLabel = `${kind === "contract" ? state.outcomeWindow : state.underlyingInterval} · ${Math.round(chartZoomScale(zoom) * 100)}%`;
  const sourceNote = kind === "contract" || state.underlyingInterval === "15s" ? "recent trades + live" : "SDK history + live";
  const dataCountLabel = kind === "contract" ? `${outcomeTrades.length} trade points` : `${candles.length} candles`;
  const chartContent = noUnderlying
    ? `<div class="chart-empty">No supported underlying could be inferred from this market name.</div>`
    : kind === "contract"
      ? outcomeLineChart(state.outcomeChartTrades, state.outcomeWindow, state.outcomeZoom, state.outcomeOffsetMs)
      : candleChart(candles, kind, price, strikeLines);

  return `
    <section class="panel chart-panel ${kind}-panel">
      <div class="chart-toolbar">
        <div class="chart-title-group"><strong>${esc(title)}</strong><span>${esc(subtitle)}</span></div>
        <strong class="chart-live-price mono">${esc(priceLabel)}</strong>
        ${renderChartControls(kind)}
        <div class="intervals" aria-label="${kind === "contract" ? "Trade price time window" : "Chart interval"}">${renderIntervals(kind)}</div>
      </div>
      <div class="chart-surface ${chartDrag?.kind === kind ? "is-panning" : ""}" data-chart-kind="${kind}" id="${kind}-chart" title="Scroll to zoom · drag to pan">
        ${chartContent}
      </div>
      <div class="chart-footer"><span>${esc(marketId ? `Outcome #${marketId}` : "No selected outcome")}</span><span>${esc(dataCountLabel)} · ${esc(timeLabel)} · Vol ${esc(formatVolume(latestVolume, volumeUnit))} · ${esc(sourceNote)} · ${esc(formatAge(state.lastUpdateAt))}</span></div>
    </section>`;
}

function renderCharts(): string {
  const market = currentMarket();
  const id = market ? marketId(market) : null;
  const underlying = market ? marketUnderlying(market) : null;
  const underlyingTitle = underlying
    ? `${underlying} underlying`
    : "Underlying reference";
  return `<div class="charts-column">${renderChartPanel(underlyingTitle, id, state.underlyingCandles, "underlying", state.underlyingPrice)}${renderChartPanel("Outcome trade price", id, [], "contract", null)}</div>`;
}

function sortBookLevels(
  levels: Array<{ price: string; size: string }>,
  direction: "asc" | "desc",
): Array<{ price: string; size: string }> {
  const aggregated = new Map<number, number>();
  for (const level of levels) {
    const price = Number(level.price);
    const size = Number(level.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
    aggregated.set(price, (aggregated.get(price) ?? 0) + size);
  }
  return [...aggregated.entries()]
    .map(([price, size]) => ({ price: String(price), size: String(size) }))
    .sort((left, right) =>
      direction === "asc"
        ? Number(left.price) - Number(right.price)
        : Number(right.price) - Number(left.price),
    )
    .slice(0, DISPLAY_LEVELS);
}

function renderBook(): string {
  const market = currentMarket();
  const book = state.selectedBook;
  const yesQuotes = bestBidOffer(book);
  const bids = book ? sortBookLevels(book.bids ?? [], "desc") : [];
  const asks = book ? sortBookLevels(book.asks ?? [], "asc") : [];
  const bestBid = bids[0] ? Number(bids[0].price) : null;
  const bestAsk = asks[0] ? Number(asks[0].price) : null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const maxSize = Math.max(
    1,
    ...bids.map((level) => Number(level.size) || 0),
    ...asks.map((level) => Number(level.size) || 0),
  );

  const levelRows = (
    levels: Array<{ price: string; size: string }>,
    side: "bid" | "ask",
  ) =>
    levels.length === 0
      ? `<div class="book-empty">${state.loadingMarketData ? "Loading book…" : "No ${side} levels"}</div>`
      : levels
          .map((level) => {
            const size = Number(level.size) || 0;
            const depth = Math.min(100, (size / maxSize) * 100);
            return `<div class="book-row ${side}"><span class="book-depth" style="width:${depth}%"></span><span class="mono price">${esc(formatNumber(level.price, 3))}</span><span class="mono size">${esc(formatNumber(level.size, 2))}</span></div>`;
          })
          .join("");

  return `
    <section class="panel book-panel">
      <div class="panel-heading"><span>Depth of market</span><span class="panel-tail">${esc(market ? sideName(market, 0) : "Side 0")}</span></div>
      <div class="book-summary">
        <div><span>Best bid</span><strong class="mono">${esc(bestBid === null ? "—" : formatNumber(bestBid))}</strong></div>
        <div><span>Best ask</span><strong class="mono">${esc(bestAsk === null ? "—" : formatNumber(bestAsk))}</strong></div>
        <div><span>Spread</span><strong class="mono ${spread !== null && spread < 0 ? "negative" : ""}">${esc(spread === null ? "—" : spread < 0 ? "Crossed" : formatNumber(spread))}</strong></div>
      </div>
      <div class="book-columns"><span>Price (USDC)</span><span>Size</span></div>
      <div class="book-levels asks">${levelRows(asks, "ask")}</div>
      <div class="book-mid"><span>${esc(state.loadingMarketData ? "Loading market…" : market ? sideName(market, 0) : "Side 0")}</span><span class="mono">${esc(`${yesQuotes.bid} / ${yesQuotes.offer}`)}</span></div>
      <div class="book-levels bids">${levelRows(bids, "bid")}</div>
      <div class="book-note">Public L2 snapshot and live side 0 updates</div>
    </section>`;
}

function renderMarketDetails(): string {
  const market = currentMarket();
  if (!market) {
    return `<section class="panel market-details"><div class="panel-heading">Market details</div><div class="empty-state">Select a market.</div></section>`;
  }
  const underlying = marketUnderlying(market);
  const inferredUnderlying = Boolean(underlying && !("underlying" in market && market.underlying));
  const details = [
    ["Market type", typeLabel(market.type)],
    ["Deployer", deployerLabel(market)],
    ["Settlement target", formatSettlementTarget(market)],
    ["Outcome ID", String(market.outcomeId)],
    ["First side", sideName(market, 0)],
    ["Second side", sideName(market, 1)],
  ];
  if (underlying) details.push(["Underlying", `${underlying}${inferredUnderlying ? " (inferred from market name)" : ""}`]);
  if ("targetPrice" in market) details.push(["Target price", formatUnderlying(market.targetPrice)]);
  if ("period" in market) details.push(["Period", market.period]);
  if ("expiry" in market) details.push(["Expiry", formatExpiry(market)]);
  if (market.type === "priceBucket") {
    const low = market.lowerBound === null ? "−∞" : formatUnderlying(market.lowerBound);
    const high = market.upperBound === null ? "+∞" : formatUnderlying(market.upperBound);
    details.push(["Bucket range", `${low} to ${high}`]);
  }
  return `
    <section class="panel market-details">
      <div class="panel-heading">Market details</div>
      <dl>${details.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>
    </section>`;
}

function renderTrades(): string {
  const rows = state.trades.slice(0, DISPLAY_TRADES);
  return `
    <section class="panel recent-trades">
      <div class="panel-heading"><span>Recent public trades</span><span class="panel-tail">${rows.length} trades · ${esc(currentMarket() ? sideName(currentMarket()!, 0) : "Side 0")}</span></div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Time</th><th>Side</th><th class="numeric">Price (USDC)</th><th class="numeric">Size</th></tr></thead>
          <tbody>${rows.length === 0
            ? `<tr><td class="empty-table" colspan="4">${state.loadingMarketData ? "Loading recent trades…" : "No recent trades for this side."}</td></tr>`
            : rows
                .map(
                  (trade) => `<tr><td class="mono">${esc(formatTime(trade.timestamp))}</td><td class="${trade.side === "buy" ? "positive" : "negative"}">${trade.side.toUpperCase()}</td><td class="numeric mono">${esc(formatNumber(trade.price, 3))}</td><td class="numeric mono">${esc(formatNumber(trade.size, 2))}</td></tr>`,
                )
                .join("")}</tbody>
        </table>
      </div>
    </section>`;
}

function renderApp(): void {
  const market = currentMarket();
  appRoot!.innerHTML = `
    <header class="toolbar">
      <label class="toolbar-label" for="selected-market">Market</label>
      <select id="selected-market" aria-label="Selected market" ${state.markets.length === 0 ? "disabled" : ""}>
        ${state.markets.map((entry) => `<option value="${esc(marketId(entry))}" ${market && marketId(entry) === marketId(market) ? "selected" : ""}>${esc(marketTitle(entry))}</option>`).join("")}
      </select>
    </header>
    ${state.error ? `<div class="error-banner" role="alert">${esc(state.error)}</div>` : ""}
    <main class="workspace">
      <div class="left-column">${renderMarketWatch()}${renderTrades()}</div>
      <div class="center-column">${renderSelectedContext()}${renderCharts()}</div>
      <div class="right-column">${renderBook()}${renderMarketDetails()}</div>
    </main>`;
  bindSearchAndFilter();
}

function refreshMarketRows(resetScroll = false): void {
  const list = document.querySelector<HTMLDivElement>("#market-list");
  if (list) {
    const scrollTop = list.scrollTop;
    list.innerHTML = renderMarketRows();
    list.scrollTop = resetScroll ? 0 : scrollTop;
  }
  document.querySelectorAll<HTMLElement>("[data-market-price]").forEach((node) => {
    const id = node.dataset.marketPrice;
    const market = state.markets.find((entry) => marketId(entry) === id);
    if (market) node.textContent = marketSummary(market);
  });
  const count = document.querySelector<HTMLElement>(".panel-count");
  if (count) count.textContent = `${filteredMarkets().length} / ${state.markets.length}`;
  const footer = document.querySelector<HTMLElement>(".watch-footer span");
  if (footer) footer.textContent = state.loadingMarkets ? "Loading markets…" : `${state.markets.length} markets available`;
}

function refreshSelectedContext(): void {
  const existing = document.querySelector(".market-context");
  if (existing) existing.outerHTML = renderSelectedContext();
}

function refreshCharts(): void {
  const market = currentMarket();
  const id = market ? marketId(market) : null;
  const charts = document.querySelector<HTMLElement>(".charts-column");
  if (charts) {
    const underlying = market ? marketUnderlying(market) : null;
    const title = underlying
      ? `${underlying} underlying`
      : "Underlying reference";
    charts.innerHTML = `${renderChartPanel(title, id, state.underlyingCandles, "underlying", state.underlyingPrice)}${renderChartPanel("Outcome trade price", id, [], "contract", null)}`;
  }
}

function refreshBook(): void {
  const book = document.querySelector<HTMLElement>(".book-panel");
  if (book) book.outerHTML = renderBook();
}

function refreshTrades(): void {
  const trades = document.querySelector<HTMLElement>(".recent-trades");
  if (trades) trades.outerHTML = renderTrades();
}

function refreshMarketTiming(): void {
  const clock = document.querySelector<HTMLElement>("#utc-clock");
  if (clock) clock.textContent = formatUtcClock();
  const settlement = document.querySelector<HTMLElement>("#settlement-clock");
  const market = currentMarket();
  if (settlement && market) settlement.textContent = settlementClockText(market);
}

function bindSearchAndFilter(): void {
  const search = document.querySelector<HTMLInputElement>("#market-search");
  search?.addEventListener("input", () => {
    state.search = search.value;
    refreshMarketRows(true);
  });
  const kind = document.querySelector<HTMLSelectElement>("#market-type");
  kind?.addEventListener("change", () => {
    state.kindFilter = kind.value as MarketKind;
    refreshMarketRows(true);
  });
  const deployer = document.querySelector<HTMLSelectElement>("#market-deployer");
  deployer?.addEventListener("change", () => {
    state.deployerFilter = deployer.value;
    refreshMarketRows(true);
  });
  const settlement = document.querySelector<HTMLSelectElement>("#market-settlement");
  settlement?.addEventListener("change", () => {
    state.settlementFilter = settlement.value as SettlementFilter;
    refreshMarketRows(true);
  });
}

function updateURL(market: HIP4Market): void {
  const url = new URL(location.href);
  url.searchParams.set("market", String(market.outcomeId));
  history.replaceState(null, "", url);
}

function stopSelectedFeeds(): void {
  for (const unsubscribe of selectedUnsubscribers) unsubscribe();
  selectedUnsubscribers = [];
}

function rememberFreshData(): void {
  state.lastUpdateAt = Date.now();
  refreshMarketTiming();
}

function updateAllMids(payload: unknown): void {
  const mids = (payload as { mids?: Record<string, string> })?.mids;
  if (!mids) return;
  state.pricesByCoin = mids;
  const market = currentMarket();
  if (market && state.underlyingInterval === "15s") {
    const underlying = marketUnderlying(market);
    const mid = underlying ? Number(mids[underlying]) : Number.NaN;
    if (Number.isFinite(mid) && mid > 0) {
      state.underlyingPrice = mid;
      refreshCharts();
    }
  }
  rememberFreshData();
  refreshMarketRows();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadSelectedMarket(): Promise<void> {
  const adapter = state.adapter;
  const market = currentMarket();
  if (!adapter || !market) return;

  const loadId = ++selectedMarketLoad;
  stopSelectedFeeds();
  state.loadingMarketData = true;
  state.selectedBook = null;
  state.secondaryBook = null;
  state.trades = [];
  state.outcomeChartTrades = [];
  state.underlyingCandles = [];
  state.underlyingPrice = null;
  state.seenOutcomeTradeIds = new Set();
  state.seenUnderlyingTradeIds = new Set();
  state.error = null;
  updateURL(market);
  renderApp();

  const id = marketId(market);
  const underlying = marketUnderlying(market);
  const sideOneCoin = market.sides[1]?.coin;
  const useUnderlyingTradeCandles = state.underlyingInterval === "15s";
  const results = await Promise.allSettled([
    adapter.marketData.fetchOrderBook(id, 0),
    adapter.marketData.fetchTrades(id, CHART_TRADE_BACKFILL_LIMIT),
    adapter.marketData.fetchOrderBook(id, 1),
    useUnderlyingTradeCandles && underlying ? adapter.client.fetchRecentTrades(underlying) : Promise.resolve([] as PerpTrade[]),
  ]);
  if (loadId !== selectedMarketLoad) return;

  const errors: string[] = [];
  const [bookResult, tradesResult, secondaryBookResult, underlyingTradesResult] = results;
  if (bookResult.status === "fulfilled") {
    state.selectedBook = bookResult.value as OrderBook;
  } else {
    errors.push(`Yes order book: ${errorMessage(bookResult.reason)}`);
  }
  if (tradesResult.status === "fulfilled") {
    const recentTrades = tradesResult.value as Trade[];
    state.trades = recentTrades.slice(0, DISPLAY_TRADES);
    state.outcomeChartTrades = [...recentTrades]
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-CHART_TRADE_BACKFILL_LIMIT);
    state.seenOutcomeTradeIds = new Set(recentTrades.map((trade) => trade.id));
  } else {
    errors.push(`outcome trade history: ${errorMessage(tradesResult.reason)}`);
  }
  if (secondaryBookResult.status === "fulfilled") {
    state.secondaryBook = secondaryBookResult.value as OrderBook;
  } else {
    errors.push(`No order book: ${errorMessage(secondaryBookResult.reason)}`);
  }
  if (useUnderlyingTradeCandles && underlying) {
    if (underlyingTradesResult.status === "fulfilled") {
      const recentUnderlyingTrades = underlyingTradesResult.value as PerpTrade[];
      state.seenUnderlyingTradeIds = new Set(
        recentUnderlyingTrades.map((trade) => `${trade.coin}:${trade.hash}:${trade.tid}:${trade.time}`),
      );
      state.underlyingCandles = ticksToCandles(recentUnderlyingTrades.map(underlyingTick), state.underlyingInterval);
      const latest = recentUnderlyingTrades.reduce<PerpTrade | null>(
        (current, trade) => !current || trade.time > current.time ? trade : current,
        null,
      );
      const rawMid = state.pricesByCoin[underlying];
      state.underlyingPrice = rawMid === undefined ? (latest ? Number(latest.px) : null) : Number(rawMid);
    } else {
      errors.push(`underlying trade backfill: ${errorMessage(underlyingTradesResult.reason)}`);
    }
  }
  if (errors.length > 0) state.error = `Some market data did not load (${errors.join("; ")}).`;

  state.loadingMarketData = false;
  state.lastUpdateAt = Date.now();

  selectedUnsubscribers.push(
    adapter.marketData.subscribeOrderBook(id, (book) => {
      if (loadId !== selectedMarketLoad) return;
      state.selectedBook = book as OrderBook;
      rememberFreshData();
      refreshBook();
      refreshSelectedContext();
    }),
  );
  if (sideOneCoin) {
    selectedUnsubscribers.push(
      adapter.client.subscribe({ type: "l2Book", coin: sideOneCoin }, (snapshot) => {
        if (loadId !== selectedMarketLoad) return;
        const book = mapRawBook(snapshot, id, sideOneCoin);
        if (!book) return;
        state.secondaryBook = book;
        refreshSelectedContext();
      }),
    );
  }
  selectedUnsubscribers.push(
    adapter.marketData.subscribeTrades(id, (trade) => {
      if (loadId !== selectedMarketLoad) return;
      const next = trade as Trade;
      if (state.seenOutcomeTradeIds.has(next.id)) return;
      state.seenOutcomeTradeIds.add(next.id);
      state.trades = [next, ...state.trades].slice(0, DISPLAY_TRADES);
      state.outcomeChartTrades = [...state.outcomeChartTrades, next]
        .sort((left, right) => left.timestamp - right.timestamp)
        .slice(-CHART_TRADE_BACKFILL_LIMIT * 2);
      rememberFreshData();
      refreshTrades();
      refreshCharts();
    }),
  );

  if (underlying && useUnderlyingTradeCandles) {
    selectedUnsubscribers.push(
      adapter.client.subscribe({ type: "trades", coin: underlying }, (data) => {
        if (loadId !== selectedMarketLoad || !Array.isArray(data)) return;
        let changed = false;
        for (const trade of data as PerpTrade[]) {
          const key = `${trade.coin}:${trade.hash}:${trade.tid}:${trade.time}`;
          if (state.seenUnderlyingTradeIds.has(key)) continue;
          state.seenUnderlyingTradeIds.add(key);
          const tick = underlyingTick(trade);
          state.underlyingCandles = addTradeToCandles(state.underlyingCandles, tick, state.underlyingInterval);
          state.underlyingPrice = tick.price;
          changed = true;
        }
        if (changed) {
          rememberFreshData();
          refreshCharts();
        }
      }),
    );
    selectedUnsubscribers.push(
      adapter.marketData.subscribePerpAssetCtx(underlying, (data) => {
        if (loadId !== selectedMarketLoad) return;
        const mark = Number(data.ctx.markPx);
        if (!Number.isFinite(mark) || mark <= 0) return;
        state.underlyingPrice = mark;
        refreshCharts();
      }),
    );
  } else if (underlying) {
    try {
      selectedUnsubscribers.push(
        createPerpPriceFeed(adapter.client, underlying, (snapshot) => {
          if (loadId !== selectedMarketLoad) return;
          state.underlyingCandles = snapshot.candles as Candle[];
          state.underlyingPrice = snapshot.currentMid;
          rememberFreshData();
          refreshCharts();
        }, { interval: state.underlyingInterval }),
      );
    } catch (error) {
      errors.push(`underlying chart: ${errorMessage(error)}`);
    }
  }

  if (errors.length > 0) state.error = `Some market data did not load (${errors.join("; ")}).`;
  renderApp();
}

async function start(): Promise<void> {
  renderApp();
  try {
    const adapter = createHIP4Adapter({ testnet: false });
    state.adapter = adapter;
    await adapter.initialize();
    state.connection = "ready";
    const [result, outcomeMeta] = await Promise.all([
      adapter.events.fetchMarkets({ sortBy: "volume" }),
      adapter.client.fetchOutcomeMeta().catch(() => null),
    ]);
    state.markets = result as HIP4Market[];
    state.deployerAddressesByVenue = Object.fromEntries(
      (outcomeMeta?.deployers ?? []).map((deployer) => [
        deployer.venue.toLocaleLowerCase(),
        deployer.deployer.toLocaleLowerCase(),
      ]),
    );
    if (state.selectedMarketId && !state.markets.some((market) => marketId(market) === state.selectedMarketId)) {
      state.selectedMarketId = null;
    }
    if (!state.selectedMarketId) state.selectedMarketId = state.markets[0] ? marketId(state.markets[0]) : null;
    state.loadingMarkets = false;

    unsubscribeAllMids = adapter.marketData.subscribeAllMids(updateAllMids);
    renderApp();
    if (currentMarket()) await loadSelectedMarket();
    else refreshMarketTiming();
  } catch (error) {
    state.loadingMarkets = false;
    state.connection = "error";
    state.error = `Could not connect to Outcome market data: ${errorMessage(error)}`;
    renderApp();
  }
}

function applyChartAction(kind: "underlying" | "contract", action: string): void {
  if (kind === "underlying") {
    const visibleCount = visibleUnderlyingCandleCount();
    if (action === "zoom-in") state.underlyingZoom = Math.min(MAX_CHART_ZOOM, state.underlyingZoom + 1);
    if (action === "zoom-out") state.underlyingZoom = Math.max(0, state.underlyingZoom - 1);
    if (action === "older") state.underlyingOffset += Math.max(1, Math.round(visibleCount / 2));
    if (action === "newer") state.underlyingOffset -= Math.max(1, Math.round(visibleCount / 2));
    if (action === "reset") {
      state.underlyingZoom = 0;
      state.underlyingOffset = 0;
    }
    state.underlyingOffset = Math.max(0, Math.min(state.underlyingOffset, maximumUnderlyingOffset()));
  } else {
    const range = outcomeChartRange(state.outcomeWindow, state.outcomeZoom, state.outcomeOffsetMs);
    if (action === "zoom-in") state.outcomeZoom = Math.min(MAX_CHART_ZOOM, state.outcomeZoom + 1);
    if (action === "zoom-out") state.outcomeZoom = Math.max(0, state.outcomeZoom - 1);
    if (action === "older") state.outcomeOffsetMs += Math.max(1_000, range.duration / 2);
    if (action === "newer") state.outcomeOffsetMs -= Math.max(1_000, range.duration / 2);
    if (action === "reset") {
      state.outcomeZoom = 0;
      state.outcomeOffsetMs = 0;
    }
    state.outcomeOffsetMs = Math.max(
      0,
      Math.min(state.outcomeOffsetMs, outcomeChartRange(state.outcomeWindow, state.outcomeZoom, state.outcomeOffsetMs).maxOffsetMs),
    );
  }
  refreshCharts();
}

document.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  const surface = event.target.closest<HTMLElement>(".chart-surface[data-chart-kind]");
  const kind = surface?.dataset.chartKind;
  if (!surface || (kind !== "underlying" && kind !== "contract")) return;
  chartDrag = { kind, lastX: event.clientX };
  surface.classList.add("is-panning");
});

document.addEventListener("pointermove", (event) => {
  if (!chartDrag) return;
  if ((event.buttons & 1) === 0) {
    chartDrag = null;
    refreshCharts();
    return;
  }
  const drag = chartDrag;
  const deltaX = event.clientX - drag.lastX;
  drag.lastX = event.clientX;
  if (deltaX === 0) return;
  const surface = document.querySelector<HTMLElement>(`.chart-surface[data-chart-kind="${drag.kind}"]`);
  const width = surface?.clientWidth ?? 760;
  if (drag.kind === "underlying") {
    state.underlyingOffset += (deltaX / Math.max(width, 1)) * visibleUnderlyingCandleCount();
    state.underlyingOffset = Math.max(0, Math.min(state.underlyingOffset, maximumUnderlyingOffset()));
  } else {
    const range = outcomeChartRange(state.outcomeWindow, state.outcomeZoom, state.outcomeOffsetMs);
    state.outcomeOffsetMs += (deltaX / Math.max(width, 1)) * range.duration;
    state.outcomeOffsetMs = Math.max(
      0,
      Math.min(state.outcomeOffsetMs, outcomeChartRange(state.outcomeWindow, state.outcomeZoom, state.outcomeOffsetMs).maxOffsetMs),
    );
  }
  refreshCharts();
});

const endChartDrag = () => {
  if (!chartDrag) return;
  chartDrag = null;
  refreshCharts();
};
document.addEventListener("pointerup", endChartDrag);
document.addEventListener("pointercancel", endChartDrag);

document.addEventListener("wheel", (event) => {
  if (!(event.target instanceof Element)) return;
  const surface = event.target.closest<HTMLElement>(".chart-surface[data-chart-kind]");
  const kind = surface?.dataset.chartKind;
  if (kind !== "underlying" && kind !== "contract") return;
  event.preventDefault();
  applyChartAction(kind, event.deltaY < 0 ? "zoom-in" : "zoom-out");
}, { passive: false });

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element
    ? event.target.closest<HTMLElement>("[data-market-id], [data-interval], [data-chart-action]")
    : null;
  if (!target) return;
  const id = target.dataset.marketId;
  if (id) {
    const market = state.markets.find((entry) => marketId(entry) === id);
    if (market && marketId(market) !== state.selectedMarketId) {
      state.selectedMarketId = id;
      state.underlyingZoom = 0;
      state.underlyingOffset = 0;
      state.outcomeZoom = 0;
      state.outcomeOffsetMs = 0;
      void loadSelectedMarket();
    }
    return;
  }
  if (target.dataset.chartAction) {
    const kind = target.dataset.chartKind;
    if (kind === "underlying" || kind === "contract") applyChartAction(kind, target.dataset.chartAction);
    return;
  }
  if (target.dataset.interval) {
    const interval = target.dataset.interval as Interval;
    const chartKind = target.dataset.chartKind;
    if (chartKind === "underlying" && INTERVALS.includes(interval) && state.underlyingInterval !== interval) {
      state.underlyingInterval = interval;
      state.underlyingZoom = 0;
      state.underlyingOffset = 0;
      if (currentMarket()) void loadSelectedMarket();
      else renderApp();
    } else if (chartKind === "contract" && OUTCOME_WINDOWS.includes(interval as OutcomeWindow) && state.outcomeWindow !== interval) {
      state.outcomeWindow = interval as OutcomeWindow;
      state.outcomeZoom = 0;
      state.outcomeOffsetMs = 0;
      refreshCharts();
    }
    return;
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  if (target.id === "selected-market") {
    state.selectedMarketId = target.value;
    const market = currentMarket();
    if (market) void loadSelectedMarket();
  }
});

window.addEventListener("beforeunload", () => {
  stopSelectedFeeds();
  unsubscribeAllMids?.();
  state.adapter?.destroy();
});

window.setInterval(refreshMarketTiming, 1000);
window.setInterval(() => refreshMarketRows(), 30_000);
void start();
