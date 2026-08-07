import { describe, expect, it } from "vitest";
import {
  POLYMARKET_USER_CHANNEL_URL,
  PolymarketUserChannelMonitor,
  type UserChannelCredentials,
  type UserChannelEvent,
  type UserChannelScheduler,
  type UserChannelSocket
} from "../src/polymarket/user-channel-monitor.js";
import type { SafeExternalServiceError } from "../src/polymarket/safe-error.js";

const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1_000;
const CONDITION_ID = `0x${"1".repeat(64)}`;
const OTHER_CONDITION_ID = `0x${"2".repeat(64)}`;
const ORDER_ID = `0x${"3".repeat(64)}`;
const TAKER_ORDER_ID = `0x${"4".repeat(64)}`;
const MAKER_ADDRESS = `0x${"5".repeat(40)}`;
const COUNTERPARTY_ADDRESS = `0x${"6".repeat(40)}`;
const CREDENTIALS: UserChannelCredentials = {
  apiKey: "fixture-api-key",
  secret: "fixture-api-secret",
  passphrase: "fixture-api-passphrase"
};

describe("authenticated user-channel monitor", () => {
  it("connects only to the official endpoint, subscribes, and wipes its auth buffer", async () => {
    const harness = createHarness();
    const started = harness.monitor.start(CREDENTIALS, [
      CONDITION_ID.toUpperCase().replace("0X", "0x")
    ]);

    expect(harness.requestedUrls).toEqual([
      POLYMARKET_USER_CHANNEL_URL
    ]);
    harness.socket.emitOpen();
    await started;

    expect(harness.socket.sentText).toHaveLength(2);
    expect(JSON.parse(harness.socket.sentText[0]!)).toEqual({
      auth: {
        apiKey: CREDENTIALS.apiKey,
        secret: CREDENTIALS.secret,
        passphrase: CREDENTIALS.passphrase
      },
      markets: [CONDITION_ID],
      type: "user"
    });
    expect(harness.socket.sentText[1]).toBe("PING");
    expect(harness.socket.lastBinaryReference).not.toBeNull();
    expect(
      Array.from(harness.socket.lastBinaryReference ?? []).every(
        (byte) => byte === 0
      )
    ).toBe(true);
    expect(harness.monitor.status()).toMatchObject({
      state: "running",
      awaitingPong: false,
      subscribedMarketCount: 1,
      pendingEventCount: 0
    });
  });

  it("sends PING after ten seconds and requires a PONG before rescheduling", async () => {
    let nowMs = NOW_MS;
    const harness = createHarness({ now: () => nowMs });
    const started = harness.monitor.start(CREDENTIALS, [CONDITION_ID]);
    harness.socket.emitOpen();
    await started;

    expect(harness.scheduler.delays()).toEqual([10_000]);
    harness.scheduler.runNext();
    expect(harness.socket.sentText.at(-1)).toBe("PING");
    expect(harness.monitor.status().awaitingPong).toBe(true);

    nowMs += 10_100;
    harness.socket.emitMessage("PONG");
    expect(harness.monitor.status()).toMatchObject({
      state: "running",
      awaitingPong: false,
      lastMessageAtMs: nowMs
    });
    expect(harness.scheduler.delays()).toEqual([10_000]);
    expect(harness.failures).toEqual([]);
  });

  it("does not declare the authenticated channel ready before the initial PONG", async () => {
    const harness = createHarness();
    harness.socket.autoPong = false;
    const started = harness.monitor.start(CREDENTIALS, [CONDITION_ID]);
    const rejected = expect(started).rejects.toMatchObject({
      code: "USER_CHANNEL_PONG_TIMEOUT"
    });

    harness.socket.emitOpen();
    await flushPromises();
    expect(harness.monitor.status()).toMatchObject({
      state: "running",
      awaitingPong: true
    });
    harness.scheduler.runNext();
    await rejected;
  });

  it("fails once and closes when PONG does not arrive", async () => {
    const harness = createHarness();
    const started = harness.monitor.start(CREDENTIALS, [CONDITION_ID]);
    harness.socket.emitOpen();
    await started;

    harness.scheduler.runNext();
    harness.scheduler.runNext();
    await flushPromises();

    expect(harness.monitor.status().state).toBe("failed");
    expect(harness.failures.map((failure) => failure.code)).toEqual([
      "USER_CHANNEL_PONG_TIMEOUT"
    ]);
    expect(harness.socket.closes).toEqual([
      { code: 1_008, reason: "user-channel-safety-failure" }
    ]);

    harness.socket.emitError();
    harness.socket.emitClose();
    await flushPromises();
    expect(harness.failures).toHaveLength(1);
  });

  it("times out a connection without exposing credentials", async () => {
    const harness = createHarness();
    const started = harness.monitor.start(CREDENTIALS, [CONDITION_ID]);
    const rejected = expect(started).rejects.toMatchObject({
      code: "USER_CHANNEL_CONNECT_TIMEOUT"
    });

    harness.scheduler.runNext();
    await rejected;
    await flushPromises();

    expect(harness.failures).toHaveLength(1);
    const serialized = JSON.stringify({
      code: harness.failures[0]?.code,
      message: harness.failures[0]?.message
    });
    expect(serialized).not.toContain(CREDENTIALS.apiKey);
    expect(serialized).not.toContain(CREDENTIALS.secret);
    expect(serialized).not.toContain(CREDENTIALS.passphrase);
  });

  it("wipes the auth frame and reports a generic subscription-send failure", async () => {
    const harness = createHarness();
    harness.socket.sendFailure = new Error(
      `apiKey=${CREDENTIALS.apiKey} secret=${CREDENTIALS.secret}`
    );
    const started = harness.monitor.start(CREDENTIALS, [CONDITION_ID]);
    const rejected = expect(started).rejects.toMatchObject({
      code: "USER_CHANNEL_SUBSCRIPTION_FAILED"
    });

    harness.socket.emitOpen();
    await rejected;
    await flushPromises();

    expect(harness.socket.lastBinaryReference).not.toBeNull();
    expect(
      Array.from(harness.socket.lastBinaryReference ?? []).every(
        (byte) => byte === 0
      )
    ).toBe(true);
    expect(harness.failures).toHaveLength(1);
    expect(harness.failures[0]?.message).not.toContain(CREDENTIALS.apiKey);
    expect(harness.failures[0]?.message).not.toContain(CREDENTIALS.secret);
  });

  it("parses strict order and trade lifecycle events into bounded DTOs", async () => {
    const harness = createHarness();
    const started = harness.monitor.start(CREDENTIALS, [CONDITION_ID]);
    harness.socket.emitOpen();
    await started;

    harness.socket.emitMessage(JSON.stringify(validOrderEvent()));
    harness.socket.emitMessage(JSON.stringify(validTradeEvent()));
    await flushPromises();

    expect(harness.events).toEqual([
      {
        kind: "order",
        orderId: ORDER_ID,
        conditionId: CONDITION_ID,
        tokenId: "1000001",
        side: "SELL",
        originalSizeMicros: 10_000_000n,
        sizeMatchedMicros: 2_000_000n,
        priceMicros: 570_000n,
        makerAddress: MAKER_ADDRESS,
        createdAtMs: NOW_MS - 2_000,
        expirationEpochSeconds: NOW_SECONDS + 900,
        orderType: "GTD",
        status: "LIVE",
        lifecycle: "UPDATE",
        associatedTradeIds: ["fixture-trade-1"],
        timestampMs: NOW_MS - 2_000
      },
      {
        kind: "trade",
        tradeId: "fixture-trade-1",
        conditionId: CONDITION_ID,
        tokenId: "1000001",
        side: "BUY",
        sizeMicros: 10_000_000n,
        priceMicros: 570_000n,
        status: "CONFIRMED",
        takerOrderId: TAKER_ORDER_ID,
        makerOrders: [
          {
            tokenId: "1000001",
            orderId: ORDER_ID,
            makerAddress: COUNTERPARTY_ADDRESS,
            side: "SELL",
            matchedSizeMicros: 10_000_000n,
            priceMicros: 570_000n,
            feeRateBps: 0,
            outcome: "YES"
          }
        ],
        feeRateBps: 0,
        makerAddress: MAKER_ADDRESS,
        transactionHash: null,
        bucketIndex: 0,
        traderSide: "TAKER",
        matchTimeMs: NOW_MS - 3_000,
        timestampMs: NOW_MS - 2_000,
        lastUpdateMs: NOW_MS - 1_000
      }
    ]);
    expect(harness.failures).toEqual([]);
  });

  it.each([
    {
      label: "binary frame",
      data: new Uint8Array([1, 2, 3])
    },
    {
      label: "invalid JSON",
      data: "{invalid"
    },
    {
      label: "oversized frame",
      data: "x".repeat(256 * 1024 + 1)
    },
    {
      label: "array payload",
      data: JSON.stringify([validOrderEvent()])
    },
    {
      label: "unknown event type",
      data: JSON.stringify({
        ...validOrderEvent(),
        event_type: "unknown"
      })
    },
    {
      label: "event outside subscribed markets",
      data: JSON.stringify({
        ...validOrderEvent(),
        market: OTHER_CONDITION_ID
      })
    },
    {
      label: "invalid order side",
      data: JSON.stringify({
        ...validOrderEvent(),
        side: "HOLD"
      })
    },
    {
      label: "matched size above original",
      data: JSON.stringify({
        ...validOrderEvent(),
        size_matched: "11"
      })
    },
    {
      label: "price above one",
      data: JSON.stringify({
        ...validOrderEvent(),
        price: "1.01"
      })
    },
    {
      label: "numeric price instead of the documented decimal string",
      data: JSON.stringify({
        ...validOrderEvent(),
        price: 0.57
      })
    },
    {
      label: "price with more than six decimal places",
      data: JSON.stringify({
        ...validOrderEvent(),
        price: "0.5700001"
      })
    },
    {
      label: "order missing maker address evidence",
      data: JSON.stringify({
        ...validOrderEvent(),
        maker_address: undefined
      })
    },
    {
      label: "future timestamp",
      data: JSON.stringify({
        ...validOrderEvent(),
        timestamp: String(NOW_SECONDS + 6)
      })
    },
    {
      label: "malformed maker order",
      data: JSON.stringify({
        ...validTradeEvent(),
        maker_orders: [{ owner: "fixture-owner" }]
      })
    },
    {
      label: "maker token mismatch",
      data: JSON.stringify({
        ...validTradeEvent(),
        maker_orders: [
          {
            ...validMakerOrder(),
            asset_id: "1000002"
          }
        ]
      })
    },
    {
      label: "duplicate maker order",
      data: JSON.stringify({
        ...validTradeEvent(),
        maker_orders: [validMakerOrder(), validMakerOrder()]
      })
    },
    {
      label: "trade with malformed transaction evidence",
      data: JSON.stringify({
        ...validTradeEvent(),
        transaction_hash: "0x1234"
      })
    }
  ])("fails closed on a $label", async ({ data }) => {
    const harness = createHarness();
    const started = harness.monitor.start(CREDENTIALS, [CONDITION_ID]);
    harness.socket.emitOpen();
    await started;

    harness.socket.emitMessage(data);
    await flushPromises();

    expect(harness.monitor.status().state).toBe("failed");
    expect(harness.failures.map((failure) => failure.code)).toEqual([
      "USER_CHANNEL_MALFORMED_MESSAGE"
    ]);
    expect(harness.socket.closes).toHaveLength(1);
  });

  it("rejects an unsolicited PONG", async () => {
    const harness = createHarness();
    const started = harness.monitor.start(CREDENTIALS, [CONDITION_ID]);
    harness.socket.emitOpen();
    await started;

    harness.socket.emitMessage("PONG");
    await flushPromises();

    expect(harness.failures.map((failure) => failure.code)).toEqual([
      "USER_CHANNEL_UNEXPECTED_PONG"
    ]);
  });

  it("reports an unexpected close exactly once", async () => {
    const harness = createHarness();
    const started = harness.monitor.start(CREDENTIALS, [CONDITION_ID]);
    harness.socket.emitOpen();
    await started;

    harness.socket.emitClose();
    harness.socket.emitError();
    await flushPromises();

    expect(harness.failures.map((failure) => failure.code)).toEqual([
      "USER_CHANNEL_UNEXPECTED_CLOSE"
    ]);
  });

  it("fails closed if event reconciliation rejects and suppresses unsafe callback errors", async () => {
    const failures: SafeExternalServiceError[] = [];
    const socket = new FakeSocket();
    const monitor = new PolymarketUserChannelMonitor({
      socketFactory: () => socket,
      scheduler: new FakeScheduler(),
      now: () => NOW_MS,
      async onEvent() {
        throw new Error(`secret=${CREDENTIALS.secret}`);
      },
      onFailure(error) {
        failures.push(error);
        throw new Error(`passphrase=${CREDENTIALS.passphrase}`);
      }
    });
    const started = monitor.start(CREDENTIALS, [CONDITION_ID]);
    socket.emitOpen();
    await started;

    socket.emitMessage(JSON.stringify(validOrderEvent()));
    await flushPromises();

    expect(monitor.status().state).toBe("failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      code: "USER_CHANNEL_EVENT_HANDLER_FAILED"
    });
    expect(failures[0]?.message).not.toContain(CREDENTIALS.secret);
    expect(failures[0]?.message).not.toContain(CREDENTIALS.passphrase);
  });

  it("stops intentionally without reporting a failure or leaving timers", async () => {
    const harness = createHarness();
    const started = harness.monitor.start(CREDENTIALS, [CONDITION_ID]);
    harness.socket.emitOpen();
    await started;

    harness.monitor.stop();
    harness.socket.emitClose();
    await flushPromises();

    expect(harness.monitor.status()).toMatchObject({
      state: "stopped",
      awaitingPong: false,
      subscribedMarketCount: 0
    });
    expect(harness.scheduler.delays()).toEqual([]);
    expect(harness.failures).toEqual([]);
    expect(harness.socket.closes).toEqual([
      { code: 1_000, reason: "local-stop" }
    ]);
    expect(() =>
      harness.monitor.start(CREDENTIALS, [CONDITION_ID])
    ).toThrow(/only be started once/u);
  });

  it("rejects invalid or duplicate subscriptions before creating a socket", () => {
    const harness = createHarness();
    expect(() =>
      harness.monitor.start(CREDENTIALS, [])
    ).toThrow(/markets/u);
    expect(harness.requestedUrls).toEqual([]);

    const second = createHarness();
    expect(() =>
      second.monitor.start(CREDENTIALS, [
        CONDITION_ID,
        CONDITION_ID.toUpperCase().replace("0X", "0x")
      ])
    ).toThrow(/unique/u);
    expect(second.requestedUrls).toEqual([]);
  });
});

function createHarness(options: {
  now?: () => number;
} = {}) {
  const socket = new FakeSocket();
  const scheduler = new FakeScheduler();
  const requestedUrls: string[] = [];
  const events: UserChannelEvent[] = [];
  const failures: SafeExternalServiceError[] = [];
  const monitor = new PolymarketUserChannelMonitor({
    socketFactory(url) {
      requestedUrls.push(url);
      return socket;
    },
    scheduler,
    now: options.now ?? (() => NOW_MS),
    onEvent(event) {
      events.push(event);
    },
    onFailure(error) {
      failures.push(error);
    }
  });
  return {
    monitor,
    socket,
    scheduler,
    requestedUrls,
    events,
    failures
  };
}

class FakeSocket implements UserChannelSocket {
  private openHandler: (() => void) | null = null;
  private messageHandler: ((data: unknown) => void) | null = null;
  private errorHandler: (() => void) | null = null;
  private closeHandler: (() => void) | null = null;
  readonly sentText: string[] = [];
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
  lastBinaryReference: Uint8Array<ArrayBuffer> | null = null;
  sendFailure: Error | null = null;
  autoPong = true;

  send(data: string | Uint8Array<ArrayBuffer>): void {
    if (typeof data === "string") {
      this.sentText.push(data);
      if (this.sendFailure !== null) {
        throw this.sendFailure;
      }
      return;
    }
    this.lastBinaryReference = data;
    this.sentText.push(new TextDecoder().decode(data.slice()));
    if (this.sendFailure !== null) {
      throw this.sendFailure;
    }
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }

  onMessage(handler: (data: unknown) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: () => void): void {
    this.errorHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  emitOpen(): void {
    this.openHandler?.();
    if (
      this.autoPong &&
      this.sendFailure === null &&
      this.sentText.at(-1) === "PING"
    ) {
      this.messageHandler?.("PONG");
    }
  }

  emitMessage(data: unknown): void {
    this.messageHandler?.(data);
  }

  emitError(): void {
    this.errorHandler?.();
  }

  emitClose(): void {
    this.closeHandler?.();
  }
}

class FakeScheduler implements UserChannelScheduler {
  private nextId = 1;
  private readonly tasks = new Map<
    number,
    { callback: () => void; delayMs: number }
  >();

  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { callback, delayMs });
    return id;
  }

  cancel(handle: unknown): void {
    if (typeof handle === "number") {
      this.tasks.delete(handle);
    }
  }

  delays(): number[] {
    return [...this.tasks.values()].map((task) => task.delayMs);
  }

  runNext(): void {
    const entry = [...this.tasks.entries()].sort(
      ([left], [right]) => left - right
    )[0];
    if (entry === undefined) {
      throw new Error("No scheduled task is available.");
    }
    this.tasks.delete(entry[0]);
    entry[1].callback();
  }
}

function validOrderEvent(): Record<string, unknown> {
  return {
    asset_id: "1000001",
    associate_trades: ["fixture-trade-1"],
    event_type: "order",
    id: ORDER_ID,
    market: CONDITION_ID,
    order_owner: "fixture-order-owner",
    original_size: "10",
    outcome: "YES",
    owner: "fixture-owner",
    price: "0.57",
    side: "SELL",
    size_matched: "2",
    maker_address: MAKER_ADDRESS,
    created_at: String(NOW_SECONDS - 2),
    expiration: String(NOW_SECONDS + 900),
    order_type: "GTD",
    status: "LIVE",
    timestamp: String(NOW_SECONDS - 2),
    type: "UPDATE"
  };
}

function validTradeEvent(): Record<string, unknown> {
  return {
    asset_id: "1000001",
    event_type: "trade",
    id: "fixture-trade-1",
    last_update: String(NOW_SECONDS - 1),
    fee_rate_bps: "0",
    maker_address: MAKER_ADDRESS,
    transaction_hash: "",
    bucket_index: 0,
    maker_orders: [validMakerOrder()],
    market: CONDITION_ID,
    match_time: String(NOW_SECONDS - 3),
    outcome: "YES",
    owner: "fixture-owner",
    price: "0.57",
    side: "BUY",
    size: "10",
    status: "CONFIRMED",
    taker_order_id: TAKER_ORDER_ID,
    timestamp: String(NOW_SECONDS - 2),
    trade_owner: "fixture-trade-owner",
    trader_side: "TAKER",
    type: "TRADE"
  };
}

function validMakerOrder(): Record<string, unknown> {
  return {
    asset_id: "1000001",
    matched_amount: "10",
    maker_address: COUNTERPARTY_ADDRESS,
    order_id: ORDER_ID,
    outcome: "YES",
    owner: "fixture-maker-owner",
    price: "0.57",
    fee_rate_bps: "0",
    side: "SELL"
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}
