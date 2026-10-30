import {
  BASE_TAKER_RATE,
  MIN_NOTIONAL,
  computeTickSize,
  createHIP4Adapter,
  createPerpPriceFeed,
  feeAmounts,
  formatOutcomePrice,
  getMinShares,
  readDeployedOutcome,
  roundToTick,
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
type SettlementFilter = "all" | "under15m" | "15mTo1h" | "1hTo24h" | "over24h" | "past" | "unknown";
type TicketAction = "buy" | "sell";
type TicketTif = "Gtc" | "Ioc";
type TerminalTab = "tape" | "positions" | "orders" | "fills" | "activity" | "balances";
type ActivityTone = "info" | "ok" | "warn" | "error";
type ActivityEntry = { time: number; detail: string; tone: ActivityTone };
type PaneName = "watch" | "dock" | "terminal";

const DISPLAY_LEVELS = 8;
const DISPLAY_TRADES = 40;
const CHART_TRADE_BACKFILL_LIMIT = 1000;
const PROTOCOL_DEPLOYER = "__protocol__";
const INTERVALS: Interval[] = ["15s", "1m", "5m", "15m", "1h", "4h", "1d"];
const INTERVAL_MS: Record<Interval, number> = {
  "15s": 15_000,
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};
const LAYOUT_KEY = "outcome-desk-layout";
const CHART_LEFT = 8;
const CHART_RIGHT = 62;
const CHART_TOP = 8;
const CHART_AXIS = 16;
const VOLUME_H = 32;
const VOLUME_GAP = 6;
const TERMINAL_TABS: Array<{ id: TerminalTab; label: string }> = [
  { id: "tape", label: "Public trades" },
  { id: "positions", label: "Positions" },
  { id: "orders", label: "Open orders" },
  { id: "fills", label: "Fills" },
  { id: "activity", label: "Activity" },
  { id: "balances", label: "Balances" },
];
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

function loadLayout(): { layout: { watch: number; dock: number; terminal: number }; panes: Record<PaneName, boolean> } {
  const fallback = {
    layout: { watch: 292, dock: 308, terminal: 160 },
    panes: { watch: true, dock: true, terminal: true } as Record<PaneName, boolean>,
  };
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as {
      layout?: { watch?: number; dock?: number; terminal?: number };
      panes?: Partial<Record<PaneName, boolean>>;
    };
    const numberIn = (value: unknown, min: number, max: number, fallbackNumber: number) => {
      const parsedNumber = Number(value);
      return Number.isFinite(parsedNumber) ? Math.min(max, Math.max(min, parsedNumber)) : fallbackNumber;
    };
    return {
      layout: {
        watch: numberIn(parsed.layout?.watch, 200, 520, fallback.layout.watch),
        dock: numberIn(parsed.layout?.dock, 250, 520, fallback.layout.dock),
        terminal: numberIn(parsed.layout?.terminal, 110, 420, fallback.layout.terminal),
      },
      panes: {
        watch: parsed.panes?.watch !== false,
        dock: parsed.panes?.dock !== false,
        terminal: parsed.panes?.terminal !== false,
      },
    };
  } catch {
    return fallback;
  }
}

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) throw new Error("App root element was not found.");

const requestedMarket = new URLSearchParams(location.search).get("market");
const initialLayout = loadLayout();

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
  underlyingZoom: number;
  underlyingOffset: number;
  bookSide: 0 | 1;
  ticketAction: TicketAction;
  ticketPrice: string;
  ticketQty: string;
  ticketTif: TicketTif;
  ticketPriceTouched: boolean;
  terminalTab: TerminalTab;
  activity: ActivityEntry[];
  layout: { watch: number; dock: number; terminal: number };
  panes: Record<PaneName, boolean>;
  statusNote: string;
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
  underlyingZoom: 0,
  underlyingOffset: 0,
  bookSide: 0,
  ticketAction: "buy",
  ticketPrice: "",
  ticketQty: "100",
  ticketTif: "Gtc",
  ticketPriceTouched: false,
  terminalTab: "tape",
  activity: [],
  layout: initialLayout.layout,
  panes: initialLayout.panes,
  statusNote: "",
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
let resizeDrag: { edge: PaneName; start: number; origin: number } | null = null;
let lastPointer: { x: number; y: number } | null = null;
let measureQueued = false;
let activeMarketId: string | null = null;
const chartPixels: Record<"underlying" | "contract", { width: number; height: number }> = {
  underlying: { width: 720, height: 210 },
  contract: { width: 720, height: 210 },
};
const chartObserver = new ResizeObserver(() => requestChartMeasure());

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

function formatSettlementStamp(market: HIP4Market): string {
  const target = settlementTarget(market);
  if (!target) return "No settlement time";
  const date = new Intl.DateTimeFormat("en-GB", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(target.timestamp);
  return `${target.label}: ${date} UTC`;
}

function formatSettlementTarget(market: HIP4Market): string {
  const target = settlementTarget(market);
  if (!target) return "No settlement time";
  const remaining = target.timestamp - Date.now();
  const relative = remaining <= 0 ? "target passed" : `in ${formatDuration(remaining)}`;
  return `${formatSettlementStamp(market)} · ${relative}`;
}

function formatSettlementCompact(market: HIP4Market): string {
  const target = settlementTarget(market);
  if (!target) return "No settlement time";
  const date = new Intl.DateTimeFormat("en-GB", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(target.timestamp);
  const remaining = target.timestamp - Date.now();
  const relative = remaining <= 0 ? "passed" : formatDuration(remaining);
  return `${date} UTC · ${relative}`;
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

function bestBidOffer(book: OrderBook | null): { bid: string; offer: string } {
  const bids = book ? sortBookLevels(book.bids, "desc") : [];
  const offers = book ? sortBookLevels(book.asks, "asc") : [];
  const price = (raw: string | undefined) => (raw === undefined ? "—" : formatBookPrice(raw));
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
        <button class="market-row ${selected ? "selected" : ""}" data-market-id="${esc(id)}" aria-pressed="${selected}" title="${esc(marketTitle(market))}">
          <span class="market-row-title">${esc(marketTitle(market))}</span>
          <span class="market-row-price mono" data-market-price="${esc(id)}">${esc(marketSummary(market))}</span>
          <span class="market-row-meta" title="${esc(`${typeLabel(market.type)} · #${id} · ${formatSettlementTarget(market)}`)}"><span class="meta-when">${esc(formatSettlementCompact(market))}</span><span class="meta-id">${esc(typeLabel(market.type))} · #${esc(id)}</span></span>
        </button>`;
    })
    .join("");
}

function renderMarketWatch(): string {
  const visibleCount = filteredMarkets().length;
  const deployers = deployerFilterOptions();
  return `
    <section class="panel market-watch watch-panel" aria-label="Outcome market watch">
      <div class="panel-heading"><span>Market watch</span><span class="panel-count" id="watch-count">${visibleCount} / ${state.markets.length}</span></div>
      <div class="watch-controls">
        <label class="sr-only" for="market-search">Search markets</label>
        <div class="search-wrap">${icon("search")}<input id="market-search" type="search" placeholder="Search markets or deployers" value="${esc(state.search)}" autocomplete="off" /></div>
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
        <span>${esc(watchFooterText())}</span>
      </div>
    </section>`;
}

function requestChartMeasure(): void {
  if (measureQueued) return;
  measureQueued = true;
  requestAnimationFrame(() => {
    measureQueued = false;
    if (measureCharts()) refreshCharts();
  });
}

function measureCharts(): boolean {
  const underlying = document.querySelector<HTMLElement>("#underlying-chart");
  const contract = document.querySelector<HTMLElement>("#contract-chart");
  if (!underlying || !contract) return false;
  const width = Math.round(Math.max(underlying.clientWidth, contract.clientWidth));
  const next = {
    underlying: { width, height: Math.round(underlying.clientHeight) },
    contract: { width, height: Math.round(contract.clientHeight) },
  };
  const viewportCap = Math.round(window.innerHeight);
  if (
    next.underlying.width < 80
    || next.underlying.height < 60
    || next.contract.height < 60
    || next.underlying.height > viewportCap
    || next.contract.height > viewportCap
  ) return false;
  const changed = chartPixels.underlying.width !== next.underlying.width
    || chartPixels.underlying.height !== next.underlying.height
    || chartPixels.contract.width !== next.contract.width
    || chartPixels.contract.height !== next.contract.height;
  chartPixels.underlying = next.underlying;
  chartPixels.contract = next.contract;
  return changed;
}

function observeCharts(): void {
  const column = document.querySelector(".charts-column");
  if (column) chartObserver.observe(column);
}

function saveLayout(): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ layout: state.layout, panes: state.panes }));
  } catch {
    // The terminal still works when storage is blocked.
  }
}

function applyLayout(): void {
  const grid = document.querySelector<HTMLElement>("#workspace");
  if (!grid) return;
  const watchTrack = state.panes.watch ? `${Math.round(state.layout.watch)}px 5px` : "0px 0px";
  const dockTrack = state.panes.dock ? `5px ${Math.round(state.layout.dock)}px` : "0px 0px";
  const termTrack = state.panes.terminal ? `5px ${Math.round(state.layout.terminal)}px` : "0px 0px";
  grid.style.gridTemplateColumns = `${watchTrack} minmax(0, 1fr) ${dockTrack}`;
  grid.style.gridTemplateRows = `minmax(0, 1fr) ${termTrack} 22px`;
  const hide = (selector: string, hidden: boolean) => {
    grid.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      element.hidden = hidden;
    });
  };
  hide(".watch-panel, .split-watch", !state.panes.watch);
  hide(".right-column, .split-dock", !state.panes.dock);
  hide(".terminal, .split-term", !state.panes.terminal);
}

function syncPaneChecks(): void {
  document.querySelectorAll<HTMLElement>("[data-pane]").forEach((item) => {
    const pane = item.dataset.pane;
    if (pane !== "watch" && pane !== "dock" && pane !== "terminal") return;
    const on = state.panes[pane];
    item.setAttribute("aria-checked", String(on));
    const mark = item.querySelector(".check");
    if (mark) mark.textContent = on ? "✓" : "";
  });
}

function setStatusNote(text: string): void {
  state.statusNote = text;
  const note = document.querySelector("#status-note");
  if (note) note.textContent = text;
}

function pushActivity(detail: string, tone: ActivityTone = "info"): void {
  state.activity = [{ time: Date.now(), detail, tone }, ...state.activity].slice(0, 40);
  if (state.terminalTab === "activity") refreshTerminal();
}

function syncTitle(): void {
  const market = currentMarket();
  document.title = market
    ? `Outcome Desk — ${marketTitle(market)} · ${state.underlyingInterval}`
    : "Outcome Desk";
}

type SharedView = {
  startMs: number;
  endMs: number;
  durationMs: number;
  maxOffset: number;
  offset: number;
};

function sharedView(): SharedView {
  const intervalMs = INTERVAL_MS[state.underlyingInterval];
  const durationMs = visibleUnderlyingCandleCount() * intervalMs;
  const now = Date.now();
  let oldestMs = now;
  for (const candle of state.underlyingCandles) oldestMs = Math.min(oldestMs, candle.time * 1000);
  if (state.outcomeChartTrades.length > 0) {
    oldestMs = Math.min(oldestMs, state.outcomeChartTrades[0].timestamp);
  }
  const maxOffset = oldestMs < now ? Math.max(0, (now - oldestMs - durationMs) / intervalMs) : 0;
  const offset = Math.max(0, Math.min(state.underlyingOffset, maxOffset));
  const endMs = now - offset * intervalMs;
  return { startMs: endMs - durationMs, endMs, durationMs, maxOffset, offset };
}

function formatUsdc(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
}

function formatBookPrice(raw: string | number | null | undefined): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(5);
}

function tifLabel(value: string): string {
  if (value === "Ioc") return "IOC";
  return "GTC";
}

function watchFooterText(): string {
  if (state.loadingMarkets) return "Loading markets…";
  const visible = filteredMarkets().length;
  if (visible === state.markets.length) return `${state.markets.length} markets available`;
  return `${visible} shown · ${state.markets.length} markets available`;
}

function formatContractPrice(raw: string | number | null | undefined): string {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return "—";
  try {
    return formatOutcomePrice(value);
  } catch {
    return value.toFixed(3);
  }
}

function normalizeContractPrice(raw: string | number): string | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) return null;
  try {
    return formatOutcomePrice(roundToTick(value));
  } catch {
    return formatContractPrice(value);
  }
}

function formatProbability(price: number | null): string {
  if (price === null || !Number.isFinite(price)) return "Probability";
  return `${(price * 100).toFixed(1)}%`;
}

function formatAxisTime(timestamp: number, durationMs: number): string {
  const options: Intl.DateTimeFormatOptions = durationMs <= 6 * 60 * 60_000
    ? { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }
    : durationMs <= 3 * 24 * 60 * 60_000
      ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }
      : { day: "2-digit", month: "short", timeZone: "UTC" };
  return new Intl.DateTimeFormat("en-GB", options).format(timestamp);
}

function formatAxisPrice(value: number, kind: "underlying" | "contract"): string {
  if (!Number.isFinite(value)) return "—";
  if (kind === "contract") return value.toFixed(3);
  if (Math.abs(value) >= 100) return `$${Math.round(value).toLocaleString("en-US")}`;
  return formatUnderlying(value);
}

function isMachineDescription(description: string): boolean {
  if (!description) return true;
  if (/^class:/i.test(description)) return true;
  const parts = description.split("|").map((part) => part.trim()).filter(Boolean);
  const keyed = parts.filter((part) => /^[A-Za-z][A-Za-z0-9]*:/.test(part));
  return parts.length >= 2 && keyed.length >= 2;
}

function specSentence(description: string): string {
  const bits: string[] = [];
  for (const part of description.split("|")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9]*):(.*)$/);
    if (!match) {
      bits.push(trimmed);
      continue;
    }
    const value = match[2].trim();
    if (match[1] === "officialSource" && value) {
      bits.push(`Source: ${value}`);
      continue;
    }
    if (value.length >= 20 && /\s/.test(value)) bits.push(value);
  }
  return bits.join(". ");
}

function encodedPriceSource(description: string): string | null {
  const match = description.match(/(?:^|\|)priceDescription:([^|]+)/i);
  const source = match?.[1]?.trim();
  return source || null;
}

function settlementRule(market: HIP4Market): string {
  const description = market.description?.trim() ?? "";
  if (description && !isMachineDescription(description)) return description;
  const when = formatSettlementStamp(market);
  const underlying = marketUnderlying(market);
  const source = encodedPriceSource(description);
  if ("targetPrice" in market && underlying) {
    const subject = source ?? underlying;
    return `${subject} versus ${formatUnderlying(market.targetPrice)}. ${when}.`;
  }
  if (market.type === "priceBucket") {
    const low = market.lowerBound === null ? "−∞" : formatUnderlying(market.lowerBound);
    const high = market.upperBound === null ? "+∞" : formatUnderlying(market.upperBound);
    return `${source ?? underlying ?? "Price"} from ${low} to ${high}. ${when}.`;
  }
  const strikes = marketStrikeLines(market);
  if (strikes.length > 0) {
    const subject = source ?? underlying ?? "Price";
    const levels = strikes.map((line) => formatUnderlying(line.price)).join(" and ");
    return `${subject} versus ${levels}. ${when}.`;
  }
  const prose = specSentence(description);
  if (prose) return `${prose}. ${when}.`;
  return when;
}

function activeBook(): OrderBook | null {
  return state.bookSide === 0 ? state.selectedBook : state.secondaryBook;
}

function bestRaw(side: "bid" | "ask"): number | null {
  const book = activeBook();
  if (!book) return null;
  const levels = sortBookLevels(side === "bid" ? book.bids : book.asks, side === "bid" ? "desc" : "asc");
  const price = Number(levels[0]?.price);
  return Number.isFinite(price) && price > 0 && price < 1 ? price : null;
}

function seedTicketPrice(): void {
  if (state.ticketPrice) return;
  const raw = state.ticketAction === "buy" ? bestRaw("ask") : bestRaw("bid");
  if (raw === null) return;
  const normalized = normalizeContractPrice(raw);
  if (normalized) state.ticketPrice = normalized;
}

type TicketNumbers = {
  priceOk: boolean;
  qtyOk: boolean;
  price: number;
  qty: number;
  traded: number;
  fee: number;
  maxLoss: number;
  settlement: number;
  minShares: number | null;
  blocking: string;
  advisory: string;
};

function ticketNumbers(): TicketNumbers {
  const price = Number(state.ticketPrice);
  const qty = Number(state.ticketQty);
  const priceOk = Number.isFinite(price) && price > 0 && price < 1;
  const qtyOk = Number.isFinite(qty) && qty > 0;
  const traded = priceOk && qtyOk ? price * qty : Number.NaN;
  const fee = Number.isFinite(traded) ? feeAmounts(0, traded).trader : Number.NaN;
  const maxLoss = priceOk && qtyOk && Number.isFinite(fee)
    ? state.ticketAction === "buy" ? traded + fee : (1 - price) * qty + fee
    : Number.NaN;
  const settlement = qtyOk ? (state.ticketAction === "buy" ? qty : 0) : Number.NaN;
  let minShares: number | null = null;
  if (priceOk) {
    try {
      minShares = getMinShares(price, MIN_NOTIONAL);
    } catch {
      minShares = null;
    }
  }
  const blocking = !priceOk
    ? "Enter a limit price between 0 and 1."
    : !qtyOk
      ? "Enter a quantity greater than zero."
      : "";
  const advisory = priceOk && qtyOk && minShares !== null && qty + 1e-9 < minShares
    ? `Under the ${MIN_NOTIONAL} USDC minimum (${minShares} shares). This preview is not sent.`
    : "";
  return { priceOk, qtyOk, price, qty, traded, fee, maxLoss, settlement, minShares, blocking, advisory };
}

function formatTick(tick: number): string {
  if (!Number.isFinite(tick) || tick <= 0) return "—";
  const decimals = Math.min(8, Math.max(0, -Math.floor(Math.log10(tick))));
  return tick.toFixed(decimals);
}

function tickHint(): string {
  const price = Number(state.ticketPrice);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return "Limit price";
  try {
    return `Limit · tick ${formatTick(computeTickSize(price))}`;
  } catch {
    return "Limit price";
  }
}

function previewText(): string {
  const market = currentMarket();
  const side = market ? sideName(market, state.bookSide) : "Side";
  const quote = ticketNumbers();
  if (!quote.priceOk || !quote.qtyOk) return `${state.ticketAction.toUpperCase()} ${side} · preview only`;
  return `${state.ticketAction.toUpperCase()} ${side} · ${quote.qty} @ ${state.ticketPrice} · preview only`;
}

function updateTicketEstimates(): void {
  const quote = ticketNumbers();
  const setText = (id: string, value: string) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };
  setText("est-cost-label", state.ticketAction === "buy" ? "Estimated cost" : "Estimated proceeds");
  setText("est-cost", quote.priceOk && quote.qtyOk ? formatUsdc(quote.traded) : "—");
  setText("est-loss", Number.isFinite(quote.maxLoss) ? formatUsdc(quote.maxLoss) : "—");
  setText("est-settle", quote.qtyOk ? formatUsdc(quote.settlement) : "—");
  setText("est-fee", Number.isFinite(quote.fee) ? formatUsdc(quote.fee) : "—");
  setText("est-min", quote.minShares === null ? "—" : `${quote.minShares} shares`);
  setText("ticket-price-label", tickHint());
  const warning = document.getElementById("ticket-warning");
  if (warning) warning.textContent = quote.advisory;
  const review = document.getElementById("review-order");
  if (review instanceof HTMLButtonElement) {
    review.disabled = !(quote.priceOk && quote.qtyOk);
    review.textContent = quote.priceOk && quote.qtyOk ? "Review order" : "Enter price and size";
  }
  const preview = document.getElementById("status-preview");
  if (preview) preview.textContent = previewText();
}

function refreshTicketButtons(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-ticket-side]").forEach((button) => {
    const on = Number(button.dataset.ticketSide) === state.bookSide;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", String(on));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-ticket-action]").forEach((button) => {
    const on = button.dataset.ticketAction === state.ticketAction;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", String(on));
  });
}

function setBookSide(index: 0 | 1): void {
  if (state.bookSide === index) return;
  state.bookSide = index;
  if (!state.ticketPriceTouched) {
    state.ticketPrice = "";
    seedTicketPrice();
    const input = document.querySelector<HTMLInputElement>("#ticket-price");
    if (input) input.value = state.ticketPrice;
  }
  refreshBook();
  refreshSelectedContext();
  refreshTicketButtons();
  updateTicketEstimates();
  const market = currentMarket();
  setStatusNote(market ? `Depth follows ${sideName(market, index)} · book click does not send` : "Depth side changed");
}

function setTicketAction(action: TicketAction): void {
  if (state.ticketAction === action) return;
  state.ticketAction = action;
  if (!state.ticketPriceTouched) {
    state.ticketPrice = "";
    seedTicketPrice();
    const input = document.querySelector<HTMLInputElement>("#ticket-price");
    if (input) input.value = state.ticketPrice;
  }
  refreshTicketButtons();
  updateTicketEstimates();
}

function closeMenus(): void {
  document.querySelectorAll<HTMLElement>(".menu-button").forEach((button) => button.setAttribute("aria-expanded", "false"));
  document.querySelectorAll<HTMLElement>(".menu-panel").forEach((panel) => {
    panel.hidden = true;
  });
}

function openOverlay(html: string): void {
  let root = document.getElementById("overlay");
  if (!root) {
    root = document.createElement("div");
    root.id = "overlay";
    document.body.appendChild(root);
  }
  root.innerHTML = html;
  root.querySelector<HTMLElement>("[data-overlay-focus]")?.focus();
}

function closeOverlay(): void {
  document.getElementById("overlay")?.remove();
}

function openReview(): void {
  const quote = ticketNumbers();
  if (!quote.priceOk || !quote.qtyOk) {
    setStatusNote(quote.blocking);
    document.getElementById(quote.priceOk ? "ticket-qty" : "ticket-price")?.focus();
    return;
  }
  openOverlay(reviewMarkup(quote));
}

function openAbout(): void {
  openOverlay(`<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="about-title"><div class="modal-head"><span id="about-title">About Outcome Desk</span><button type="button" class="btn btn-quiet" data-command="close-overlay" data-overlay-focus="true" aria-label="Close">Close</button></div><div class="modal-body"><p class="about-copy">Outcome Desk reads public Hyperliquid mainnet market data for HIP-4 outcome markets. It does not connect a wallet, sign anything, or send orders.</p><p class="about-copy">The order ticket is a calculator. Review shows the cost, maximum loss, settlement value, and the published base taker fee. Submit stays unavailable.</p><ul class="shortcut-list"><li><span>Focus market search</span><kbd>/</kbd></li><li><span>Close a dialog or menu</span><kbd>Esc</kbd></li><li><span>Pan either chart</span><span>Drag</span></li><li><span>Zoom either chart</span><span>Scroll</span></li><li><span>Move the crosshair</span><span>Both time axes</span></li></ul><div class="modal-actions"><button type="button" class="btn btn-primary" data-command="close-overlay">Done</button></div></div></section></div>`);
}

function reviewMarkup(quote: TicketNumbers): string {
  const market = currentMarket();
  const side = market ? sideName(market, state.bookSide) : "Side";
  const coin = market?.sides[state.bookSide]?.coin ?? "";
  const row = (label: string, value: string, className = "") => `<div><span>${esc(label)}</span><strong class="${className}">${esc(value)}</strong></div>`;
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="review-title"><div class="modal-head"><span id="review-title">Review order preview</span><button type="button" class="btn btn-quiet" data-command="close-overlay" aria-label="Close review">Close</button></div><div class="modal-body"><p class="modal-kicker">${esc(market ? marketTitle(market) : "No market selected")}</p><div class="modal-summary">${row("Action", `${state.ticketAction.toUpperCase()} ${side}`, state.ticketAction === "buy" ? "positive" : "negative")}${row("Instrument", coin || "—")}${row("Limit price", `${state.ticketPrice} USDC`)}${row("Quantity", `${quote.qty}`)}${row("Time in force", tifLabel(state.ticketTif))}${row(state.ticketAction === "buy" ? "Estimated cost" : "Estimated proceeds", formatUsdc(quote.traded))}${row("Maximum loss", formatUsdc(quote.maxLoss))}${row("Potential settlement", formatUsdc(quote.settlement))}${row("Base taker fee", formatUsdc(quote.fee))}${row("Available balance", "No wallet")}</div><p class="modal-warning" id="review-warning">Read-only terminal. This preview is not sent to Hyperliquid. This version does not connect a wallet, so Submit stays off.</p>${quote.advisory ? `<p class="ticket-warning">${esc(quote.advisory)}</p>` : ""}<div class="modal-actions"><button type="button" class="btn btn-quiet" data-command="close-overlay" data-overlay-focus="true">Back to ticket</button><button type="button" class="btn btn-primary" disabled aria-describedby="review-warning">Submit unavailable</button></div></div></section></div>`;
}

function runCommand(command: string, source: HTMLElement): void {
  switch (command) {
    case "copy-link":
      void copyMarketLink();
      break;
    case "focus-search":
      document.getElementById("market-search")?.focus();
      break;
    case "focus-ticket":
      document.getElementById("ticket-price")?.focus();
      break;
    case "reset-chart":
      applyChartAction("underlying", "reset");
      break;
    case "reset-layout":
      state.layout = { watch: 292, dock: 308, terminal: 160 };
      state.panes = { watch: true, dock: true, terminal: true };
      saveLayout();
      applyLayout();
      syncPaneChecks();
      requestChartMeasure();
      setStatusNote("Panel sizes reset");
      break;
    case "set-interval": {
      const interval = source.dataset.interval;
      if (interval && INTERVALS.includes(interval as Interval)) setSharedInterval(interval as Interval);
      break;
    }
    case "toggle-pane": {
      const pane = source.dataset.pane;
      if (pane === "watch" || pane === "dock" || pane === "terminal") {
        state.panes[pane] = !state.panes[pane];
        saveLayout();
        applyLayout();
        syncPaneChecks();
        requestChartMeasure();
      }
      break;
    }
    case "review":
      openReview();
      break;
    case "about":
      openAbout();
      break;
    case "close-overlay":
      closeOverlay();
      break;
    case "toggle-theme":
      setTheme(currentTheme() === "dark" ? "light" : "dark");
      renderApp();
      break;
    default:
      break;
  }
}

async function copyMarketLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(location.href);
    setStatusNote("Copied the link to this market");
  } catch {
    setStatusNote("Clipboard is unavailable in this browser");
  }
}

function setSharedInterval(interval: Interval): void {
  if (state.underlyingInterval === interval) return;
  state.underlyingInterval = interval;
  state.underlyingZoom = 0;
  state.underlyingOffset = 0;
  setStatusNote(`Timeframe ${interval} · both charts share this window`);
  if (currentMarket()) void loadSelectedMarket();
  else renderApp();
}

function renderIntervals(): string {
  return INTERVALS.map((interval) => `<button type="button" class="interval-button ${state.underlyingInterval === interval ? "active" : ""}" data-interval="${interval}" data-chart-kind="shared" aria-pressed="${state.underlyingInterval === interval}">${interval}</button>`).join("");
}

function menuItem(label: string, command: string, extra = "", kbd = ""): string {
  return `<button type="button" role="menuitem" data-command="${command}" ${extra}><span class="check"></span><span>${label}</span>${kbd ? `<span class="menu-k">${kbd}</span>` : ""}</button>`;
}

function renderMenu(): string {
  const intervalItems = INTERVALS.map((interval) => `<button type="button" role="menuitem" data-command="set-interval" data-interval="${interval}"><span class="check">${state.underlyingInterval === interval ? "✓" : ""}</span><span>${interval}</span></button>`).join("");
  const pane = (name: PaneName, label: string) => `<button type="button" role="menuitemcheckbox" data-command="toggle-pane" data-pane="${name}" aria-checked="${state.panes[name]}"><span class="check">${state.panes[name] ? "✓" : ""}</span><span>${label}</span></button>`;
  return `<nav class="menubar" aria-label="Application menu">
    <div class="menu"><button type="button" class="menu-button" aria-expanded="false" aria-haspopup="true">File</button><div class="menu-panel" role="menu" hidden>${menuItem("Copy market link", "copy-link")}</div></div>
    <div class="menu"><button type="button" class="menu-button" aria-expanded="false" aria-haspopup="true">View</button><div class="menu-panel" role="menu" hidden>${menuItem("Focus market search", "focus-search", "", "/")}${menuItem("Reset chart view", "reset-chart")}${menuItem(currentTheme() === "dark" ? "Use light theme" : "Use dark theme", "toggle-theme")}</div></div>
    <div class="menu"><button type="button" class="menu-button" aria-expanded="false" aria-haspopup="true">Charts</button><div class="menu-panel" role="menu" hidden>${intervalItems}</div></div>
    <div class="menu"><button type="button" class="menu-button" aria-expanded="false" aria-haspopup="true">Trade</button><div class="menu-panel" role="menu" hidden>${menuItem("Review order preview", "review")}<button type="button" role="menuitem" disabled><span class="check"></span><span>Submit order</span><span class="menu-k">Read-only</span></button></div></div>
    <div class="menu"><button type="button" class="menu-button" aria-expanded="false" aria-haspopup="true">Window</button><div class="menu-panel" role="menu" hidden>${pane("watch", "Market watch")}${pane("dock", "Depth and ticket")}${pane("terminal", "Bottom terminal")}<div class="menu-rule"></div>${menuItem("Reset panel sizes", "reset-layout")}</div></div>
    <div class="menu"><button type="button" class="menu-button" aria-expanded="false" aria-haspopup="true">Help</button><div class="menu-panel" role="menu" hidden>${menuItem("About this terminal", "about")}${menuItem("Focus order ticket", "focus-ticket")}</div></div>
  </nav>`;
}

function icon(name: "sun" | "moon" | "search"): string {
  const paths = {
    sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>`,
    moon: `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9"/>`,
    search: `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`,
  };
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

const THEME_KEY = "outcome-desk-theme";
type ThemeName = "dark" | "light";

function systemTheme(): ThemeName {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function storedTheme(): ThemeName | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function currentTheme(): ThemeName {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#fafafa" : "#000000");
}

function setTheme(theme: ThemeName): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // The choice still applies for this session.
  }
  applyTheme(theme);
}

function initTheme(): void {
  applyTheme(storedTheme() ?? systemTheme());
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (!storedTheme()) applyTheme(systemTheme());
  });
}

function connectionChip(): string {
  if (state.connection === "ready") return `<span class="net-chip ready"><i class="dot" aria-hidden="true"></i> Mainnet</span>`;
  if (state.connection === "error") return `<span class="net-chip error"><i class="dot" aria-hidden="true"></i> Offline</span>`;
  return `<span class="net-chip starting"><i class="dot" aria-hidden="true"></i> Connecting</span>`;
}

function renderTopbar(): string {
  const market = currentMarket();
  const theme = currentTheme();
  const nextTheme = theme === "dark" ? "light" : "dark";
  return `<header class="topbar">
    <div class="brand"><span>Outcome Desk</span></div>
    <span class="top-divider" aria-hidden="true"></span>
    <label class="toolbar-label" for="selected-market">Market</label>
    <select id="selected-market" aria-label="Selected market" ${state.markets.length === 0 ? "disabled" : ""}>
      ${state.markets.map((entry) => `<option value="${esc(marketId(entry))}" ${market && marketId(entry) === marketId(market) ? "selected" : ""}>${esc(marketTitle(entry))}</option>`).join("")}
    </select>
    <div class="top-intervals" aria-label="Shared chart timeframe">${renderIntervals()}</div>
    <div class="top-actions">${connectionChip()}<span class="account-chip">Read-only · no wallet</span><button type="button" class="icon-button theme-toggle" id="theme-toggle" data-command="toggle-theme" aria-label="Switch to ${nextTheme} theme" aria-pressed="${theme === "light"}">${icon(theme === "dark" ? "sun" : "moon")}<span class="theme-name">Theme</span></button></div>
  </header>`;
}

function metadataChips(market: HIP4Market | undefined): string {
  if (!market) return "";
  const chips = [
    `<span class="chip">${esc(typeLabel(market.type))}</span>`,
    `<span class="chip mono">#${esc(market.outcomeId)}</span>`,
  ];
  market.sides.forEach((side, index) => {
    chips.push(`<span class="chip mono" title="Coin ${esc(side.coin)} · asset ${esc(side.asset)}">${esc(sideName(market, index as 0 | 1))} ${esc(side.coin)}</span>`);
  });
  const underlying = marketUnderlying(market);
  if (underlying) {
    const inferred = !("underlying" in market && market.underlying);
    chips.push(`<span class="chip">Underlying ${esc(underlying)}${inferred ? " · inferred" : ""}</span>`);
  }
  if ("period" in market && market.period) chips.push(`<span class="chip">${esc(market.period)}</span>`);
  if ("expiry" in market && market.expiry) chips.push(`<span class="chip">Resolves ${esc(formatExpiry(market))}</span>`);
  chips.push(`<span class="chip">${esc(deployerLabel(market))}</span>`);
  return chips.join("");
}

function settlementClockText(market: HIP4Market): string {
  const target = settlementTarget(market);
  if (!target) return "No settlement target";
  return `${target.label} ${formatUtcTarget(target.timestamp)} UTC · ${formatCountdown(target.timestamp - Date.now())}`;
}

function renderSelectedContext(): string {
  const market = currentMarket();
  if (!market) {
    return `<section class="market-context panel"><div class="empty-state">${state.loadingMarkets ? "Connecting to Outcome…" : "Select a market to view its book and charts."}</div></section>`;
  }
  const yes = bestBidOffer(state.selectedBook);
  const no = bestBidOffer(state.secondaryBook);
  const quote = (index: 0 | 1, bid: string, offer: string) => `
    <div class="side-quote ${index === 1 ? "secondary" : ""} ${state.bookSide === index ? "is-selected" : ""}">
      <span>${esc(sideName(market, index))} · bid / ask</span>
      <strong class="mono">${esc(`${bid} / ${offer}`)}</strong>
    </div>`;
  return `<section class="market-context" aria-label="Selected market">
    <div class="context-main">
      <h1 title="${esc(marketTitle(market))}">${esc(marketTitle(market))}</h1>
      <p class="context-rule" title="${esc(settlementRule(market))}">${esc(settlementRule(market))}</p>
    </div>
    <div class="side-quotes">${quote(0, yes.bid, yes.offer)}${quote(1, no.bid, no.offer)}</div>
    <div class="context-meta">
      <div class="context-chips">${metadataChips(market)}</div>
      <div class="context-timing">
        <span class="utc-clock"><span>UTC</span><strong class="mono" id="utc-clock">${esc(formatUtcClock())}</strong></span>
        <span class="settlement-clock mono" id="settlement-clock">${esc(settlementClockText(market))}</span>
      </div>
    </div>
  </section>`;
}

function chartZoomScale(zoom: number): number {
  return CHART_ZOOM_FACTOR ** zoom;
}

function visibleUnderlyingCandleCount(zoom = state.underlyingZoom): number {
  return Math.max(6, Math.round(DEFAULT_VISIBLE_CANDLES / chartZoomScale(zoom)));
}

type Plot = {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  plotBottom: number;
  plotWidth: number;
  plotHeight: number;
  volumeTop: number;
  volumeBottom: number;
};

function plotFor(kind: "underlying" | "contract"): Plot {
  const size = chartPixels[kind];
  const plotBottom = size.height - CHART_AXIS - VOLUME_H - VOLUME_GAP;
  return {
    width: size.width,
    height: size.height,
    left: CHART_LEFT,
    right: CHART_RIGHT,
    top: CHART_TOP,
    plotBottom,
    plotWidth: Math.max(1, size.width - CHART_LEFT - CHART_RIGHT),
    plotHeight: Math.max(1, plotBottom - CHART_TOP),
    volumeTop: plotBottom + VOLUME_GAP,
    volumeBottom: size.height - CHART_AXIS,
  };
}

function niceStep(span: number): number {
  const rough = Math.abs(span) / 3 || 1;
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const nice = fraction >= 7.5 ? 10 : fraction >= 3.5 ? 5 : fraction >= 1.5 ? 2 : 1;
  return nice * power;
}

function priceGrid(plot: Plot, minimum: number, maximum: number, format: (value: number) => string, avoidY?: number): string {
  const span = maximum - minimum || 1;
  const step = niceStep(span);
  const start = Math.ceil((minimum + span * 0.02) / step) * step;
  const values: number[] = [];
  for (let value = start; value < maximum - span * 0.02 && values.length < 4; value += step) values.push(value);
  if (values.length === 0) values.push((minimum + maximum) / 2);
  return values.map((value) => {
    const y = plot.top + ((maximum - value) / span) * plot.plotHeight;
    const label = avoidY !== undefined && Math.abs(y - avoidY) < 16
      ? ""
      : `<text class="chart-axis-label" x="${plot.width - 4}" y="${y + 3}" text-anchor="end">${esc(format(value))}</text>`;
    return `<g><line class="chart-gridline" x1="${plot.left}" y1="${y}" x2="${plot.width - plot.right}" y2="${y}"/>${label}</g>`;
  }).join("");
}

function timeGrid(plot: Plot, view: SharedView): string {
  const fractions = plot.plotWidth < 520 ? [0, 1] : [0, 1 / 3, 2 / 3, 1];
  return fractions.map((fraction, index) => {
    const x = plot.left + fraction * plot.plotWidth;
    const label = formatAxisTime(view.startMs + view.durationMs * fraction, view.durationMs);
    const anchor = index === 0 ? "start" : index === fractions.length - 1 ? "end" : "middle";
    const labelX = index === 0 ? plot.left : index === fractions.length - 1 ? plot.width - plot.right : x;
    return `<g><line class="chart-gridline" x1="${x}" y1="${plot.top}" x2="${x}" y2="${plot.plotBottom}"/><text class="chart-axis-label" x="${labelX}" y="${plot.height - 4}" text-anchor="${anchor}">${esc(label)}</text></g>`;
  }).join("");
}

function lastTag(plot: Plot, y: number, label: string, up: boolean): string {
  const yClamped = Math.min(plot.plotBottom - 8, Math.max(plot.top + 8, y));
  const fill = up ? "#0e7a34" : "#a12632";
  return `<g><line class="last-line" x1="${plot.left}" y1="${y}" x2="${plot.width - plot.right}" y2="${y}"/><rect x="${plot.width - plot.right + 1}" y="${yClamped - 7}" width="${plot.right - 2}" height="14" fill="${fill}"/><text x="${plot.width - 4}" y="${yClamped + 3}" text-anchor="end" fill="#fff" font-size="10" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${esc(label)}</text></g>`;
}

function svgShell(kind: "underlying" | "contract", plot: Plot, view: SharedView, minimum: number, maximum: number, label: string, body: string): string {
  return `<svg class="candle-chart" viewBox="0 0 ${plot.width} ${plot.height}" width="${plot.width}" height="${plot.height}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}" data-kind="${kind}" data-t0="${view.startMs}" data-t1="${view.endMs}" data-p0="${minimum}" data-p1="${maximum}" data-left="${plot.left}" data-right="${plot.right}" data-top="${plot.top}" data-bottom="${plot.plotBottom}" data-width="${plot.width}" data-height="${plot.height}">${body}</svg>`;
}

function candlesInView(candles: Candle[], view: SharedView): Candle[] {
  const intervalMs = INTERVAL_MS[state.underlyingInterval];
  return [...candles]
    .filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
    .sort((left, right) => left.time - right.time)
    .filter((candle) => {
      const start = candle.time * 1000;
      return start + intervalMs > view.startMs && start < view.endMs;
    });
}

function lastVisibleCandle(): Candle | null {
  const visible = candlesInView(state.underlyingCandles, sharedView());
  return visible.at(-1) ?? null;
}

function tradesInView(view: SharedView): Trade[] {
  return state.outcomeChartTrades.filter((trade) => {
    const price = Number(trade.price);
    return trade.timestamp >= view.startMs && trade.timestamp <= view.endMs && Number.isFinite(price) && price >= 0 && price <= 1;
  });
}

function latestTrade(): Trade | null {
  return state.outcomeChartTrades.at(-1) ?? null;
}

function candleAt(timeMs: number): Candle | null {
  const intervalMs = INTERVAL_MS[state.underlyingInterval];
  const bucket = Math.floor(timeMs / intervalMs) * intervalMs;
  return state.underlyingCandles.find((candle) => candle.time * 1000 === bucket) ?? null;
}

function tradeAt(timeMs: number): Trade | null {
  let best: Trade | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const trade of state.outcomeChartTrades) {
    const delta = Math.abs(trade.timestamp - timeMs);
    if (delta < bestDelta) {
      best = trade;
      bestDelta = delta;
    }
  }
  return best;
}

function underlyingReadout(candle: Candle | null): string {
  const market = currentMarket();
  const unit = market ? marketUnderlying(market) ?? "units" : "units";
  if (!candle) return "No candles in this window";
  const parts = [
    `O <b class="mono">${esc(formatUnderlying(candle.open))}</b>`,
    `H <b class="mono">${esc(formatUnderlying(candle.high))}</b>`,
    `L <b class="mono">${esc(formatUnderlying(candle.low))}</b>`,
    `C <b class="mono">${esc(formatUnderlying(candle.close))}</b>`,
    `Vol <b class="mono">${esc(formatVolume(candle.volume, unit))}</b>`,
    `<i class="swatch fast"></i>MA9`,
    `<i class="swatch slow"></i>MA21`,
  ];
  return parts.map((part) => `<span class="stat">${part}</span>`).join("");
}

function contractReadout(trade: Trade | null): string {
  const market = currentMarket();
  const quotes = bestBidOffer(activeBook());
  const spread = bookSpread();
  const side = market ? sideName(market, state.bookSide) : "Side";
  const last = trade ? formatContractPrice(trade.price) : "—";
  const parts = [
    `${esc(side)} last <b class="mono">${esc(last)}</b>`,
    `Bid <b class="mono positive">${esc(quotes.bid)}</b>`,
    `Ask <b class="mono negative">${esc(quotes.offer)}</b>`,
    `Spread <b class="mono">${esc(spread.text)}</b>`,
  ];
  return parts.map((part) => `<span class="stat">${part}</span>`).join("");
}

function paintReadouts(override?: { candle?: Candle | null; trade?: Trade | null }): void {
  const underlying = document.getElementById("underlying-readout");
  const contract = document.getElementById("contract-readout");
  const candle = override && "candle" in override ? override.candle ?? null : lastVisibleCandle();
  const trade = override && "trade" in override ? override.trade ?? null : latestTrade();
  if (underlying) underlying.innerHTML = underlyingReadout(candle);
  if (contract) contract.innerHTML = contractReadout(trade);
}

function bookSpread(): { text: string; crossed: boolean; bid: number | null; ask: number | null } {
  const book = activeBook();
  const bids = book ? sortBookLevels(book.bids, "desc") : [];
  const asks = book ? sortBookLevels(book.asks, "asc") : [];
  const bid = bids[0] ? Number(bids[0].price) : null;
  const ask = asks[0] ? Number(asks[0].price) : null;
  if (bid === null || ask === null || !Number.isFinite(bid) || !Number.isFinite(ask)) return { text: "—", crossed: false, bid, ask };
  const spread = ask - bid;
  if (spread < 0) return { text: "Crossed", crossed: true, bid, ask };
  const mid = (ask + bid) / 2;
  const percent = mid > 0 ? (spread / mid) * 100 : 0;
  const percentText = percent >= 0.1 ? `${percent.toFixed(1)}%` : `${percent.toFixed(2)}%`;
  return { text: `${formatBookPrice(spread)} · ${percentText}`, crossed: false, bid, ask };
}

function renderChartControls(kind: "underlying" | "contract"): string {
  const view = sharedView();
  const zoom = state.underlyingZoom;
  const atLive = view.offset <= 0.001;
  const canOlder = view.offset < view.maxOffset - 0.001;
  const zoomLabel = `${chartZoomScale(zoom).toFixed(1)}×`;
  const control = (action: string, label: string, title: string, disabled: boolean) =>
    `<button class="chart-control" type="button" data-chart-kind="${kind}" data-chart-action="${action}" aria-label="${title}" title="${title}" ${disabled ? "disabled" : ""}>${label}</button>`;
  return `<div class="chart-controls" aria-label="Chart navigation. Pan and zoom move both charts.">
    ${control("older", "←", "Pan to older data", !canOlder)}
    ${control("newer", "→", "Pan toward the live edge", atLive)}
    ${control("zoom-out", "−", "Zoom out", zoom <= 0)}
    <span class="chart-zoom mono" title="Zoom">${zoomLabel}</span>
    ${control("zoom-in", "+", "Zoom in", zoom >= MAX_CHART_ZOOM)}
    ${control("reset", "Fit", "Reset zoom and return to live data", zoom === 0 && atLive)}
  </div>`;
}

function movingAveragePath(candles: Candle[], period: number, plot: Plot, view: SharedView, y: (price: number) => number): string {
  const points: string[] = [];
  let sum = 0;
  const intervalMs = INTERVAL_MS[state.underlyingInterval];
  for (let index = 0; index < candles.length; index += 1) {
    sum += candles[index].close;
    if (index >= period) sum -= candles[index - period].close;
    if (index < period - 1) continue;
    const time = candles[index].time * 1000 + intervalMs / 2;
    if (time < view.startMs || time > view.endMs) continue;
    const x = plot.left + ((time - view.startMs) / view.durationMs) * plot.plotWidth;
    points.push(`${x.toFixed(1)},${y(sum / period).toFixed(1)}`);
  }
  return points.length > 1 ? points.join(" ") : "";
}

function candleChart(candles: Candle[], livePrice: number | null, strikeLines: MarketStrikeLine[]): string {
  const view = sharedView();
  const plot = plotFor("underlying");
  const sorted = [...candles].filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)).sort((left, right) => left.time - right.time);
  const visible = candlesInView(sorted, view);
  if (visible.length === 0) {
    return `<div class="chart-empty">${state.loadingMarketData ? "Loading candle history…" : "No candles in this window. Pan back or choose another timeframe."}</div>`;
  }
  let minimum = Math.min(...visible.map((candle) => candle.low));
  let maximum = Math.max(...visible.map((candle) => candle.high));
  if (livePrice !== null && Number.isFinite(livePrice)) {
    minimum = Math.min(minimum, livePrice);
    maximum = Math.max(maximum, livePrice);
  }
  for (const strike of strikeLines) {
    minimum = Math.min(minimum, strike.price);
    maximum = Math.max(maximum, strike.price);
  }
  const span = maximum - minimum || Math.max(Math.abs(maximum) * 0.02, 1);
  const padding = span * 0.08;
  minimum -= padding;
  maximum += padding;
  const y = (price: number) => plot.top + ((maximum - price) / (maximum - minimum || 1)) * plot.plotHeight;
  const intervalMs = INTERVAL_MS[state.underlyingInterval];
  const candleWidth = Math.max(1.5, Math.min(16, (plot.plotWidth * intervalMs / view.durationMs) * 0.72));
  const xAt = (timeMs: number) => plot.left + ((timeMs - view.startMs) / view.durationMs) * plot.plotWidth;
  const bars = visible.map((candle) => {
    const x = xAt(candle.time * 1000 + intervalMs / 2);
    const top = y(Math.max(candle.open, candle.close));
    const bottom = y(Math.min(candle.open, candle.close));
    const direction = candle.close >= candle.open ? "up" : "down";
    return `<g class="candle ${direction}"><line x1="${x}" y1="${y(candle.high)}" x2="${x}" y2="${y(candle.low)}"/><rect x="${x - candleWidth / 2}" y="${top}" width="${candleWidth}" height="${Math.max(1, bottom - top)}"/></g>`;
  }).join("");
  const maxVolume = Math.max(1, ...visible.map((candle) => Number(candle.volume) || 0));
  const volumeBars = visible.map((candle) => {
    const volume = Math.max(0, Number(candle.volume) || 0);
    if (volume <= 0) return "";
    const x = xAt(candle.time * 1000 + intervalMs / 2);
    const barHeight = Math.max(1, (volume / maxVolume) * (plot.volumeBottom - plot.volumeTop));
    const direction = candle.close >= candle.open ? "up" : "down";
    return `<rect class="volume-bar ${direction}" x="${x - candleWidth / 2}" y="${plot.volumeBottom - barHeight}" width="${candleWidth}" height="${barHeight}"/>`;
  }).join("");
  const fast = movingAveragePath(sorted, 9, plot, view, y);
  const slow = movingAveragePath(sorted, 21, plot, view, y);
  const averages = `${fast ? `<polyline class="ma-fast" points="${fast}"/>` : ""}${slow ? `<polyline class="ma-slow" points="${slow}"/>` : ""}`;
  const strikes = strikeLines.map((strike, index) => {
    const lineY = y(strike.price);
    const labelY = Math.min(plot.plotBottom - 2, Math.max(plot.top + 10, lineY - 4 - index * 11));
    return `<g class="strike-marker"><line class="strike-price-line" x1="${plot.left}" y1="${lineY}" x2="${plot.width - plot.right}" y2="${lineY}"/><text class="strike-price-label" x="${plot.left + 4}" y="${labelY}" text-anchor="start">${esc(`${strike.label} ${formatUnderlying(strike.price)}`)}</text></g>`;
  }).join("");
  const last = visible.at(-1);
  const markerPrice = livePrice !== null && Number.isFinite(livePrice) ? livePrice : last?.close ?? maximum;
  const up = last ? markerPrice >= last.open : true;
  const markerY = y(markerPrice);
  const volumeLabel = `<g><line class="volume-divider" x1="${plot.left}" y1="${plot.volumeTop - 3}" x2="${plot.width - plot.right}" y2="${plot.volumeTop - 3}"/><text class="volume-axis-label" x="${plot.left + 2}" y="${plot.volumeTop + 9}">VOL</text></g>`;
  const body = `${priceGrid(plot, minimum, maximum, (value) => formatAxisPrice(value, "underlying"), markerY)}${timeGrid(plot, view)}${volumeLabel}${volumeBars}${averages}${bars}${strikes}${lastTag(plot, markerY, formatAxisPrice(markerPrice, "underlying"), up)}`;
  const strikeDescription = strikeLines.length > 0 ? `. ${strikeLines.map((strike) => `${strike.label} ${formatUnderlying(strike.price)}`).join(", ")}` : "";
  return svgShell("underlying", plot, view, minimum, maximum, `Underlying candlestick chart with volume${strikeDescription}`, body);
}

function downsampleTrades(trades: Trade[], max: number): Trade[] {
  if (trades.length <= max) return trades;
  const step = (trades.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, index) => trades[Math.round(index * step)]);
}

function outcomeLineChart(): string {
  const view = sharedView();
  const plot = plotFor("contract");
  const visible = tradesInView(view);
  if (visible.length === 0) {
    return `<div class="chart-empty">${state.loadingMarketData ? "Loading recent trade history…" : "No trade prices in this window."}</div>`;
  }
  const sampled = downsampleTrades(visible, 400);
  const prices = visible.map((trade) => Number(trade.price));
  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  const padding = (rawMax - rawMin || 0.01) * 0.12;
  let minimum = Math.max(0, rawMin - padding);
  let maximum = Math.min(1, rawMax + padding);
  if (maximum - minimum < 0.01) {
    const mid = (rawMin + rawMax) / 2;
    minimum = Math.max(0, mid - 0.01);
    maximum = Math.min(1, mid + 0.01);
  }
  if (maximum <= minimum) {
    minimum = 0;
    maximum = 1;
  }
  const y = (price: number) => plot.top + ((maximum - price) / (maximum - minimum || 1)) * plot.plotHeight;
  const xAt = (timeMs: number) => plot.left + ((timeMs - view.startMs) / view.durationMs) * plot.plotWidth;
  const line = sampled.map((trade, index) => `${index === 0 ? "M" : "L"}${xAt(trade.timestamp).toFixed(2)},${y(Number(trade.price)).toFixed(2)}`).join(" ");
  const dots = sampled.length <= 80
    ? sampled.map((trade) => `<circle class="trade-point" cx="${xAt(trade.timestamp)}" cy="${y(Number(trade.price))}" r="2"/>`).join("")
    : "";
  const last = visible.at(-1)!;
  const extend = view.offset < 0.5 && last.timestamp < view.endMs - 1000
    ? `<line class="trade-extend" x1="${xAt(last.timestamp)}" y1="${y(Number(last.price))}" x2="${xAt(view.endMs)}" y2="${y(Number(last.price))}"/>`
    : "";
  const bucketCount = 48;
  const bucketSize = view.durationMs / bucketCount;
  const volumes = Array.from({ length: bucketCount }, () => 0);
  for (const trade of visible) {
    const index = Math.max(0, Math.min(bucketCount - 1, Math.floor((trade.timestamp - view.startMs) / bucketSize)));
    volumes[index] += Math.max(0, Number(trade.size) || 0);
  }
  const maxVolume = Math.max(1, ...volumes);
  const barWidth = (plot.plotWidth / bucketCount) * 0.72;
  const volumeBars = volumes.map((volume, index) => {
    if (volume <= 0) return "";
    const barHeight = Math.max(1, (volume / maxVolume) * (plot.volumeBottom - plot.volumeTop));
    const center = plot.left + ((index + 0.5) / bucketCount) * plot.plotWidth;
    return `<rect class="volume-bar neutral" x="${center - barWidth / 2}" y="${plot.volumeBottom - barHeight}" width="${barWidth}" height="${barHeight}"/>`;
  }).join("");
  const volumeLabel = `<g><line class="volume-divider" x1="${plot.left}" y1="${plot.volumeTop - 3}" x2="${plot.width - plot.right}" y2="${plot.volumeTop - 3}"/><text class="volume-axis-label" x="${plot.left + 2}" y="${plot.volumeTop + 9}">VOL</text></g>`;
  const up = Number(last.price) >= Number(visible[0].price);
  const markerY = y(Number(last.price));
  const body = `${priceGrid(plot, minimum, maximum, (value) => formatAxisPrice(value, "contract"), markerY)}${timeGrid(plot, view)}${volumeLabel}${volumeBars}<path class="trade-line" d="${line}"/>${extend}${dots}${lastTag(plot, markerY, formatContractPrice(last.price), up)}`;
  return svgShell("contract", plot, view, minimum, maximum, "YES contract trade prices on a 0 to 1 USDC scale, time axis synced with the underlying chart", body);
}

function renderChartPanel(title: string, outcomeId: string | null, candles: Candle[], kind: "contract" | "underlying", livePrice: number | null): string {
  const market = currentMarket();
  const underlying = market ? marketUnderlying(market) : null;
  const inferred = Boolean(market && underlying && !("underlying" in market && market.underlying));
  const noUnderlying = kind === "underlying" && !underlying;
  const lastTrade = latestTrade();
  const contractPrice = lastTrade ? Number(lastTrade.price) : null;
  const priceLabel = kind === "contract"
    ? `<strong class="chart-live-price mono">${esc(contractPrice === null ? "—" : formatContractPrice(contractPrice))}<small>${esc(formatProbability(contractPrice))}</small></strong>`
    : `<strong class="chart-live-price mono">${esc(formatUnderlying(livePrice))}<small>Last</small></strong>`;
  const subtitle = kind === "contract"
    ? `${market ? sideName(market, 0) : "Yes"} trades · 0–1 USDC · synced`
    : underlying
      ? `${underlying} perp${inferred ? " · inferred" : ""} · ${state.underlyingInterval} · synced`
      : "";
  const subtitleTitle = kind === "contract"
    ? "Public trades from 0 to 1 USDC. The time axis is synced with the underlying chart."
    : underlying
      ? `${underlying} perpetual${inferred ? ", inferred from the market name" : ""}. ${state.underlyingInterval} candles. Time axis synced with the contract chart.`
      : "No underlying is mapped, so the candle chart stays hidden.";
  const strikeLines = kind === "underlying" && market ? marketStrikeLines(market) : [];
  const chart = noUnderlying
    ? `<div class="chart-empty">No supported underlying for this market.</div>`
    : kind === "contract"
      ? outcomeLineChart()
      : candleChart(candles, livePrice, strikeLines);
  const visibleTrades = tradesInView(sharedView());
  const volume = kind === "contract"
    ? visibleTrades.reduce((total, trade) => total + (Number(trade.size) || 0), 0)
    : lastVisibleCandle()?.volume;
  const unit = kind === "contract" ? "shares" : underlying ?? "units";
  const readout = noUnderlying
    ? "No underlying series for this market."
    : kind === "contract" ? contractReadout(lastTrade) : underlyingReadout(lastVisibleCandle());
  const readoutId = kind === "contract" ? "contract-readout" : "underlying-readout";
  const source = noUnderlying
    ? "no series"
    : kind === "contract" || state.underlyingInterval === "15s" ? "recent trades + live" : "candle history + live";
  return `<section class="panel chart-panel ${kind}-panel${noUnderlying ? " is-empty" : ""}">
    <div class="chart-toolbar">
      <div class="chart-title-group"><strong>${esc(title)}</strong>${subtitle ? `<span title="${esc(subtitleTitle)}">${esc(subtitle)}</span>` : ""}</div>
      ${noUnderlying ? "" : `${priceLabel}${renderChartControls(kind)}`}
    </div>
    <div class="chart-surface" data-chart-kind="${kind}" id="${kind}-chart" title="${noUnderlying ? "" : "Scroll to zoom · drag to pan · the other chart follows"}">
      ${chart}
      <div class="xhair" hidden><div class="xhair-v"></div><div class="xhair-h" hidden></div><div class="xhair-price mono" hidden></div><div class="xhair-time mono"></div></div>
    </div>
    ${noUnderlying ? "" : `<div class="stats-strip" id="${readoutId}">${readout}</div>`}
    <div class="chart-footer"><span>${esc(outcomeId ? `Outcome #${outcomeId}` : "No outcome")}</span><span>${kind === "contract" ? `${visibleTrades.length} trades` : `${candles.length} candles`} · Vol ${esc(formatVolume(volume, unit))} · ${esc(source)} · ${esc(formatAge(state.lastUpdateAt))}</span></div>
  </section>`;
}

function renderChartPanels(): string {
  const market = currentMarket();
  const id = market ? marketId(market) : null;
  const underlying = market ? marketUnderlying(market) : null;
  const title = underlying ? `${underlying} underlying` : "Underlying reference";
  return `${renderChartPanel(title, id, state.underlyingCandles, "underlying", state.underlyingPrice)}${renderChartPanel(market ? `${sideName(market, 0)} contract` : "YES contract", id, [], "contract", null)}`;
}

function renderCharts(): string {
  return `<div class="charts-column">${renderChartPanels()}</div>`;
}

function levelRows(levels: Array<{ price: string; size: string }>, side: "bid" | "ask", maxSize: number): string {
  if (levels.length === 0) return `<div class="book-empty">${state.loadingMarketData ? "Loading book…" : `No ${side}s`}</div>`;
  let cumulative = 0;
  const ticketPx = Number(state.ticketPrice);
  return levels.map((level) => {
    const size = Number(level.size) || 0;
    cumulative += size;
    const depth = Math.min(100, (size / maxSize) * 100);
    const price = Number(level.price);
    const selected = Number.isFinite(ticketPx) && Number.isFinite(price) && Math.abs(price - ticketPx) < 0.0000005;
    return `<button type="button" class="book-row ${side} ${selected ? "is-ticket" : ""}" data-book-price="${esc(level.price)}" aria-label="Set limit price to ${esc(formatBookPrice(level.price))} without sending an order"><span class="book-depth" style="--depth:${(depth / 100).toFixed(3)}"></span><span class="mono price">${esc(formatBookPrice(level.price))}</span><span class="mono size">${esc(formatNumber(level.size, 2))}</span><span class="mono total">${esc(formatNumber(cumulative, 2))}</span></button>`;
  }).join("");
}

function renderBook(): string {
  const market = currentMarket();
  const book = activeBook();
  const bids = book ? sortBookLevels(book.bids ?? [], "desc") : [];
  const asks = book ? sortBookLevels(book.asks ?? [], "asc") : [];
  const spread = bookSpread();
  const mid = spread.bid !== null && spread.ask !== null ? formatBookPrice((spread.bid + spread.ask) / 2) : "—";
  const maxSize = Math.max(1, ...bids.map((level) => Number(level.size) || 0), ...asks.map((level) => Number(level.size) || 0));
  const side = market ? sideName(market, state.bookSide) : "Side";
  const coin = market?.sides[state.bookSide]?.coin ?? "";
  return `<section class="panel book-panel" aria-label="Depth of market">
    <div class="panel-heading"><span>Depth of market</span><span class="panel-tail">${esc(side)}${coin ? ` · ${esc(coin)}` : ""}</span></div>
    <div class="book-summary">
      <div><span>Best bid</span><strong class="mono positive">${esc(spread.bid === null ? "—" : formatBookPrice(spread.bid))}</strong></div>
      <div><span>Best ask</span><strong class="mono negative">${esc(spread.ask === null ? "—" : formatBookPrice(spread.ask))}</strong></div>
      <div><span>Spread</span><strong class="mono ${spread.crossed ? "negative" : ""}">${esc(spread.text)}</strong></div>
      <div><span>Mid</span><strong class="mono">${esc(mid)}</strong></div>
    </div>
    <div class="book-columns"><span>Price</span><span>Size</span><span>Total</span></div>
    <div class="book-levels asks">${levelRows(asks, "ask", maxSize)}</div>
    <div class="book-mid"><span>${esc(side)}</span><span class="mono">${esc(spread.bid === null || spread.ask === null ? "—" : `${formatBookPrice(spread.bid)} / ${formatBookPrice(spread.ask)}`)}</span></div>
    <div class="book-levels bids">${levelRows(bids, "bid", maxSize)}</div>
    <div class="book-note">Click a level to fill the limit. Nothing is sent.</div>
  </section>`;
}

function renderTicket(): string {
  const market = currentMarket();
  const quote = ticketNumbers();
  const sideButton = (index: 0 | 1) => {
    const name = market ? sideName(market, index) : `Side ${index}`;
    const on = state.bookSide === index;
    return `<button type="button" class="btn ${on ? "active" : ""}" data-ticket-side="${index}" aria-pressed="${on}" title="${esc(name)}">${esc(name)}</button>`;
  };
  const actionButton = (action: TicketAction, label: string) => {
    const on = state.ticketAction === action;
    return `<button type="button" class="btn ${action === "buy" ? "btn-buy" : "btn-sell"} ${on ? "active" : ""}" data-ticket-action="${action}" aria-pressed="${on}">${label}</button>`;
  };
  const bps = Math.round(BASE_TAKER_RATE * 10_000);
  return `<section class="panel ticket" aria-label="Order ticket">
    <div class="panel-heading"><span>Order ticket</span><span class="panel-tail">Preview · not sent</span></div>
    <div class="side-toggle" role="group" aria-label="Outcome side">${sideButton(0)}${sideButton(1)}</div>
    <div class="action-toggle" role="group" aria-label="Buy or sell">${actionButton("buy", "Buy")}${actionButton("sell", "Sell")}</div>
    <div class="ticket-fields">
      <div class="field"><label id="ticket-price-label" for="ticket-price">${esc(tickHint())}</label><div class="input-wrap"><input id="ticket-price" inputmode="decimal" autocomplete="off" value="${esc(state.ticketPrice)}"><span>USDC</span></div></div>
      <div class="field"><label for="ticket-qty">Quantity</label><div class="input-wrap"><input id="ticket-qty" inputmode="decimal" autocomplete="off" value="${esc(state.ticketQty)}"><span>Shares</span></div></div>
      <div class="field"><label for="ticket-type">Order type</label><select id="ticket-type" class="ticket-select" aria-label="Order type"><option>Limit</option></select></div>
      <div class="field"><label for="ticket-tif">Time in force</label><select id="ticket-tif" class="ticket-select"><option value="Gtc" ${state.ticketTif === "Gtc" ? "selected" : ""}>GTC</option><option value="Ioc" ${state.ticketTif === "Ioc" ? "selected" : ""}>IOC</option></select></div>
    </div>
    <div class="estimate">
      <span id="est-cost-label">${state.ticketAction === "buy" ? "Estimated cost" : "Estimated proceeds"}</span><strong class="mono" id="est-cost">${quote.priceOk && quote.qtyOk ? esc(formatUsdc(quote.traded)) : "—"}</strong>
      <span>Maximum loss</span><strong class="mono" id="est-loss">${Number.isFinite(quote.maxLoss) ? esc(formatUsdc(quote.maxLoss)) : "—"}</strong>
      <span>Potential settlement</span><strong class="mono" id="est-settle">${quote.qtyOk ? esc(formatUsdc(quote.settlement)) : "—"}</strong>
      <span title="Published base taker rate. Account tiers are not loaded.">Fee · ${bps} bps base</span><strong class="mono" id="est-fee" title="Published base taker rate. Account tiers are not loaded.">${Number.isFinite(quote.fee) ? esc(formatUsdc(quote.fee)) : "—"}</strong>
      <span>Minimum size</span><strong class="mono" id="est-min">${quote.minShares === null ? "—" : esc(`${quote.minShares} shares`)}</strong>
      <span>Available</span><strong class="mono" id="est-balance">No wallet</strong>
    </div>
    <div class="ticket-warning" id="ticket-warning">${esc(quote.advisory)}</div>
    <div class="review-wrap"><button type="button" class="btn btn-primary" id="review-order" data-command="review" ${quote.priceOk && quote.qtyOk ? "" : "disabled"}>${quote.priceOk && quote.qtyOk ? "Review order" : "Enter price and size"}</button></div>
    <div class="position-summary"><span>Position <strong>None · read-only</strong></span><span>Balance <strong>No wallet</strong></span></div>
  </section>`;
}

function toneBadge(tone: ActivityTone): string {
  if (tone === "ok") return `<span class="badge badge-green">Ok</span>`;
  if (tone === "warn") return `<span class="badge badge-amber">Warn</span>`;
  if (tone === "error") return `<span class="badge badge-red">Error</span>`;
  return `<span class="badge badge-blue">Info</span>`;
}

function emptyRow(colspan: number, message: string): string {
  return `<tr><td class="empty-table" colspan="${colspan}">${esc(message)}</td></tr>`;
}

function renderTape(): string {
  const rows = state.trades.slice(0, DISPLAY_TRADES);
  const body = rows.length === 0
    ? emptyRow(4, state.loadingMarketData ? "Loading recent public trades…" : "No recent public trades for this market.")
    : rows.map((trade) => `<tr><td class="mono">${esc(formatTime(trade.timestamp))}</td><td class="${trade.side === "buy" ? "positive" : "negative"}">${trade.side.toUpperCase()}</td><td class="numeric mono">${esc(formatBookPrice(trade.price))}</td><td class="numeric mono">${esc(formatNumber(trade.size, 2))}</td></tr>`).join("");
  return `<table class="data-table"><thead><tr><th>Time</th><th>Side</th><th class="numeric">Price</th><th class="numeric">Size</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderTerminalBody(): string {
  if (state.terminalTab === "tape") return renderTape();
  if (state.terminalTab === "positions") {
    return `<table class="data-table"><thead><tr><th>Market</th><th>Side</th><th class="numeric">Quantity</th><th class="numeric">Avg</th><th class="numeric">Mark</th><th class="numeric">Unrealized</th><th>Status</th></tr></thead><tbody>${emptyRow(7, "No positions. Outcome Desk does not connect a wallet, so account positions stay empty.")}</tbody></table>`;
  }
  if (state.terminalTab === "orders") {
    return `<table class="data-table"><thead><tr><th>Order</th><th>Market</th><th>Side</th><th class="numeric">Quantity</th><th class="numeric">Limit</th><th>Status</th></tr></thead><tbody>${emptyRow(6, "No open orders. Reviewing a ticket only previews it. Nothing is submitted.")}</tbody></table>`;
  }
  if (state.terminalTab === "fills") {
    return `<table class="data-table"><thead><tr><th>Time</th><th>Market</th><th>Side</th><th class="numeric">Quantity</th><th class="numeric">Price</th><th>Status</th></tr></thead><tbody>${emptyRow(6, "No account fills. Public prints are on the Public trades tab.")}</tbody></table>`;
  }
  if (state.terminalTab === "balances") {
    return `<table class="data-table"><thead><tr><th>Asset</th><th>Type</th><th class="numeric">Available</th><th class="numeric">Total</th></tr></thead><tbody>${emptyRow(4, "No balances. This terminal does not query an account.")}</tbody></table>`;
  }
  const body = state.activity.length === 0
    ? emptyRow(3, "No session events yet.")
    : state.activity.map((entry) => `<tr><td class="mono">${esc(formatTime(entry.time))}</td><td>${esc(entry.detail)}</td><td>${toneBadge(entry.tone)}</td></tr>`).join("");
  return `<table class="data-table"><thead><tr><th>Time</th><th>Event</th><th>Status</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderTerminal(): string {
  const tabs = TERMINAL_TABS.map((tab) => {
    const count = tab.id === "tape" ? state.trades.length : tab.id === "activity" ? state.activity.length : 0;
    const countLabel = tab.id === "tape" || tab.id === "activity" ? `<span class="tab-count">${count}</span>` : "";
    return `<button type="button" class="terminal-tab ${state.terminalTab === tab.id ? "active" : ""}" role="tab" data-tab="${tab.id}" aria-selected="${state.terminalTab === tab.id}" id="tab-${tab.id}">${tab.label}${countLabel}</button>`;
  }).join("");
  return `<section class="panel terminal" aria-label="Account terminal"><div class="terminal-tabs" role="tablist">${tabs}</div><div class="terminal-content" id="terminal-content" role="tabpanel">${renderTerminalBody()}</div></section>`;
}

function renderStatusline(): string {
  const market = currentMarket();
  const connection = state.connection === "ready" ? "Hyperliquid mainnet" : state.connection === "error" ? "Disconnected" : "Connecting";
  return `<footer class="statusline">
    <span class="status-strong">${esc(connection)}</span>
    <span>Public data</span>
    <span id="status-preview">${esc(previewText())}</span>
    <span class="status-note" id="status-note">${esc(state.statusNote)}</span>
    <span class="spacer"></span>
    <span id="status-age">${esc(formatAge(state.lastUpdateAt))}</span>
    <span class="status-market">${esc(market ? marketTitle(market) : "No market")}</span>
    <span>Read-only · no wallet</span>
  </footer>`;
}

function renderApp(): void {
  const list = document.querySelector<HTMLDivElement>("#market-list");
  const scrollTop = list?.scrollTop ?? 0;
  const search = document.querySelector<HTMLInputElement>("#market-search");
  const searchFocused = document.activeElement === search;
  const caret = search?.selectionStart ?? null;
  appRoot!.innerHTML = `${renderMenu()}${renderTopbar()}${state.error ? `<div class="error-banner" role="alert">${esc(state.error)}</div>` : ""}<div class="grid-layout" id="workspace">${renderMarketWatch()}<div class="splitter col split-watch" role="separator" aria-orientation="vertical" aria-label="Resize market watch" tabindex="0" data-resize="watch"></div><div class="center-column">${renderSelectedContext()}${renderCharts()}</div><div class="splitter col split-dock" role="separator" aria-orientation="vertical" aria-label="Resize depth and order ticket" tabindex="0" data-resize="dock"></div><div class="right-column">${renderBook()}${renderTicket()}</div><div class="splitter row split-term" role="separator" aria-orientation="horizontal" aria-label="Resize bottom terminal" tabindex="0" data-resize="terminal"></div>${renderTerminal()}${renderStatusline()}</div>`;
  const nextList = document.querySelector<HTMLDivElement>("#market-list");
  if (nextList) nextList.scrollTop = scrollTop;
  bindSearchAndFilter();
  applyLayout();
  observeCharts();
  syncTitle();
  const nextSearch = document.querySelector<HTMLInputElement>("#market-search");
  if (searchFocused && nextSearch) {
    nextSearch.focus();
    if (caret !== null) nextSearch.setSelectionRange(caret, caret);
  }
  requestChartMeasure();
  pinBookToSpread();
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
  const count = document.querySelector<HTMLElement>("#watch-count");
  if (count) count.textContent = `${filteredMarkets().length} / ${state.markets.length}`;
  const footer = document.querySelector<HTMLElement>(".watch-footer span");
  if (footer) footer.textContent = watchFooterText();
}

function refreshSelectedContext(): void {
  const existing = document.querySelector(".market-context");
  if (existing) existing.outerHTML = renderSelectedContext();
}

function refreshCharts(): void {
  const charts = document.querySelector<HTMLElement>(".charts-column");
  if (!charts) return;
  charts.innerHTML = renderChartPanels();
  if (lastPointer && !chartDrag && !resizeDrag) syncCrosshair(lastPointer.x, lastPointer.y);
}

function pinBookToSpread(): void {
  document.querySelectorAll<HTMLElement>(".book-levels").forEach((node) => {
    node.style.height = "";
    node.style.flex = "";
  });
  requestAnimationFrame(() => {
    document.querySelectorAll<HTMLElement>(".book-levels").forEach((node) => {
      const sample = node.querySelector<HTMLElement>(".book-row");
      const row = Math.max(1, Math.round(sample?.getBoundingClientRect().height || 20));
      const fit = Math.max(row, Math.floor(node.clientHeight / row) * row);
      node.style.flex = "0 0 auto";
      node.style.height = `${fit}px`;
      if (node.classList.contains("asks")) node.scrollTop = 0;
    });
  });
}

function refreshBook(): void {
  seedTicketPrice();
  const book = document.querySelector<HTMLElement>(".book-panel");
  if (book) book.outerHTML = renderBook();
  pinBookToSpread();
  const price = document.querySelector<HTMLInputElement>("#ticket-price");
  if (price && document.activeElement !== price && !state.ticketPriceTouched) price.value = state.ticketPrice;
  updateTicketEstimates();
}

function refreshTerminal(): void {
  const count = document.querySelector('[data-tab="tape"] .tab-count');
  if (count) count.textContent = String(state.trades.length);
  const activityCount = document.querySelector('[data-tab="activity"] .tab-count');
  if (activityCount) activityCount.textContent = String(state.activity.length);
  const content = document.querySelector("#terminal-content");
  if (content) content.innerHTML = renderTerminalBody();
}

function refreshTrades(): void {
  if (state.terminalTab === "tape") refreshTerminal();
  else {
    const count = document.querySelector('[data-tab="tape"] .tab-count');
    if (count) count.textContent = String(state.trades.length);
  }
}

function refreshMarketTiming(): void {
  const clock = document.querySelector<HTMLElement>("#utc-clock");
  if (clock) clock.textContent = formatUtcClock();
  const settlement = document.querySelector<HTMLElement>("#settlement-clock");
  const market = currentMarket();
  if (settlement && market) settlement.textContent = settlementClockText(market);
  const age = document.querySelector("#status-age");
  if (age) age.textContent = formatAge(state.lastUpdateAt);
  syncTitle();
}

type SvgMetrics = {
  t0: number;
  t1: number;
  p0: number;
  p1: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

function svgMetrics(svg: SVGSVGElement): SvgMetrics | null {
  const read = (name: string) => Number(svg.dataset[name]);
  const metrics = {
    t0: read("t0"),
    t1: read("t1"),
    p0: read("p0"),
    p1: read("p1"),
    left: read("left"),
    right: read("right"),
    top: read("top"),
    bottom: read("bottom"),
    width: read("width"),
    height: read("height"),
  };
  if (Object.values(metrics).some((value) => !Number.isFinite(value))) return null;
  return metrics;
}

function clearCrosshair(): void {
  document.querySelectorAll<HTMLElement>(".xhair").forEach((node) => {
    node.hidden = true;
  });
  paintReadouts();
}

function syncCrosshair(clientX: number, clientY: number): void {
  if (chartDrag || resizeDrag) {
    clearCrosshair();
    return;
  }
  const hovered = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".chart-surface");
  const hoveredSvg = hovered?.querySelector("svg");
  if (!hovered || !hoveredSvg) {
    clearCrosshair();
    return;
  }
  const hoveredBox = svgMetrics(hoveredSvg);
  const hoveredRect = hoveredSvg.getBoundingClientRect();
  if (!hoveredBox || hoveredRect.width <= 0 || hoveredRect.height <= 0) {
    clearCrosshair();
    return;
  }
  const viewX = ((clientX - hoveredRect.left) / hoveredRect.width) * hoveredBox.width;
  const viewY = ((clientY - hoveredRect.top) / hoveredRect.height) * hoveredBox.height;
  const plotWidth = Math.max(hoveredBox.width - hoveredBox.left - hoveredBox.right, 1);
  const time = hoveredBox.t0 + ((viewX - hoveredBox.left) / plotWidth) * (hoveredBox.t1 - hoveredBox.t0);
  document.querySelectorAll<SVGSVGElement>(".candle-chart").forEach((svg) => {
    const surface = svg.closest<HTMLElement>(".chart-surface");
    const xhair = surface?.querySelector<HTMLElement>(".xhair");
    const box = svgMetrics(svg);
    if (!surface || !xhair || !box) return;
    const rect = svg.getBoundingClientRect();
    if (time < box.t0 || time > box.t1 || rect.width <= 0) {
      xhair.hidden = true;
      return;
    }
    const x = box.left + ((time - box.t0) / Math.max(box.t1 - box.t0, 1)) * (box.width - box.left - box.right);
    const pixelX = (x / box.width) * rect.width;
    xhair.hidden = false;
    const vertical = xhair.querySelector<HTMLElement>(".xhair-v");
    const horizontal = xhair.querySelector<HTMLElement>(".xhair-h");
    const price = xhair.querySelector<HTMLElement>(".xhair-price");
    const timeLabel = xhair.querySelector<HTMLElement>(".xhair-time");
    if (vertical) vertical.style.left = `${pixelX}px`;
    const isHovered = svg === hoveredSvg;
    const inPrice = viewY >= box.top && viewY <= box.bottom;
    if (horizontal) horizontal.hidden = !isHovered || !inPrice;
    if (price) price.hidden = !isHovered || !inPrice;
    if (isHovered && inPrice && horizontal && price) {
      const pixelY = (viewY / box.height) * rect.height;
      horizontal.style.top = `${pixelY}px`;
      const span = box.p1 - box.p0 || 1;
      const priceValue = box.p1 - ((viewY - box.top) / Math.max(box.bottom - box.top, 1)) * span;
      price.textContent = formatAxisPrice(priceValue, svg.dataset.kind === "contract" ? "contract" : "underlying");
      price.style.top = `${Math.max(0, pixelY - 8)}px`;
      price.style.right = "2px";
    }
    if (timeLabel) {
      timeLabel.textContent = formatAxisTime(time, box.t1 - box.t0);
      timeLabel.style.left = `${Math.min(Math.max(0, pixelX + 6), Math.max(0, rect.width - 78))}px`;
      timeLabel.style.bottom = "2px";
    }
  });
  if (hoveredSvg.dataset.kind === "underlying") paintReadouts({ candle: candleAt(time) });
  else paintReadouts({ trade: tradeAt(time) });
}

function setTerminalTab(tab: TerminalTab): void {
  state.terminalTab = tab;
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => {
    const on = button.dataset.tab === tab;
    button.classList.toggle("active", on);
    button.setAttribute("aria-selected", String(on));
  });
  const content = document.querySelector("#terminal-content");
  if (content) content.innerHTML = renderTerminalBody();
}

function applyBookPrice(raw: string): void {
  const normalized = normalizeContractPrice(raw);
  if (!normalized) {
    setStatusNote("That book level is not a valid limit price");
    return;
  }
  state.ticketPrice = normalized;
  state.ticketPriceTouched = true;
  const input = document.querySelector<HTMLInputElement>("#ticket-price");
  if (input) input.value = state.ticketPrice;
  updateTicketEstimates();
  refreshBook();
  setStatusNote(`Limit set to ${state.ticketPrice} from the book · not sent`);
}

function nudgeSplitter(edge: string | undefined, key: string): void {
  if (edge !== "watch" && edge !== "dock" && edge !== "terminal") return;
  const step = key === "ArrowLeft" || key === "ArrowUp" ? -16 : 16;
  if (edge === "watch") state.layout.watch = Math.min(520, Math.max(200, state.layout.watch + step));
  if (edge === "dock") state.layout.dock = Math.min(520, Math.max(250, state.layout.dock + (key === "ArrowLeft" ? 16 : -16)));
  if (edge === "terminal") state.layout.terminal = Math.min(420, Math.max(110, state.layout.terminal + (key === "ArrowUp" ? 16 : -16)));
  applyLayout();
  saveLayout();
  requestChartMeasure();
}

function resizeTo(edge: PaneName, start: number, origin: number, client: number): void {
  const delta = client - start;
  if (edge === "watch") state.layout.watch = Math.min(520, Math.max(200, origin + delta));
  if (edge === "dock") state.layout.dock = Math.min(520, Math.max(250, origin - delta));
  if (edge === "terminal") state.layout.terminal = Math.min(420, Math.max(110, origin - delta));
  applyLayout();
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
  const switchingMarket = activeMarketId !== marketId(market);
  if (switchingMarket) {
    activeMarketId = marketId(market);
    state.bookSide = 0;
    state.ticketAction = "buy";
    state.ticketPrice = "";
    state.ticketPriceTouched = false;
    state.underlyingZoom = 0;
    state.underlyingOffset = 0;
    state.statusNote = "";
  }
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

  if (errors.length > 0) {
    state.error = `Some market data did not load (${errors.join("; ")}).`;
    pushActivity(state.error, "warn");
  }
  seedTicketPrice();
  if (switchingMarket) {
    pushActivity(`Viewing ${marketTitle(market)} · ${sideName(market, 0)} ${market.sides[0]?.coin ?? ""} / ${sideName(market, 1)} ${market.sides[1]?.coin ?? ""}`, "info");
  }
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
    pushActivity("Connected to Hyperliquid mainnet public data", "ok");
    pushActivity(`Catalog loaded · ${state.markets.length} markets`, "info");

    unsubscribeAllMids = adapter.marketData.subscribeAllMids(updateAllMids);
    renderApp();
    if (currentMarket()) await loadSelectedMarket();
    else refreshMarketTiming();
  } catch (error) {
    state.loadingMarkets = false;
    state.connection = "error";
    state.error = `Could not connect to Outcome market data: ${errorMessage(error)}`;
    pushActivity(state.error, "error");
    renderApp();
  }
}

function applyChartAction(_kind: "underlying" | "contract" | "shared", action: string): void {
  const step = Math.max(1, visibleUnderlyingCandleCount() / 2);
  if (action === "zoom-in") state.underlyingZoom = Math.min(MAX_CHART_ZOOM, state.underlyingZoom + 1);
  if (action === "zoom-out") state.underlyingZoom = Math.max(0, state.underlyingZoom - 1);
  if (action === "older") state.underlyingOffset += step;
  if (action === "newer") state.underlyingOffset -= step;
  if (action === "reset") {
    state.underlyingZoom = 0;
    state.underlyingOffset = 0;
  }
  state.underlyingOffset = Math.max(0, Math.min(state.underlyingOffset, sharedView().maxOffset));
  refreshCharts();
}

document.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  const splitter = event.target.closest<HTMLElement>("[data-resize]");
  const edge = splitter?.dataset.resize;
  if (splitter && (edge === "watch" || edge === "dock" || edge === "terminal")) {
    resizeDrag = {
      edge,
      start: edge === "terminal" ? event.clientY : event.clientX,
      origin: edge === "watch" ? state.layout.watch : edge === "dock" ? state.layout.dock : state.layout.terminal,
    };
    splitter.classList.add("is-active");
    splitter.setPointerCapture?.(event.pointerId);
    return;
  }
  const surface = event.target.closest<HTMLElement>(".chart-surface[data-chart-kind]");
  const kind = surface?.dataset.chartKind;
  if (!surface || (kind !== "underlying" && kind !== "contract")) return;
  chartDrag = { kind, lastX: event.clientX };
  surface.classList.add("is-panning");
});

document.addEventListener("pointermove", (event) => {
  if (resizeDrag) {
    resizeTo(resizeDrag.edge, resizeDrag.start, resizeDrag.origin, resizeDrag.edge === "terminal" ? event.clientY : event.clientX);
    return;
  }
  if (chartDrag) {
    if ((event.buttons & 1) === 0) {
      chartDrag = null;
      refreshCharts();
      return;
    }
    const deltaX = event.clientX - chartDrag.lastX;
    chartDrag.lastX = event.clientX;
    if (deltaX !== 0) {
      const surface = document.querySelector<HTMLElement>(`.chart-surface[data-chart-kind="${chartDrag.kind}"]`);
      const width = surface?.clientWidth ?? 760;
      state.underlyingOffset += (deltaX / Math.max(width, 1)) * visibleUnderlyingCandleCount();
      state.underlyingOffset = Math.max(0, Math.min(state.underlyingOffset, sharedView().maxOffset));
      refreshCharts();
    }
    return;
  }
  const surface = event.target instanceof Element ? event.target.closest(".chart-surface") : null;
  if (!surface) {
    if (lastPointer) {
      lastPointer = null;
      clearCrosshair();
    }
    return;
  }
  lastPointer = { x: event.clientX, y: event.clientY };
  syncCrosshair(event.clientX, event.clientY);
});

const endDrag = () => {
  if (resizeDrag) {
    resizeDrag = null;
    document.querySelectorAll(".splitter.is-active").forEach((node) => node.classList.remove("is-active"));
    saveLayout();
    requestChartMeasure();
    pinBookToSpread();
  }
  if (!chartDrag) return;
  chartDrag = null;
  refreshCharts();
};
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", endDrag);

document.addEventListener("dblclick", (event) => {
  const splitter = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-resize]") : null;
  const edge = splitter?.dataset.resize;
  if (edge !== "watch" && edge !== "dock" && edge !== "terminal") return;
  state.panes[edge] = !state.panes[edge];
  saveLayout();
  applyLayout();
  syncPaneChecks();
  requestChartMeasure();
});

document.addEventListener("wheel", (event) => {
  if (!(event.target instanceof Element)) return;
  const surface = event.target.closest<HTMLElement>(".chart-surface[data-chart-kind]");
  const kind = surface?.dataset.chartKind;
  if (kind !== "underlying" && kind !== "contract") return;
  event.preventDefault();
  applyChartAction(kind, event.deltaY < 0 ? "zoom-in" : "zoom-out");
}, { passive: false });

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const menuButton = target.closest<HTMLElement>(".menu-button");
  if (menuButton) {
    const panel = menuButton.parentElement?.querySelector<HTMLElement>(".menu-panel");
    const open = menuButton.getAttribute("aria-expanded") === "true";
    closeMenus();
    if (!open && panel) {
      menuButton.setAttribute("aria-expanded", "true");
      panel.hidden = false;
    }
    return;
  }
  const backdrop = target.closest(".modal-backdrop");
  if (backdrop && event.target === backdrop) {
    closeOverlay();
    return;
  }
  const command = target.closest<HTMLElement>("[data-command]");
  if (command?.dataset.command) {
    runCommand(command.dataset.command, command);
    closeMenus();
    return;
  }
  if (!target.closest(".menu-panel")) closeMenus();

  const bookLevel = target.closest<HTMLElement>("[data-book-price]");
  if (bookLevel?.dataset.bookPrice) {
    applyBookPrice(bookLevel.dataset.bookPrice);
    return;
  }
  const sideButton = target.closest<HTMLElement>("[data-ticket-side]");
  if (sideButton?.dataset.ticketSide === "0" || sideButton?.dataset.ticketSide === "1") {
    setBookSide(Number(sideButton.dataset.ticketSide) as 0 | 1);
    return;
  }
  const actionButton = target.closest<HTMLElement>("[data-ticket-action]");
  if (actionButton?.dataset.ticketAction === "buy" || actionButton?.dataset.ticketAction === "sell") {
    setTicketAction(actionButton.dataset.ticketAction);
    return;
  }
  const tab = target.closest<HTMLElement>("[data-tab]");
  if (tab?.dataset.tab && TERMINAL_TABS.some((entry) => entry.id === tab.dataset.tab)) {
    setTerminalTab(tab.dataset.tab as TerminalTab);
    return;
  }
  const marketButton = target.closest<HTMLElement>("[data-market-id]");
  if (marketButton?.dataset.marketId) {
    const id = marketButton.dataset.marketId;
    const market = state.markets.find((entry) => marketId(entry) === id);
    if (market && marketId(market) !== state.selectedMarketId) {
      state.selectedMarketId = id;
      void loadSelectedMarket();
    }
    return;
  }
  const action = target.closest<HTMLElement>("[data-chart-action]");
  if (action?.dataset.chartAction) {
    const kind = action.dataset.chartKind;
    if (kind === "underlying" || kind === "contract") applyChartAction(kind, action.dataset.chartAction);
    return;
  }
  const intervalButton = target.closest<HTMLElement>("[data-interval]");
  if (intervalButton?.dataset.interval && INTERVALS.includes(intervalButton.dataset.interval as Interval)) {
    setSharedInterval(intervalButton.dataset.interval as Interval);
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.id === "ticket-price") {
    state.ticketPrice = target.value;
    state.ticketPriceTouched = true;
    updateTicketEstimates();
  } else if (target.id === "ticket-qty") {
    state.ticketQty = target.value;
    updateTicketEstimates();
  }
});

document.addEventListener("focusout", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.id !== "ticket-price") return;
  const normalized = normalizeContractPrice(target.value);
  if (!normalized) return;
  state.ticketPrice = normalized;
  state.ticketPriceTouched = true;
  target.value = normalized;
  updateTicketEstimates();
  refreshBook();
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  if (target.id === "selected-market") {
    state.selectedMarketId = target.value;
    if (currentMarket()) void loadSelectedMarket();
    return;
  }
  if (target.id === "ticket-tif" && (target.value === "Gtc" || target.value === "Ioc")) {
    state.ticketTif = target.value;
    updateTicketEstimates();
  }
});

document.addEventListener("keydown", (event) => {
  const typing = event.target instanceof HTMLElement && (event.target.matches("input, textarea, select") || event.target.isContentEditable);
  if (event.key === "Escape") {
    if (document.getElementById("overlay")) closeOverlay();
    closeMenus();
    return;
  }
  if (event.key === "/" && !typing) {
    event.preventDefault();
    document.getElementById("market-search")?.focus();
    return;
  }
  const split = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-resize]") : null;
  if (split && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown")) {
    event.preventDefault();
    nudgeSplitter(split.dataset.resize, event.key);
    return;
  }
  if (!typing && document.activeElement instanceof HTMLElement && document.activeElement.closest(".terminal-tabs") && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
    event.preventDefault();
    const index = TERMINAL_TABS.findIndex((tab) => tab.id === state.terminalTab);
    const next = TERMINAL_TABS[(index + (event.key === "ArrowRight" ? 1 : TERMINAL_TABS.length - 1)) % TERMINAL_TABS.length];
    setTerminalTab(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  }
});

window.addEventListener("beforeunload", () => {
  stopSelectedFeeds();
  unsubscribeAllMids?.();
  state.adapter?.destroy();
});

window.setInterval(refreshMarketTiming, 1000);
window.setInterval(() => refreshMarketRows(), 30_000);
initTheme();
void start();
