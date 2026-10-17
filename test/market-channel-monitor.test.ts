import { describe, expect, it, vi } from "vitest";
import { assertAgentMarketSnapshotUnchanged } from "../src/application/trading-service.js";
import {
  POLYMARKET_MARKET_CHANNEL_URL,
  PolymarketMarketChannelMonitor,
  type MarketChannelSocket
} from "../src/polymarket/market-channel-monitor.js";
import { marketFixture } from "./fixtures.js";

const CONDITION_ID = `0x${"a".repeat(64)}`;
const NOW_MS = 1_800_000_000_000;

class ControlledSocket implements MarketChannelSocket {
  readonly sent: string[] = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  private openHandler: (() => void) | null = null;
  private messageHandler: ((data: unknown) => void) | null = null;
  private errorHandler: (() => void) | null = null;
  private closeHandler: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) });
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

  open(): void {
    this.openHandler?.();
  }

  message(data: unknown): void {
    this.messageHandler?.(data);
  }

  error(): void {
    this.errorHandler?.();
  }

  remoteClose(): void {
    this.closeHandler?.();
  }
}

async function connectedMonitor(tokenIds = ["101", "202"]) {
  const socket = new ControlledSocket();
  const failure = vi.fn();
  const monitor = new PolymarketMarketChannelMonitor({
    now: () => NOW_MS,
    generation: 7,
    onFailure: failure,
    socketFactory(url) {
      expect(url).toBe(POLYMARKET_MARKET_CHANNEL_URL);
      return socket;
    }
  });
  const connected = monitor.subscribe(tokenIds);
  socket.open();
  socket.message("PONG");
  await connected;
  return { monitor, socket, failure };
}

async function flushEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function bookEvent(tokenId: string, timestamp = NOW_MS - 86_400_000) {
  return JSON.stringify({
    event_type: "book",
    market: CONDITION_ID,
    asset_id: tokenId,
    timestamp: String(timestamp),
    hash: "deadbeef",
    bids: [{ price: "0.40", size: "10" }],
    asks: [{ price: "0.41", size: "10" }]
  });
}

describe("Polymarket market channel monitor", () => {
  it("invalidates an agent proposal after a channel reconnection", () => {
    const original = {
      ...marketFixture(NOW_MS - 100),
      sourceTimestampMs: NOW_MS - 1_000,
      receivedAtMs: NOW_MS - 100,
      channelGeneration: 7,
      bookHash: "deadbeef",
      marketDataSource: "WEBSOCKET" as const
    };
    expect(() =>
      assertAgentMarketSnapshotUnchanged(original, {
        ...original,
        capturedAtMs: NOW_MS,
        receivedAtMs: NOW_MS
      })
    ).not.toThrow();
    expect(() =>
      assertAgentMarketSnapshotUnchanged(original, {
        ...original,
        channelGeneration: 8
      })
    ).toThrow("AGENT_MARKET_SNAPSHOT_CHANGED");
  });

  it("uses healthy local receipt freshness even when the source timestamp is old", async () => {
    const { monitor, socket } = await connectedMonitor();
    try {
      expect(JSON.parse(socket.sent[0]!)).toEqual({
        assets_ids: ["101", "202"],
        type: "market",
        custom_feature_enabled: true
      });
      expect(socket.sent[1]).toBe("PING");

      socket.message(bookEvent("101"));
      await flushEvents();
      const book = await monitor.getFreshBook("101");
      expect(book).toMatchObject({
        tokenId: "101",
        conditionId: CONDITION_ID,
        sourceTimestampMs: NOW_MS - 86_400_000,
        receivedAtMs: NOW_MS,
        channelGeneration: 7,
        bookHash: "deadbeef"
      });
      expect(monitor.status()).toMatchObject({
        state: "running",
        subscribedTokenCount: 2,
        freshBookCount: 1
      });
    } finally {
      monitor.stop();
    }
  });

  it("skips one candidate without failing the healthy channel", async () => {
    const { monitor, failure } = await connectedMonitor();
    try {
      await expect(monitor.getFreshBook("202", 1)).resolves.toBeNull();
      expect(monitor.status().state).toBe("running");
      expect(failure).not.toHaveBeenCalled();
    } finally {
      monitor.stop();
    }
  });

  it("updates a bounded subscription with explicit subscribe and unsubscribe frames", async () => {
    const { monitor, socket } = await connectedMonitor(["101", "202"]);
    try {
      await monitor.subscribe(["202", "303"]);
      expect(socket.sent.slice(-2).map((value) => JSON.parse(value))).toEqual([
        { assets_ids: ["101"], operation: "unsubscribe" },
        { assets_ids: ["303"], operation: "subscribe" }
      ]);
      await expect(
        monitor.subscribe(Array.from({ length: 11 }, (_, index) => String(index + 1)))
      ).rejects.toThrow("One to ten");
    } finally {
      monitor.stop();
    }
  });

  it("applies deltas and tick changes while preserving generation identity", async () => {
    const { monitor, socket } = await connectedMonitor(["101"]);
    try {
      socket.message(bookEvent("101", NOW_MS - 2_000));
      await flushEvents();
      socket.message(JSON.stringify({
        event_type: "price_change",
        market: CONDITION_ID,
        timestamp: String(NOW_MS - 1_000),
        price_changes: [{
          asset_id: "101",
          side: "BUY",
          price: "0.40",
          size: "12",
          hash: "cafebabe",
          best_bid: "0.40",
          best_ask: "0.41"
        }]
      }));
      socket.message(JSON.stringify({
        event_type: "tick_size_change",
        market: CONDITION_ID,
        asset_id: "101",
        timestamp: String(NOW_MS),
        new_tick_size: "0.01"
      }));
      await flushEvents();
      const book = await monitor.getFreshBook("101");
      expect(book?.bids[0]?.sharesMicros).toBe(12_000_000n);
      expect(book?.tickSizeMicros).toBe(10_000n);
      expect(book?.channelGeneration).toBe(7);
      expect(book?.bookHash).not.toBe("deadbeef");
    } finally {
      monitor.stop();
    }
  });

  it("fails once on an out-of-order or malformed global stream", async () => {
    const { monitor, socket, failure } = await connectedMonitor(["101"]);
    socket.message(bookEvent("101", NOW_MS - 1_000));
    await flushEvents();
    socket.message(bookEvent("101", NOW_MS - 2_000));
    await flushEvents();
    expect(monitor.status().state).toBe("failed");
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure.mock.calls[0]?.[0]).toMatchObject({
      code: "MARKET_CHANNEL_MALFORMED_MESSAGE"
    });
    socket.error();
    socket.remoteClose();
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it("rejects a future remote timestamp without treating it as local freshness", async () => {
    const { monitor, socket, failure } = await connectedMonitor(["101"]);
    socket.message(bookEvent("101", NOW_MS + 5_001));
    await flushEvents();
    expect(monitor.status().state).toBe("failed");
    expect(failure).toHaveBeenCalledTimes(1);
  });
});
