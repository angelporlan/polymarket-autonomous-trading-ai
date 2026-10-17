import { hashCanonical } from "../domain/proposals.js";
import {
  PUSD_SCALE,
  type OrderSide,
  type PriceLevel
} from "../domain/types.js";
import { SafeExternalServiceError } from "./safe-error.js";

export const POLYMARKET_MARKET_CHANNEL_URL =
  "wss://ws-subscriptions-clob.polymarket.com/ws/market";

const CONNECT_TIMEOUT_MS = 8_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 8_000;
const BOOK_WAIT_TIMEOUT_MS = 4_000;
const MAX_BOOK_RECEIPT_AGE_MS = 5_000;
const MAX_MESSAGE_LENGTH = 512 * 1024;
const MAX_PENDING_EVENTS = 1_000;
const MAX_SUBSCRIBED_TOKENS = 10;
const MAX_FUTURE_SKEW_MS = 5_000;

export interface MarketChannelBook {
  conditionId: string;
  tokenId: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
  sourceTimestampMs: number;
  receivedAtMs: number;
  channelGeneration: number;
  bookHash: string;
  tickSizeMicros: bigint | null;
}

export interface MarketChannelSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: unknown) => void): void;
  onError(handler: () => void): void;
  onClose(handler: () => void): void;
}

export type MarketChannelSocketFactory = (
  url: typeof POLYMARKET_MARKET_CHANNEL_URL
) => MarketChannelSocket;

export interface MarketChannelScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export type MarketChannelState =
  | "idle"
  | "connecting"
  | "running"
  | "failed"
  | "stopped";

export interface MarketChannelMonitorOptions {
  socketFactory?: MarketChannelSocketFactory;
  scheduler?: MarketChannelScheduler;
  now?: () => number;
  generation?: number;
  onFailure?: (error: SafeExternalServiceError) => void | Promise<void>;
}

interface BookWaiter {
  resolve: (book: MarketChannelBook | null) => void;
  timer: unknown;
}

/**
 * Maintains a bounded public market-channel view. It never treats the remote
 * book timestamp as the local receipt time: inactive markets can legitimately
 * retain an old source timestamp while a newly delivered initial book still
 * proves the channel and snapshot were observed now.
 */
export class PolymarketMarketChannelMonitor {
  private readonly socketFactory: MarketChannelSocketFactory;
  private readonly scheduler: MarketChannelScheduler;
  private readonly now: () => number;
  private readonly generation: number;
  private readonly onFailure: (
    error: SafeExternalServiceError
  ) => void | Promise<void>;
  private stateValue: MarketChannelState = "idle";
  private socket: MarketChannelSocket | null = null;
  private subscribedTokens = new Set<string>();
  private readonly books = new Map<string, MarketChannelBook>();
  private readonly resolvedTokens = new Set<string>();
  private readonly waiters = new Map<string, BookWaiter[]>();
  private connectTimer: unknown;
  private heartbeatTimer: unknown;
  private pongTimer: unknown;
  private awaitingPong = false;
  private lastPongAtMs: number | null = null;
  private pendingEventCount = 0;
  private eventChain: Promise<void> = Promise.resolve();
  private failureReported = false;
  private startResolve: (() => void) | null = null;
  private startReject:
    | ((error: SafeExternalServiceError) => void)
    | null = null;

  constructor(options: MarketChannelMonitorOptions = {}) {
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? Date.now;
    this.generation = options.generation ?? 1;
    this.onFailure = options.onFailure ?? (() => undefined);
  }

  async subscribe(tokenIds: string[]): Promise<void> {
    const normalized = validateTokenIds(tokenIds);
    if (this.stateValue === "failed" || this.stateValue === "stopped") {
      throw marketChannelError(
        "MARKET_CHANNEL_UNAVAILABLE",
        "The public market channel is not available."
      );
    }
    if (this.stateValue === "idle") {
      await this.start(normalized);
      return;
    }
    if (this.stateValue === "connecting") {
      throw marketChannelError(
        "MARKET_CHANNEL_CONNECTING",
        "The public market channel is still connecting."
      );
    }
    this.replaceSubscriptions(normalized);
  }

  async getFreshBook(
    tokenId: string,
    timeoutMs = BOOK_WAIT_TIMEOUT_MS
  ): Promise<MarketChannelBook | null> {
    const normalized = validateTokenId(tokenId);
    if (!this.subscribedTokens.has(normalized)) {
      throw new Error("The token is outside the market-channel subscription.");
    }
    const immediate = this.readFreshBook(normalized);
    if (immediate !== null || this.resolvedTokens.has(normalized)) {
      return immediate;
    }
    if (this.stateValue !== "running") {
      throw marketChannelError(
        "MARKET_CHANNEL_UNAVAILABLE",
        "The public market channel is not healthy."
      );
    }
    const boundedTimeout = Math.max(1, Math.min(8_000, Math.floor(timeoutMs)));
    return new Promise<MarketChannelBook | null>((resolve) => {
      const waiter: BookWaiter = {
        resolve,
        timer: this.scheduler.schedule(() => {
          this.removeWaiter(normalized, waiter);
          resolve(null);
        }, boundedTimeout)
      };
      const existing = this.waiters.get(normalized) ?? [];
      existing.push(waiter);
      this.waiters.set(normalized, existing);
    });
  }

  status(): {
    state: MarketChannelState;
    generation: number;
    awaitingPong: boolean;
    subscribedTokenCount: number;
    freshBookCount: number;
    lastPongAtMs: number | null;
  } {
    let freshBookCount = 0;
    for (const tokenId of this.subscribedTokens) {
      if (this.readFreshBook(tokenId) !== null) freshBookCount += 1;
    }
    return {
      state: this.stateValue,
      generation: this.generation,
      awaitingPong: this.awaitingPong,
      subscribedTokenCount: this.subscribedTokens.size,
      freshBookCount,
      lastPongAtMs: this.lastPongAtMs
    };
  }

  stop(): void {
    if (this.stateValue === "stopped") return;
    const wasConnecting = this.stateValue === "connecting";
    this.stateValue = "stopped";
    this.clearTimers();
    this.resolveAllWaiters(null);
    this.books.clear();
    this.resolvedTokens.clear();
    this.subscribedTokens.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) safeClose(socket, 1_000, "local-stop");
    if (wasConnecting) {
      this.rejectStart(
        marketChannelError(
          "MARKET_CHANNEL_STOPPED",
          "The public market channel stopped before connecting."
        )
      );
    }
  }

  private start(tokenIds: string[]): Promise<void> {
    requireCurrentTime(this.now());
    this.stateValue = "connecting";
    this.subscribedTokens = new Set(tokenIds);
    const started = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
    try {
      const socket = this.socketFactory(POLYMARKET_MARKET_CHANNEL_URL);
      this.socket = socket;
      socket.onOpen(() => this.handleOpen());
      socket.onMessage((data) => this.handleMessage(data));
      socket.onError(() => {
        this.fail(
          marketChannelError(
            "MARKET_CHANNEL_SOCKET_ERROR",
            "The public market channel reported a socket error."
          )
        );
      });
      socket.onClose(() => {
        if (this.stateValue === "connecting" || this.stateValue === "running") {
          this.fail(
            marketChannelError(
              "MARKET_CHANNEL_UNEXPECTED_CLOSE",
              "The public market channel closed unexpectedly."
            )
          );
        }
      });
      this.connectTimer = this.scheduler.schedule(() => {
        this.connectTimer = undefined;
        if (this.stateValue === "connecting") {
          this.fail(
            marketChannelError(
              "MARKET_CHANNEL_CONNECT_TIMEOUT",
              "The public market channel did not connect in time."
            )
          );
        }
      }, CONNECT_TIMEOUT_MS);
    } catch {
      this.fail(
        marketChannelError(
          "MARKET_CHANNEL_CONNECT_FAILED",
          "The public market channel could not be created."
        )
      );
    }
    return started;
  }

  private handleOpen(): void {
    if (this.stateValue !== "connecting") return;
    const socket = this.socket;
    if (socket === null) {
      this.fail(
        marketChannelError(
          "MARKET_CHANNEL_SUBSCRIPTION_FAILED",
          "The public market-channel subscription was unavailable."
        )
      );
      return;
    }
    this.cancelTimer("connect");
    try {
      socket.send(JSON.stringify({
        assets_ids: [...this.subscribedTokens],
        type: "market",
        custom_feature_enabled: true
      }));
      socket.send("PING");
      this.awaitingPong = true;
      this.pongTimer = this.scheduler.schedule(() => {
        this.pongTimer = undefined;
        if (this.stateValue === "running" && this.awaitingPong) {
          this.fail(
            marketChannelError(
              "MARKET_CHANNEL_PONG_TIMEOUT",
              "The public market channel did not prove liveness."
            )
          );
        }
      }, PONG_TIMEOUT_MS);
      this.stateValue = "running";
    } catch {
      this.fail(
        marketChannelError(
          "MARKET_CHANNEL_SUBSCRIPTION_FAILED",
          "The public market-channel subscription could not be sent."
        )
      );
    }
  }

  private replaceSubscriptions(tokenIds: string[]): void {
    const socket = this.socket;
    if (socket === null || this.stateValue !== "running") {
      throw marketChannelError(
        "MARKET_CHANNEL_UNAVAILABLE",
        "The public market channel is not healthy."
      );
    }
    const next = new Set(tokenIds);
    const removed = [...this.subscribedTokens].filter((token) => !next.has(token));
    const added = tokenIds.filter((token) => !this.subscribedTokens.has(token));
    try {
      if (removed.length > 0) {
        socket.send(JSON.stringify({ assets_ids: removed, operation: "unsubscribe" }));
      }
      if (added.length > 0) {
        socket.send(JSON.stringify({ assets_ids: added, operation: "subscribe" }));
      }
    } catch {
      this.fail(
        marketChannelError(
          "MARKET_CHANNEL_SUBSCRIPTION_FAILED",
          "The public market-channel subscription could not be updated."
        )
      );
      throw marketChannelError(
        "MARKET_CHANNEL_SUBSCRIPTION_FAILED",
        "The public market-channel subscription could not be updated."
      );
    }
    for (const token of removed) {
      this.books.delete(token);
      this.resolvedTokens.delete(token);
      this.resolveWaiters(token, null);
    }
    this.subscribedTokens = next;
  }

  private handleMessage(data: unknown): void {
    if (this.stateValue !== "running") return;
    if (typeof data !== "string" || data.length > MAX_MESSAGE_LENGTH) {
      this.fail(malformedChannelMessage());
      return;
    }
    let receivedAtMs: number;
    try {
      receivedAtMs = requireCurrentTime(this.now());
    } catch {
      this.fail(
        marketChannelError(
          "MARKET_CHANNEL_CLOCK_INVALID",
          "The local clock is invalid for public market data."
        )
      );
      return;
    }
    if (data === "PONG") {
      if (!this.awaitingPong) {
        this.fail(
          marketChannelError(
            "MARKET_CHANNEL_UNEXPECTED_PONG",
            "The public market channel returned an unexpected heartbeat."
          )
        );
        return;
      }
      this.awaitingPong = false;
      this.lastPongAtMs = receivedAtMs;
      this.cancelTimer("pong");
      const resolve = this.startResolve;
      this.startResolve = null;
      this.startReject = null;
      resolve?.();
      this.resolveFreshWaiters();
      this.scheduleHeartbeat();
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(data) as unknown;
    } catch {
      this.fail(malformedChannelMessage());
      return;
    }
    const events = Array.isArray(decoded) ? decoded : [decoded];
    if (events.length === 0 || events.length > MAX_SUBSCRIBED_TOKENS) {
      this.fail(malformedChannelMessage());
      return;
    }
    for (const value of events) this.enqueueEvent(value, receivedAtMs);
  }

  private enqueueEvent(value: unknown, receivedAtMs: number): void {
    this.pendingEventCount += 1;
    if (this.pendingEventCount > MAX_PENDING_EVENTS) {
      this.pendingEventCount -= 1;
      this.fail(
        marketChannelError(
          "MARKET_CHANNEL_BACKPRESSURE",
          "The public market channel exceeded its safe event backlog."
        )
      );
      return;
    }
    const operation = this.eventChain.then(() => {
      if (this.stateValue === "running") {
        this.applyEvent(value, receivedAtMs);
      }
    });
    this.eventChain = operation
      .catch(() => {
        if (this.stateValue === "running") this.fail(malformedChannelMessage());
      })
      .finally(() => {
        this.pendingEventCount -= 1;
      });
  }

  private applyEvent(value: unknown, receivedAtMs: number): void {
    const event = requireRecord(value);
    const eventType = requireString(event.event_type, 100);
    if (eventType === "book") {
      const conditionId = requireConditionId(event.market);
      const tokenId = this.requireSubscribedToken(event.asset_id);
      const sourceTimestampMs = requireRemoteTimestamp(event.timestamp, receivedAtMs);
      const bids = parseLevels(event.bids, "BUY");
      const asks = parseLevels(event.asks, "SELL");
      const previous = this.books.get(tokenId);
      assertMonotonicTimestamp(previous, sourceTimestampMs);
      const bookHash = readBookHash(event.hash, conditionId, tokenId, bids, asks);
      const book: MarketChannelBook = {
        conditionId,
        tokenId,
        bids,
        asks,
        sourceTimestampMs,
        receivedAtMs,
        channelGeneration: this.generation,
        bookHash,
        tickSizeMicros: previous?.tickSizeMicros ?? null
      };
      assertBookNotCrossed(book);
      this.books.set(tokenId, book);
      this.resolvedTokens.delete(tokenId);
      this.resolveWaiters(tokenId, this.readFreshBook(tokenId));
      return;
    }
    if (eventType === "price_change") {
      const conditionId = requireConditionId(event.market);
      const sourceTimestampMs = requireRemoteTimestamp(event.timestamp, receivedAtMs);
      if (!Array.isArray(event.price_changes) || event.price_changes.length === 0 || event.price_changes.length > 100) {
        throw new Error("Invalid price-change list.");
      }
      for (const rawChange of event.price_changes) {
        const change = requireRecord(rawChange);
        const tokenId = this.requireSubscribedToken(change.asset_id);
        const previous = this.books.get(tokenId);
        if (previous === undefined) continue;
        if (previous.conditionId !== conditionId) throw new Error("Market identity changed.");
        assertMonotonicTimestamp(previous, sourceTimestampMs);
        const side = requireSide(change.side);
        const priceMicros = requireDecimalMicros(change.price, true);
        const sizeMicros = requireDecimalMicros(change.size, false);
        const bids = previous.bids.map((level) => ({ ...level }));
        const asks = previous.asks.map((level) => ({ ...level }));
        updateLevel(side === "BUY" ? bids : asks, priceMicros, sizeMicros, side);
        const book: MarketChannelBook = {
          ...previous,
          bids,
          asks,
          sourceTimestampMs,
          receivedAtMs,
          bookHash: readBookHash(change.hash, conditionId, tokenId, bids, asks)
        };
        assertBookNotCrossed(book);
        assertOptionalTopOfBook(change, book);
        this.books.set(tokenId, book);
        this.resolveWaiters(tokenId, this.readFreshBook(tokenId));
      }
      return;
    }
    if (eventType === "best_bid_ask") {
      const tokenId = this.requireSubscribedToken(event.asset_id);
      const book = this.books.get(tokenId);
      if (book === undefined) return;
      if (book.conditionId !== requireConditionId(event.market)) {
        throw new Error("Market identity changed.");
      }
      const timestamp = requireRemoteTimestamp(event.timestamp, receivedAtMs);
      assertMonotonicTimestamp(book, timestamp);
      assertOptionalTopOfBook(event, book);
      this.books.set(tokenId, {
        ...book,
        sourceTimestampMs: timestamp,
        receivedAtMs
      });
      this.resolveWaiters(tokenId, this.readFreshBook(tokenId));
      return;
    }
    if (eventType === "tick_size_change") {
      const tokenId = this.requireSubscribedToken(event.asset_id);
      const book = this.books.get(tokenId);
      const timestamp = requireRemoteTimestamp(event.timestamp, receivedAtMs);
      const nextTick = requireDecimalMicros(event.new_tick_size, true);
      if (PUSD_SCALE % nextTick !== 0n) throw new Error("Invalid tick size.");
      if (book !== undefined) {
        assertMonotonicTimestamp(book, timestamp);
        const oldTick = event.old_tick_size === undefined
          ? null
          : requireDecimalMicros(event.old_tick_size, true);
        if (oldTick !== null && book.tickSizeMicros !== null && oldTick !== book.tickSizeMicros) {
          throw new Error("Tick-size history is inconsistent.");
        }
        this.books.set(tokenId, {
          ...book,
          tickSizeMicros: nextTick,
          sourceTimestampMs: timestamp,
          receivedAtMs,
          bookHash: hashCanonical({
            priorBookHash: book.bookHash,
            tickSizeMicros: nextTick,
            sourceTimestampMs: timestamp
          })
        });
        this.resolveWaiters(tokenId, this.readFreshBook(tokenId));
      }
      return;
    }
    if (eventType === "market_resolved") {
      requireConditionId(event.market);
      const assets = event.assets_ids;
      if (!Array.isArray(assets) || assets.length === 0 || assets.length > 10) {
        throw new Error("Invalid resolved-market token list.");
      }
      for (const rawToken of assets) {
        const tokenId = validateTokenId(requireString(rawToken, 100));
        if (this.subscribedTokens.has(tokenId)) {
          this.books.delete(tokenId);
          this.resolvedTokens.add(tokenId);
          this.resolveWaiters(tokenId, null);
        }
      }
      return;
    }
    if (eventType === "last_trade_price" || eventType === "new_market") {
      return;
    }
    throw new Error("Unsupported market-channel event.");
  }

  private requireSubscribedToken(value: unknown): string {
    const tokenId = validateTokenId(requireString(value, 100));
    if (!this.subscribedTokens.has(tokenId)) {
      throw new Error("Market-channel event is outside the subscription.");
    }
    return tokenId;
  }

  private readFreshBook(tokenId: string): MarketChannelBook | null {
    const book = this.books.get(tokenId);
    if (
      book === undefined ||
      this.stateValue !== "running" ||
      this.lastPongAtMs === null ||
      this.now() - book.receivedAtMs > MAX_BOOK_RECEIPT_AGE_MS ||
      this.now() - this.lastPongAtMs > HEARTBEAT_INTERVAL_MS + PONG_TIMEOUT_MS ||
      book.bids.length === 0 ||
      book.asks.length === 0
    ) {
      return null;
    }
    return cloneBook(book);
  }

  private scheduleHeartbeat(): void {
    if (this.stateValue !== "running" || this.awaitingPong) return;
    this.cancelTimer("heartbeat");
    this.heartbeatTimer = this.scheduler.schedule(() => {
      this.heartbeatTimer = undefined;
      if (this.stateValue !== "running") return;
      const socket = this.socket;
      if (socket === null) {
        this.fail(
          marketChannelError(
            "MARKET_CHANNEL_HEARTBEAT_FAILED",
            "The public market channel lost its heartbeat socket."
          )
        );
        return;
      }
      try {
        socket.send("PING");
      } catch {
        this.fail(
          marketChannelError(
            "MARKET_CHANNEL_HEARTBEAT_FAILED",
            "The public market-channel heartbeat could not be sent."
          )
        );
        return;
      }
      this.awaitingPong = true;
      this.pongTimer = this.scheduler.schedule(() => {
        this.pongTimer = undefined;
        if (this.stateValue === "running" && this.awaitingPong) {
          this.fail(
            marketChannelError(
              "MARKET_CHANNEL_PONG_TIMEOUT",
              "The public market channel missed its heartbeat response."
            )
          );
        }
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private resolveFreshWaiters(): void {
    for (const tokenId of this.waiters.keys()) {
      const book = this.readFreshBook(tokenId);
      if (book !== null) this.resolveWaiters(tokenId, book);
    }
  }

  private resolveWaiters(tokenId: string, book: MarketChannelBook | null): void {
    const waiters = this.waiters.get(tokenId);
    if (waiters === undefined) return;
    this.waiters.delete(tokenId);
    for (const waiter of waiters) {
      this.scheduler.cancel(waiter.timer);
      waiter.resolve(book === null ? null : cloneBook(book));
    }
  }

  private resolveAllWaiters(book: null): void {
    for (const tokenId of [...this.waiters.keys()]) {
      this.resolveWaiters(tokenId, book);
    }
  }

  private removeWaiter(tokenId: string, waiter: BookWaiter): void {
    const current = this.waiters.get(tokenId);
    if (current === undefined) return;
    const next = current.filter((candidate) => candidate !== waiter);
    if (next.length === 0) this.waiters.delete(tokenId);
    else this.waiters.set(tokenId, next);
  }

  private fail(error: SafeExternalServiceError): void {
    if (this.stateValue === "failed" || this.stateValue === "stopped") return;
    this.stateValue = "failed";
    this.clearTimers();
    this.resolveAllWaiters(null);
    this.books.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) safeClose(socket, 1_008, "market-channel-safety-failure");
    this.rejectStart(error);
    if (!this.failureReported) {
      this.failureReported = true;
      try {
        void Promise.resolve(this.onFailure(error)).catch(() => undefined);
      } catch {
        // Callback errors are deliberately suppressed and never exposed.
      }
    }
  }

  private rejectStart(error: SafeExternalServiceError): void {
    const reject = this.startReject;
    this.startResolve = null;
    this.startReject = null;
    reject?.(error);
  }

  private clearTimers(): void {
    this.cancelTimer("connect");
    this.cancelTimer("heartbeat");
    this.cancelTimer("pong");
    this.awaitingPong = false;
  }

  private cancelTimer(timer: "connect" | "heartbeat" | "pong"): void {
    const handle = timer === "connect"
      ? this.connectTimer
      : timer === "heartbeat"
        ? this.heartbeatTimer
        : this.pongTimer;
    if (handle !== undefined) this.scheduler.cancel(handle);
    if (timer === "connect") this.connectTimer = undefined;
    else if (timer === "heartbeat") this.heartbeatTimer = undefined;
    else this.pongTimer = undefined;
  }
}

function validateTokenIds(values: string[]): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_SUBSCRIBED_TOKENS) {
    throw new Error("One to ten market-channel token IDs are required.");
  }
  const normalized = values.map(validateTokenId);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Market-channel token IDs must be unique.");
  }
  return normalized;
}

function validateTokenId(value: string): string {
  const normalized = value.trim();
  if (!/^\d{1,80}$/u.test(normalized)) {
    throw new Error("Invalid market-channel token ID.");
  }
  return normalized;
}

function requireConditionId(value: unknown): string {
  const conditionId = requireString(value, 66).toLowerCase();
  if (!/^0x[a-f0-9]{64}$/u.test(conditionId)) {
    throw new Error("Invalid market-channel condition ID.");
  }
  return conditionId;
}

function requireString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error("Invalid market-channel string.");
  }
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid market-channel record.");
  }
  return value as Record<string, unknown>;
}

function requireSide(value: unknown): OrderSide {
  if (value !== "BUY" && value !== "SELL") {
    throw new Error("Invalid market-channel side.");
  }
  return value;
}

function requireRemoteTimestamp(value: unknown, nowMs: number): number {
  let timestampMs: number;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    timestampMs = value < 10_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === "string" && /^\d{1,16}$/u.test(value)) {
    const parsed = Number(value);
    timestampMs = parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
  } else {
    throw new Error("Invalid market-channel timestamp.");
  }
  if (
    !Number.isSafeInteger(timestampMs) ||
    timestampMs <= 0 ||
    timestampMs > nowMs + MAX_FUTURE_SKEW_MS
  ) {
    throw new Error("Invalid market-channel timestamp.");
  }
  return timestampMs;
}

function requireDecimalMicros(value: unknown, price: boolean): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(value)) {
    throw new Error("Invalid market-channel decimal.");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const micros = BigInt(whole) * PUSD_SCALE + BigInt(fraction.padEnd(6, "0"));
  if ((price && (micros <= 0n || micros > PUSD_SCALE)) || (!price && micros < 0n)) {
    throw new Error("Market-channel decimal is outside its bounds.");
  }
  return micros;
}

function parseLevels(value: unknown, side: OrderSide): PriceLevel[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error("Invalid market-channel book levels.");
  }
  const levels = value.map((raw) => {
    const record = requireRecord(raw);
    return {
      priceMicros: requireDecimalMicros(record.price, true),
      sharesMicros: requireDecimalMicros(record.size, false)
    };
  }).filter((level) => level.sharesMicros > 0n);
  const prices = new Set(levels.map((level) => level.priceMicros.toString()));
  if (prices.size !== levels.length) throw new Error("Duplicate book price.");
  levels.sort((left, right) => side === "BUY"
    ? compareBigInt(right.priceMicros, left.priceMicros)
    : compareBigInt(left.priceMicros, right.priceMicros));
  return levels;
}

function updateLevel(
  levels: PriceLevel[],
  priceMicros: bigint,
  sharesMicros: bigint,
  side: OrderSide
): void {
  const index = levels.findIndex((level) => level.priceMicros === priceMicros);
  if (sharesMicros === 0n) {
    if (index >= 0) levels.splice(index, 1);
  } else if (index >= 0) {
    levels[index] = { priceMicros, sharesMicros };
  } else {
    levels.push({ priceMicros, sharesMicros });
  }
  levels.sort((left, right) => side === "BUY"
    ? compareBigInt(right.priceMicros, left.priceMicros)
    : compareBigInt(left.priceMicros, right.priceMicros));
}

function assertBookNotCrossed(book: MarketChannelBook): void {
  const bid = book.bids[0]?.priceMicros;
  const ask = book.asks[0]?.priceMicros;
  if (bid !== undefined && ask !== undefined && bid > ask) {
    throw new Error("The market-channel book is crossed.");
  }
}

function assertOptionalTopOfBook(
  value: Record<string, unknown>,
  book: MarketChannelBook
): void {
  if (value.best_bid !== undefined) {
    const reportedBid = requireDecimalMicros(value.best_bid, true);
    if (book.bids[0]?.priceMicros !== reportedBid) {
      throw new Error("Market-channel best bid is inconsistent.");
    }
  }
  if (value.best_ask !== undefined) {
    const reportedAsk = requireDecimalMicros(value.best_ask, true);
    if (book.asks[0]?.priceMicros !== reportedAsk) {
      throw new Error("Market-channel best ask is inconsistent.");
    }
  }
}

function readBookHash(
  value: unknown,
  conditionId: string,
  tokenId: string,
  bids: PriceLevel[],
  asks: PriceLevel[]
): string {
  if (value !== undefined && value !== null) {
    const remote = requireString(value, 256);
    if (!/^(?:0x)?[a-fA-F0-9]{8,256}$/u.test(remote)) {
      throw new Error("Invalid market-channel book hash.");
    }
    return remote.toLowerCase();
  }
  return hashCanonical({ conditionId, tokenId, bids, asks });
}

function assertMonotonicTimestamp(
  previous: MarketChannelBook | undefined,
  nextTimestampMs: number
): void {
  if (previous !== undefined && nextTimestampMs < previous.sourceTimestampMs) {
    throw new Error("Market-channel timestamps are out of order.");
  }
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cloneBook(book: MarketChannelBook): MarketChannelBook {
  return {
    ...book,
    bids: book.bids.map((level) => ({ ...level })),
    asks: book.asks.map((level) => ({ ...level }))
  };
}

function requireCurrentTime(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("A valid current timestamp is required.");
  }
  return value;
}

function malformedChannelMessage(): SafeExternalServiceError {
  return marketChannelError(
    "MARKET_CHANNEL_MALFORMED_MESSAGE",
    "The public market channel returned an invalid event."
  );
}

function marketChannelError(
  code: string,
  message: string
): SafeExternalServiceError {
  return new SafeExternalServiceError(message, {
    code,
    service: "clob",
    retryable: false
  });
}

function safeClose(
  socket: MarketChannelSocket,
  code: number,
  reason: string
): void {
  try {
    socket.close(code, reason);
  } catch {
    // The state transition is authoritative even if the socket cannot close.
  }
}

const defaultScheduler: MarketChannelScheduler = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  cancel(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  }
};

const defaultSocketFactory: MarketChannelSocketFactory = (url) => {
  const socket = new WebSocket(url);
  return {
    send(data) {
      socket.send(data);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    onOpen(handler) {
      socket.addEventListener("open", handler);
    },
    onMessage(handler) {
      socket.addEventListener("message", (event) => handler(event.data));
    },
    onError(handler) {
      socket.addEventListener("error", handler);
    },
    onClose(handler) {
      socket.addEventListener("close", handler);
    }
  };
};
