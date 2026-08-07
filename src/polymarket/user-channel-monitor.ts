import {
  PUSD_SCALE,
  type OrderSide
} from "../domain/types.js";
import { SafeExternalServiceError } from "./safe-error.js";

export const POLYMARKET_USER_CHANNEL_URL =
  "wss://ws-subscriptions-clob.polymarket.com/ws/user";

const CONNECT_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_LENGTH = 256 * 1024;
const MAX_PENDING_EVENTS = 1_000;
const MAX_FUTURE_SKEW_MS = 5_000;

export interface UserChannelCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export interface UserChannelMakerOrder {
  tokenId: string;
  orderId: string;
  makerAddress: string;
  side: OrderSide;
  matchedSizeMicros: bigint;
  priceMicros: bigint;
  feeRateBps: number;
  outcome: string;
}

export interface UserChannelTradeEvent {
  kind: "trade";
  tradeId: string;
  conditionId: string;
  tokenId: string;
  side: OrderSide;
  sizeMicros: bigint;
  priceMicros: bigint;
  feeRateBps: number;
  status: "MATCHED" | "MINED" | "CONFIRMED" | "RETRYING" | "FAILED";
  takerOrderId: string;
  makerAddress: string;
  transactionHash: string | null;
  bucketIndex: number;
  traderSide: "TAKER" | "MAKER";
  makerOrders: UserChannelMakerOrder[];
  matchTimeMs: number;
  timestampMs: number;
  lastUpdateMs: number;
}

export interface UserChannelOrderEvent {
  kind: "order";
  orderId: string;
  conditionId: string;
  tokenId: string;
  side: OrderSide;
  originalSizeMicros: bigint;
  sizeMatchedMicros: bigint;
  priceMicros: bigint;
  makerAddress: string;
  createdAtMs: number;
  expirationEpochSeconds: number;
  orderType: "GTD";
  status: "LIVE" | "MATCHED" | "CANCELLED" | "EXPIRED";
  lifecycle: "PLACEMENT" | "UPDATE" | "CANCELLATION";
  associatedTradeIds: string[];
  timestampMs: number;
}

export type UserChannelEvent =
  | UserChannelTradeEvent
  | UserChannelOrderEvent;

export interface UserChannelSocket {
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: unknown) => void): void;
  onError(handler: () => void): void;
  onClose(handler: () => void): void;
}

export type UserChannelSocketFactory = (
  url: typeof POLYMARKET_USER_CHANNEL_URL
) => UserChannelSocket;

export interface UserChannelScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface UserChannelMonitorOptions {
  socketFactory?: UserChannelSocketFactory;
  scheduler?: UserChannelScheduler;
  now?: () => number;
  onEvent: (event: UserChannelEvent) => void | Promise<void>;
  onFailure: (
    error: SafeExternalServiceError
  ) => void | Promise<void>;
}

export type UserChannelMonitorState =
  | "idle"
  | "connecting"
  | "running"
  | "failed"
  | "stopped";

export class PolymarketUserChannelMonitor {
  private readonly socketFactory: UserChannelSocketFactory;
  private readonly scheduler: UserChannelScheduler;
  private readonly now: () => number;
  private stateValue: UserChannelMonitorState = "idle";
  private socket: UserChannelSocket | null = null;
  private subscribedMarkets = new Set<string>();
  private pendingSubscription: Uint8Array<ArrayBuffer> | null = null;
  private connectTimer: unknown;
  private heartbeatTimer: unknown;
  private pongTimer: unknown;
  private awaitingPong = false;
  private failureReported = false;
  private pendingEventCount = 0;
  private eventChain: Promise<void> = Promise.resolve();
  private startResolve: (() => void) | null = null;
  private startReject:
    | ((error: SafeExternalServiceError) => void)
    | null = null;
  private lastMessageAtMs: number | null = null;

  constructor(private readonly options: UserChannelMonitorOptions) {
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? Date.now;
  }

  start(
    credentials: UserChannelCredentials,
    markets: string[]
  ): Promise<void> {
    if (this.stateValue !== "idle") {
      throw new Error("A user-channel monitor instance can only be started once.");
    }
    requireCurrentTime(this.now());
    const normalizedMarkets = validateMarkets(markets);
    validateCredentials(credentials);

    this.stateValue = "connecting";
    this.subscribedMarkets = new Set(normalizedMarkets);
    this.pendingSubscription = encodeSubscription(
      credentials,
      normalizedMarkets
    );

    const started = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });

    try {
      const socket = this.socketFactory(POLYMARKET_USER_CHANNEL_URL);
      this.socket = socket;
      socket.onOpen(() => {
        this.handleOpen();
      });
      socket.onMessage((data) => {
        this.handleMessage(data);
      });
      socket.onError(() => {
        this.fail(
          channelError(
            "USER_CHANNEL_SOCKET_ERROR",
            "The authenticated user channel reported a socket error."
          )
        );
      });
      socket.onClose(() => {
        if (
          this.stateValue === "connecting" ||
          this.stateValue === "running"
        ) {
          this.fail(
            channelError(
              "USER_CHANNEL_UNEXPECTED_CLOSE",
              "The authenticated user channel closed unexpectedly."
            )
          );
        }
      });
      this.connectTimer = this.scheduler.schedule(() => {
        this.connectTimer = undefined;
        if (this.stateValue === "connecting") {
          this.fail(
            channelError(
              "USER_CHANNEL_CONNECT_TIMEOUT",
              "The authenticated user channel did not connect in time."
            )
          );
        }
      }, CONNECT_TIMEOUT_MS);
    } catch {
      this.fail(
        channelError(
          "USER_CHANNEL_CONNECT_FAILED",
          "The authenticated user channel could not be created."
        )
      );
    }

    return started;
  }

  stop(): void {
    if (this.stateValue === "stopped") {
      return;
    }
    const wasConnecting = this.stateValue === "connecting";
    this.stateValue = "stopped";
    this.clearTimers();
    this.clearPendingSubscription();
    this.subscribedMarkets.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      safeClose(socket, 1_000, "local-stop");
    }
    if (wasConnecting) {
      this.rejectStart(
        channelError(
          "USER_CHANNEL_STOPPED",
          "The authenticated user channel was stopped before connecting."
        )
      );
    }
    this.startResolve = null;
    this.startReject = null;
  }

  status(): {
    state: UserChannelMonitorState;
    awaitingPong: boolean;
    subscribedMarketCount: number;
    pendingEventCount: number;
    lastMessageAtMs: number | null;
  } {
    return {
      state: this.stateValue,
      awaitingPong: this.awaitingPong,
      subscribedMarketCount: this.subscribedMarkets.size,
      pendingEventCount: this.pendingEventCount,
      lastMessageAtMs: this.lastMessageAtMs
    };
  }

  private handleOpen(): void {
    if (this.stateValue !== "connecting") {
      return;
    }
    const socket = this.socket;
    const subscription = this.pendingSubscription;
    if (socket === null || subscription === null) {
      this.fail(
        channelError(
          "USER_CHANNEL_SUBSCRIPTION_UNAVAILABLE",
          "The authenticated user-channel subscription was unavailable."
        )
      );
      return;
    }

    this.cancelTimer("connect");
    try {
      socket.send(subscription);
    } catch {
      this.fail(
        channelError(
          "USER_CHANNEL_SUBSCRIPTION_FAILED",
          "The authenticated user-channel subscription could not be sent."
        )
      );
      return;
    } finally {
      this.clearPendingSubscription();
    }

    this.stateValue = "running";
    try {
      socket.send("PING");
      this.awaitingPong = true;
      this.pongTimer = this.scheduler.schedule(() => {
        this.pongTimer = undefined;
        if (this.stateValue === "running" && this.awaitingPong) {
          this.fail(
            channelError(
              "USER_CHANNEL_PONG_TIMEOUT",
              "The authenticated user channel did not prove liveness after subscription."
            )
          );
        }
      }, PONG_TIMEOUT_MS);
    } catch {
      this.fail(
        channelError(
          "USER_CHANNEL_HEARTBEAT_FAILED",
          "The authenticated user-channel liveness probe could not be sent."
        )
      );
    }
  }

  private handleMessage(data: unknown): void {
    if (this.stateValue !== "running") {
      return;
    }
    if (typeof data !== "string" || data.length > MAX_MESSAGE_LENGTH) {
      this.fail(
        channelError(
          "USER_CHANNEL_MALFORMED_MESSAGE",
          "The authenticated user channel returned a malformed message."
        )
      );
      return;
    }
    let receivedAtMs: number;
    try {
      receivedAtMs = requireCurrentTime(this.now());
    } catch {
      this.fail(
        channelError(
          "USER_CHANNEL_CLOCK_INVALID",
          "The local clock is invalid for authenticated user-channel reconciliation."
        )
      );
      return;
    }

    if (data === "PONG") {
      if (!this.awaitingPong) {
        this.fail(
          channelError(
            "USER_CHANNEL_UNEXPECTED_PONG",
            "The authenticated user channel returned an unexpected heartbeat."
          )
        );
        return;
      }
      this.awaitingPong = false;
      this.cancelTimer("pong");
      this.lastMessageAtMs = receivedAtMs;
      const resolve = this.startResolve;
      this.startResolve = null;
      this.startReject = null;
      resolve?.();
      this.scheduleHeartbeat();
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(data) as unknown;
    } catch {
      this.fail(
        channelError(
          "USER_CHANNEL_MALFORMED_MESSAGE",
          "The authenticated user channel returned invalid JSON."
        )
      );
      return;
    }

    let event: UserChannelEvent;
    try {
      event = parseUserChannelEvent(
        value,
        this.subscribedMarkets,
        receivedAtMs
      );
    } catch {
      this.fail(
        channelError(
          "USER_CHANNEL_MALFORMED_MESSAGE",
          "The authenticated user channel returned an invalid event."
        )
      );
      return;
    }
    this.lastMessageAtMs = receivedAtMs;
    this.enqueueEvent(event);
  }

  private enqueueEvent(event: UserChannelEvent): void {
    this.pendingEventCount += 1;
    if (this.pendingEventCount > MAX_PENDING_EVENTS) {
      this.pendingEventCount -= 1;
      this.fail(
        channelError(
          "USER_CHANNEL_BACKPRESSURE",
          "The authenticated user channel exceeded its safe event backlog."
        )
      );
      return;
    }

    const operation = this.eventChain.then(async () => {
      if (this.stateValue === "running") {
        await this.options.onEvent(event);
      }
    });
    this.eventChain = operation
      .catch(() => {
        if (this.stateValue === "running") {
          this.fail(
            channelError(
              "USER_CHANNEL_EVENT_HANDLER_FAILED",
              "The authenticated user-channel event could not be reconciled."
            )
          );
        }
      })
      .finally(() => {
        this.pendingEventCount -= 1;
      });
  }

  private scheduleHeartbeat(): void {
    if (this.stateValue !== "running" || this.awaitingPong) {
      return;
    }
    this.cancelTimer("heartbeat");
    this.heartbeatTimer = this.scheduler.schedule(() => {
      this.heartbeatTimer = undefined;
      if (this.stateValue !== "running") {
        return;
      }
      const socket = this.socket;
      if (socket === null) {
        this.fail(
          channelError(
            "USER_CHANNEL_HEARTBEAT_FAILED",
            "The authenticated user channel lost its heartbeat socket."
          )
        );
        return;
      }
      try {
        socket.send("PING");
      } catch {
        this.fail(
          channelError(
            "USER_CHANNEL_HEARTBEAT_FAILED",
            "The authenticated user-channel heartbeat could not be sent."
          )
        );
        return;
      }
      this.awaitingPong = true;
      this.pongTimer = this.scheduler.schedule(() => {
        this.pongTimer = undefined;
        if (this.stateValue === "running" && this.awaitingPong) {
          this.fail(
            channelError(
              "USER_CHANNEL_PONG_TIMEOUT",
              "The authenticated user channel missed its heartbeat response."
            )
          );
        }
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private fail(error: SafeExternalServiceError): void {
    if (
      this.stateValue === "failed" ||
      this.stateValue === "stopped"
    ) {
      return;
    }
    this.stateValue = "failed";
    this.clearTimers();
    this.clearPendingSubscription();
    this.subscribedMarkets.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      safeClose(socket, 1_008, "user-channel-safety-failure");
    }
    this.rejectStart(error);
    if (!this.failureReported) {
      this.failureReported = true;
      try {
        void Promise.resolve(this.options.onFailure(error)).catch(() => {
          // Failure is already reflected in state. Callback errors are never
          // surfaced because they may contain unsafe downstream context.
        });
      } catch {
        // Synchronous callback failures are equally unsafe to surface.
      }
    }
  }

  private rejectStart(error: SafeExternalServiceError): void {
    const reject = this.startReject;
    this.startResolve = null;
    this.startReject = null;
    reject?.(error);
  }

  private clearPendingSubscription(): void {
    this.pendingSubscription?.fill(0);
    this.pendingSubscription = null;
  }

  private clearTimers(): void {
    this.cancelTimer("connect");
    this.cancelTimer("heartbeat");
    this.cancelTimer("pong");
    this.awaitingPong = false;
  }

  private cancelTimer(
    timer: "connect" | "heartbeat" | "pong"
  ): void {
    const handle =
      timer === "connect"
        ? this.connectTimer
        : timer === "heartbeat"
          ? this.heartbeatTimer
          : this.pongTimer;
    if (handle !== undefined) {
      this.scheduler.cancel(handle);
    }
    if (timer === "connect") {
      this.connectTimer = undefined;
    } else if (timer === "heartbeat") {
      this.heartbeatTimer = undefined;
    } else {
      this.pongTimer = undefined;
    }
  }
}

export function parseUserChannelEvent(
  value: unknown,
  subscribedMarkets: ReadonlySet<string>,
  nowMs: number
): UserChannelEvent {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("A valid current timestamp is required.");
  }
  const record = asRecord(value);
  const eventType = record === null ? null : readString(record, "event_type");
  if (record === null || (eventType !== "trade" && eventType !== "order")) {
    throw new Error("Unsupported user-channel event.");
  }

  const conditionId = requireHex(record, "market");
  if (!subscribedMarkets.has(conditionId.toLowerCase())) {
    throw new Error("The user-channel event is outside the subscription.");
  }
  return eventType === "trade"
    ? parseTradeEvent(record, conditionId, nowMs)
    : parseOrderEvent(record, conditionId, nowMs);
}

function parseTradeEvent(
  record: Record<string, unknown>,
  conditionId: string,
  nowMs: number
): UserChannelTradeEvent {
  if (readString(record, "type") !== "TRADE") {
    throw new Error("Invalid trade event type.");
  }
  const status = readString(record, "status");
  if (
    status !== "MATCHED" &&
    status !== "MINED" &&
    status !== "CONFIRMED" &&
    status !== "RETRYING" &&
    status !== "FAILED"
  ) {
    throw new Error("Invalid trade status.");
  }

  const tokenId = requireTokenId(record, "asset_id");
  const makerValues = record.maker_orders;
  if (!Array.isArray(makerValues) || makerValues.length === 0) {
    throw new Error("Invalid maker order list.");
  }
  const makerOrders = makerValues.map((value) => {
    const maker = asRecord(value);
    if (maker === null) {
      throw new Error("Invalid maker order.");
    }
    requireOpaqueId(maker, "owner");
    const makerTokenId = requireTokenId(maker, "asset_id");
    if (makerTokenId !== tokenId) {
      throw new Error("Maker order token does not match the trade.");
    }
    return {
      tokenId: makerTokenId,
      orderId: requireHex(maker, "order_id"),
      makerAddress: requireAddress(maker, "maker_address"),
      side: requireSide(maker),
      matchedSizeMicros: requirePositiveMicros(maker, "matched_amount"),
      priceMicros: requirePriceMicros(maker, "price"),
      feeRateBps: requireFeeRateBps(maker, "fee_rate_bps"),
      outcome: requireBoundedText(maker, "outcome")
    };
  });

  requireOpaqueId(record, "owner");
  requireOpaqueId(record, "trade_owner");
  requireBoundedText(record, "outcome");
  const traderSide = requireTraderSide(record);
  const side = requireSide(record);
  const makerAddress = requireAddress(record, "maker_address");
  const transactionHash = requireOptionalHash(record, "transaction_hash");
  const feeRateBps = requireFeeRateBps(record, "fee_rate_bps");
  const bucketIndex = requireNonNegativeInteger(record, "bucket_index");
  if (makerOrders.some((order) => order.side === side)) {
    throw new Error("Maker order side must oppose the trade side.");
  }
  if (traderSide === "TAKER" && record.taker_order_id === undefined) {
    throw new Error("Taker trade is missing its taker order.");
  }
  if (
    new Set(makerOrders.map((order) => order.orderId)).size !==
    makerOrders.length
  ) {
    throw new Error("Duplicate maker order.");
  }
  const matchTimeMs = requireEpochMs(record, "match_time", nowMs);
  const timestampMs = requireEpochMs(record, "timestamp", nowMs);
  const lastUpdateMs = requireEpochMs(record, "last_update", nowMs);
  if (timestampMs < matchTimeMs || lastUpdateMs < matchTimeMs) {
    throw new Error("Inconsistent trade timestamps.");
  }

  return {
    kind: "trade",
    tradeId: requireOpaqueId(record, "id"),
    conditionId: conditionId.toLowerCase(),
    tokenId,
    side,
    sizeMicros: requirePositiveMicros(record, "size"),
    priceMicros: requirePriceMicros(record, "price"),
    feeRateBps,
    status,
    takerOrderId: requireHex(record, "taker_order_id"),
    makerAddress,
    transactionHash,
    bucketIndex,
    traderSide,
    makerOrders,
    matchTimeMs,
    timestampMs,
    lastUpdateMs
  };
}

function parseOrderEvent(
  record: Record<string, unknown>,
  conditionId: string,
  nowMs: number
): UserChannelOrderEvent {
  const lifecycle = readString(record, "type");
  if (
    lifecycle !== "PLACEMENT" &&
    lifecycle !== "UPDATE" &&
    lifecycle !== "CANCELLATION"
  ) {
    throw new Error("Invalid order lifecycle.");
  }
  requireOpaqueId(record, "owner");
  requireOpaqueId(record, "order_owner");
  requireBoundedText(record, "outcome");
  const makerAddress = requireAddress(record, "maker_address");
  const createdAtMs = requireEpochMs(record, "created_at", nowMs);
  const expirationEpochSeconds = requireEpochSeconds(record, "expiration");
  const orderType = readString(record, "order_type");
  if (orderType !== "GTD") {
    throw new Error("Only GTD user-channel orders are supported.");
  }
  const orderStatus = readString(record, "status");
  if (
    orderStatus !== "LIVE" &&
    orderStatus !== "MATCHED" &&
    orderStatus !== "CANCELLED" &&
    orderStatus !== "EXPIRED"
  ) {
    throw new Error("Invalid order status.");
  }
  const originalSizeMicros = requirePositiveMicros(record, "original_size");
  const sizeMatchedMicros = requireNonNegativeMicros(record, "size_matched");
  if (sizeMatchedMicros > originalSizeMicros) {
    throw new Error("Matched size exceeds original size.");
  }

  const associated = record.associate_trades;
  if (associated !== null && !Array.isArray(associated)) {
    throw new Error("Invalid associated trade list.");
  }
  const associatedTradeIds =
    associated === null
      ? []
      : associated.map((value) => {
          if (
            typeof value !== "string" ||
            !isSafeOpaqueId(value)
          ) {
            throw new Error("Invalid associated trade ID.");
          }
          return value;
        });
  if (new Set(associatedTradeIds).size !== associatedTradeIds.length) {
    throw new Error("Duplicate associated trade ID.");
  }

  const timestampMs = requireEpochMs(record, "timestamp", nowMs);
  if (
    createdAtMs > timestampMs ||
    expirationEpochSeconds > Number.MAX_SAFE_INTEGER / 1_000 ||
    expirationEpochSeconds * 1_000 < createdAtMs
  ) {
    throw new Error("Inconsistent order timestamps.");
  }

  return {
    kind: "order",
    orderId: requireHex(record, "id"),
    conditionId: conditionId.toLowerCase(),
    tokenId: requireTokenId(record, "asset_id"),
    side: requireSide(record),
    originalSizeMicros,
    sizeMatchedMicros,
    priceMicros: requirePriceMicros(record, "price"),
    makerAddress,
    createdAtMs,
    expirationEpochSeconds,
    orderType,
    status: orderStatus,
    lifecycle,
    associatedTradeIds,
    timestampMs
  };
}

function validateMarkets(markets: string[]): string[] {
  if (!Array.isArray(markets) || markets.length === 0 || markets.length > 500) {
    throw new Error("One to 500 user-channel markets are required.");
  }
  const normalized = markets.map((market) => {
    if (!/^0x[a-fA-F0-9]{64}$/u.test(market)) {
      throw new Error("Every user-channel market must be a condition ID.");
    }
    return market.toLowerCase();
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("User-channel markets must be unique.");
  }
  return normalized;
}

function validateCredentials(credentials: UserChannelCredentials): void {
  for (const value of [
    credentials.apiKey,
    credentials.secret,
    credentials.passphrase
  ]) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new Error("The user-channel credentials are invalid.");
    }
  }
}

function encodeSubscription(
  credentials: UserChannelCredentials,
  markets: string[]
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({
      auth: {
        apiKey: credentials.apiKey,
        secret: credentials.secret,
        passphrase: credentials.passphrase
      },
      markets,
      type: "user"
    })
  );
}

function requireSide(record: Record<string, unknown>): OrderSide {
  const side = readString(record, "side");
  if (side !== "BUY" && side !== "SELL") {
    throw new Error("Invalid order side.");
  }
  return side;
}

function requirePositiveMicros(
  record: Record<string, unknown>,
  key: string
): bigint {
  const value = parseMicros(record[key]);
  if (value <= 0n) {
    throw new Error("A positive decimal was required.");
  }
  return value;
}

function requireNonNegativeMicros(
  record: Record<string, unknown>,
  key: string
): bigint {
  const value = parseMicros(record[key]);
  if (value < 0n) {
    throw new Error("A non-negative decimal was required.");
  }
  return value;
}

function requirePriceMicros(
  record: Record<string, unknown>,
  key: string
): bigint {
  const price = requirePositiveMicros(record, key);
  if (price > PUSD_SCALE) {
    throw new Error("Price is outside the supported range.");
  }
  return price;
}

function parseMicros(value: unknown): bigint {
  if (typeof value !== "string") {
    throw new Error("Invalid decimal value.");
  }
  const match = /^(\d+)(?:\.(\d{0,6}))?$/u.exec(value);
  if (match === null) {
    throw new Error("Invalid fixed-six decimal value.");
  }
  const fraction = match[2] ?? "";
  return BigInt(match[1]!) * PUSD_SCALE +
    BigInt(fraction.padEnd(6, "0") || "0");
}

function requireFeeRateBps(
  record: Record<string, unknown>,
  key: string
): number {
  const value = record[key];
  if (typeof value !== "string" || !/^\d{1,5}$/u.test(value)) {
    throw new Error("Invalid fee-rate value.");
  }
  const feeRateBps = Number(value);
  if (!Number.isSafeInteger(feeRateBps) || feeRateBps > 10_000) {
    throw new Error("Fee rate is outside the supported range.");
  }
  return feeRateBps;
}

function requireTraderSide(
  record: Record<string, unknown>
): "TAKER" | "MAKER" {
  const value = readString(record, "trader_side");
  if (value !== "TAKER" && value !== "MAKER") {
    throw new Error("Invalid trader side.");
  }
  return value;
}

function requireAddress(
  record: Record<string, unknown>,
  key: string
): string {
  const value = readString(record, key);
  if (value === null || !/^0x[a-fA-F0-9]{40}$/u.test(value)) {
    throw new Error("Invalid address.");
  }
  return value.toLowerCase();
}

function requireOptionalHash(
  record: Record<string, unknown>,
  key: string
): string | null {
  const value = record[key];
  if (value === "" || value === null) {
    return null;
  }
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{64}$/u.test(value)) {
    throw new Error("Invalid transaction hash.");
  }
  return value.toLowerCase();
}

function requireNonNegativeInteger(
  record: Record<string, unknown>,
  key: string
): number {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error("Invalid non-negative integer.");
  }
  return value;
}

function requireEpochSeconds(
  record: Record<string, unknown>,
  key: string
): number {
  const value = record[key];
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new Error("Invalid epoch timestamp.");
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error("Invalid epoch timestamp.");
  }
  return seconds;
}

function requireEpochMs(
  record: Record<string, unknown>,
  key: string,
  nowMs: number
): number {
  const value = record[key];
  const seconds =
    typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error("Invalid event timestamp.");
  }
  const milliseconds = seconds * 1_000;
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds > nowMs + MAX_FUTURE_SKEW_MS
  ) {
    throw new Error("Invalid event timestamp.");
  }
  return milliseconds;
}

function requireCurrentTime(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("A valid current timestamp is required.");
  }
  return value;
}

function requireHex(
  record: Record<string, unknown>,
  key: string
): string {
  const value = readString(record, key);
  if (value === null || !/^0x[a-fA-F0-9]{64}$/u.test(value)) {
    throw new Error("Invalid hexadecimal identifier.");
  }
  return value.toLowerCase();
}

function requireTokenId(
  record: Record<string, unknown>,
  key: string
): string {
  const value = readString(record, key);
  if (value === null || !/^\d{1,80}$/u.test(value)) {
    throw new Error("Invalid token identifier.");
  }
  return value;
}

function requireOpaqueId(
  record: Record<string, unknown>,
  key: string
): string {
  const value = readString(record, key);
  if (value === null || !isSafeOpaqueId(value)) {
    throw new Error("Invalid opaque identifier.");
  }
  return value;
}

function isSafeOpaqueId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

function requireBoundedText(
  record: Record<string, unknown>,
  key: string
): string {
  const value = readString(record, key);
  if (
    value === null ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Invalid event text.");
  }
  return value;
}

function readString(
  record: Record<string, unknown>,
  key: string
): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function channelError(
  code: string,
  message: string
): SafeExternalServiceError {
  return new SafeExternalServiceError(message, {
    code,
    service: "clob-user-channel",
    retryable: false
  });
}

function safeClose(
  socket: UserChannelSocket,
  code: number,
  reason: string
): void {
  try {
    socket.close(code, reason);
  } catch {
    // The caller has already moved to a safe terminal state.
  }
}

const defaultScheduler: UserChannelScheduler = {
  schedule(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
};

const defaultSocketFactory: UserChannelSocketFactory = (url) => {
  const socket = new WebSocket(url);
  return {
    send(data) {
      socket.send(data);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    onOpen(handler) {
      socket.addEventListener("open", () => {
        handler();
      });
    },
    onMessage(handler) {
      socket.addEventListener("message", (event) => {
        handler(event.data);
      });
    },
    onError(handler) {
      socket.addEventListener("error", () => {
        handler();
      });
    },
    onClose(handler) {
      socket.addEventListener("close", () => {
        handler();
      });
    }
  };
};
