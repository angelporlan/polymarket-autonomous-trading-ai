import { describe, expect, it } from "vitest";
import {
  PolymarketPublicClient,
  type PublicFetch
} from "../src/polymarket/public-client.js";

const NOW_MS = 1_800_000_000_000;
const PROFILE_ADDRESS = `0x${"a".repeat(40)}`;
const CONDITION_ID = `0x${"1".repeat(64)}`;
const TOKEN_ID = "controlled-token-yes";

describe("public order-book validation", () => {
  it.each([
    {
      label: "market",
      override: { market: `0x${"2".repeat(64)}` }
    },
    {
      label: "asset",
      override: { asset_id: "controlled-other-token" }
    }
  ])("rejects a mismatched $label identity", async ({ override }) => {
    const client = snapshotClient({ ...validBook(), ...override });

    await expect(snapshot(client)).rejects.toMatchObject({
      code: "CLOB_BOOK_IDENTITY_MISMATCH"
    });
  });

  it.each([
    {
      label: "malformed",
      timestamp: "not-a-timestamp",
      code: "CLOB_BOOK_TIMESTAMP_INVALID"
    },
    {
      label: "future",
      timestamp: String(NOW_MS + 1),
      code: "CLOB_BOOK_TIMESTAMP_INVALID"
    },
    {
      label: "older than five seconds",
      timestamp: String(NOW_MS - 5_001),
      code: "CLOB_BOOK_STALE"
    }
  ])("rejects a $label remote timestamp", async ({ timestamp, code }) => {
    const client = snapshotClient({ ...validBook(), timestamp });

    await expect(snapshot(client)).rejects.toMatchObject({ code });
  });

  it.each([
    { label: "bid", override: { bids: [] } },
    { label: "ask", override: { asks: [] } }
  ])("rejects a book without a $label side", async ({ override }) => {
    const client = snapshotClient({ ...validBook(), ...override });

    await expect(snapshot(client)).rejects.toMatchObject({
      code: "CLOB_BOOK_ONE_SIDED"
    });
  });

  it("rejects a crossed book", async () => {
    const client = snapshotClient({
      ...validBook(),
      bids: [{ price: "0.60", size: "2" }],
      asks: [{ price: "0.50", size: "2" }]
    });

    await expect(snapshot(client)).rejects.toMatchObject({
      code: "CLOB_BOOK_CROSSED"
    });
  });

  it("accepts a freshly received WebSocket book when the REST timestamp is stale", async () => {
    const client = snapshotClient({
      ...validBook(),
      timestamp: String(NOW_MS - 60_000)
    });

    await expect(
      client.getMarketSnapshot({
        conditionId: CONDITION_ID,
        tokenId: TOKEN_ID,
        realtimeBook: {
          conditionId: CONDITION_ID,
          tokenId: TOKEN_ID,
          bids: [{ priceMicros: 400_000n, sharesMicros: 10_000_000n }],
          asks: [{ priceMicros: 410_000n, sharesMicros: 10_000_000n }],
          sourceTimestampMs: NOW_MS - 60_000,
          receivedAtMs: NOW_MS - 100,
          channelGeneration: 3,
          bookHash: "deadbeef",
          tickSizeMicros: 10_000n
        }
      })
    ).resolves.toMatchObject({
      capturedAtMs: NOW_MS - 100,
      sourceTimestampMs: NOW_MS - 60_000,
      receivedAtMs: NOW_MS - 100,
      channelGeneration: 3,
      bookHash: "deadbeef",
      marketDataSource: "WEBSOCKET"
    });
  });

  it("classifies a WebSocket receipt that expires during enrichment as stale", async () => {
    const client = snapshotClient({
      ...validBook(),
      timestamp: String(NOW_MS - 60_000)
    });

    await expect(
      client.getMarketSnapshot({
        conditionId: CONDITION_ID,
        tokenId: TOKEN_ID,
        realtimeBook: {
          conditionId: CONDITION_ID,
          tokenId: TOKEN_ID,
          bids: [{ priceMicros: 400_000n, sharesMicros: 10_000_000n }],
          asks: [{ priceMicros: 410_000n, sharesMicros: 10_000_000n }],
          sourceTimestampMs: NOW_MS - 60_000,
          receivedAtMs: NOW_MS - 5_001,
          channelGeneration: 3,
          bookHash: "deadbeef",
          tickSizeMicros: 10_000n
        }
      })
    ).rejects.toMatchObject({
      code: "CLOB_MARKET_CHANNEL_BOOK_STALE"
    });
  });

  it("rejects a contradiction between fresh REST and WebSocket top-of-book", async () => {
    const client = snapshotClient(validBook());

    await expect(
      client.getMarketSnapshot({
        conditionId: CONDITION_ID,
        tokenId: TOKEN_ID,
        realtimeBook: {
          conditionId: CONDITION_ID,
          tokenId: TOKEN_ID,
          bids: [{ priceMicros: 390_000n, sharesMicros: 10_000_000n }],
          asks: [{ priceMicros: 420_000n, sharesMicros: 10_000_000n }],
          sourceTimestampMs: NOW_MS - 1_000,
          receivedAtMs: NOW_MS - 100,
          channelGeneration: 3,
          bookHash: "cafebabe",
          tickSizeMicros: 10_000n
        }
      })
    ).rejects.toMatchObject({ code: "CLOB_BOOK_CROSSCHECK_MISMATCH" });
  });

  it("rejects malformed levels instead of silently dropping them", async () => {
    const client = snapshotClient({
      ...validBook(),
      bids: [{ price: "invalid-price", size: "2" }]
    });

    await expect(snapshot(client)).rejects.toMatchObject({
      code: "CLOB_BOOK_MALFORMED"
    });
  });

  it.each([
    {
      label: "off-tick price",
      bids: [{ price: "0.395", size: "2" }]
    },
    {
      label: "duplicate price",
      bids: [
        { price: "0.39", size: "2" },
        { price: "0.39", size: "3" }
      ]
    },
    {
      label: "one-dollar price",
      bids: [{ price: "1", size: "2" }]
    }
  ])("rejects a $label before calculating depth", async ({ bids }) => {
    const client = snapshotClient({ ...validBook(), bids });

    await expect(snapshot(client)).rejects.toMatchObject({
      code: "CLOB_BOOK_MALFORMED"
    });
  });

  it.each([
    {
      label: "missing Gamma negRisk",
      overrides: { gamma: { negRisk: undefined } }
    },
    {
      label: "non-boolean Gamma negRisk",
      overrides: { gamma: { negRisk: "false" } }
    },
    {
      label: "non-boolean CLOB negRisk",
      overrides: { clob: { nr: 0 } }
    },
    {
      label: "inconsistent negRisk",
      overrides: { clob: { nr: true } }
    },
    {
      label: "missing fee details",
      overrides: { clob: { fd: undefined } }
    },
    {
      label: "missing fee rate",
      overrides: { clob: { fd: { e: 1, to: true } } }
    },
    {
      label: "missing fee exponent",
      overrides: { clob: { fd: { r: 0, to: true } } }
    },
    {
      label: "missing taker-only flag",
      overrides: { clob: { fd: { r: 0, e: 1 } } }
    },
    {
      label: "non-boolean taker-only flag",
      overrides: { clob: { fd: { r: 0, e: 1, to: 1 } } }
    },
    {
      label: "string fee rate",
      overrides: { clob: { fd: { r: "0", e: 1, to: true } } }
    },
    {
      label: "string fee exponent",
      overrides: { clob: { fd: { r: 0, e: "1", to: true } } }
    },
    {
      label: "sub-basis-point fee rate",
      overrides: { clob: { fd: { r: 0.00001, e: 1, to: true } } }
    }
  ])("rejects $label instead of applying a default", async ({ overrides }) => {
    const client = snapshotClient(validBook(), overrides);

    await expect(snapshot(client)).rejects.toMatchObject({
      code: "INVALID_EXTERNAL_RESPONSE"
    });
  });

  it("accepts omitted CLOB nr only when Gamma and the book explicitly say false", async () => {
    const client = snapshotClient(validBook(), {
      clob: { nr: undefined }
    });

    await expect(snapshot(client)).resolves.toMatchObject({
      negRisk: false
    });
  });

  it("rejects omitted CLOB nr when the other independent sources say true", async () => {
    const client = snapshotClient(
      { ...validBook(), neg_risk: true },
      {
        gamma: { negRisk: true },
        clob: { nr: undefined }
      }
    );

    await expect(snapshot(client)).rejects.toMatchObject({
      code: "INVALID_EXTERNAL_RESPONSE"
    });
  });

  it("does not infer an allowlisted category from the market title", async () => {
    const client = snapshotClient(validBook(), {
      gamma: {
        category: undefined,
        tags: undefined,
        question: "Will a politics election take place?"
      }
    });

    await expect(snapshot(client)).rejects.toMatchObject({
      code: "CATEGORY_NOT_ALLOWED"
    });
  });

  it("accepts an exact allowlisted structured tag without a category", async () => {
    const client = snapshotClient(validBook(), {
      gamma: {
        category: undefined,
        tags: [{ slug: "politics" }],
        question: "Controlled question with no category keywords"
      }
    });

    await expect(snapshot(client)).resolves.toMatchObject({
      category: "politics"
    });
  });

  it("does not let an allowlisted tag override an unsupported primary category", async () => {
    const client = snapshotClient(validBook(), {
      gamma: {
        category: "Sports",
        tags: [{ slug: "politics" }],
        question: "Will the election happen?"
      }
    });

    await expect(snapshot(client)).rejects.toMatchObject({
      code: "CATEGORY_NOT_ALLOWED"
    });
  });

  it("rejects a requested category that disagrees with structured metadata", async () => {
    const client = snapshotClient(validBook());

    await expect(
      client.getMarketSnapshot({
        conditionId: CONDITION_ID,
        tokenId: TOKEN_ID,
        category: "technology"
      })
    ).rejects.toMatchObject({
      code: "CATEGORY_NOT_ALLOWED"
    });
  });

  it("converts an exact numeric fee rate to basis points", async () => {
    const client = snapshotClient(validBook(), {
      feeRate: 12,
      clob: { fd: { r: 0.0012, e: 1, to: true } }
    });

    await expect(snapshot(client)).resolves.toMatchObject({
      feeRateBps: 12
    });
  });
});

describe("public portfolio completeness", () => {
  it.each([
    {
      label: "current positions",
      currentPayload: { positions: [] },
      closedPayload: []
    },
    {
      label: "closed positions",
      currentPayload: [],
      closedPayload: { positions: [] }
    }
  ])(
    "rejects a non-array top-level payload for $label",
    async ({ currentPayload, closedPayload }) => {
      const client = portfolioClient((path) =>
        path === "/positions" ? currentPayload : closedPayload
      );

      await expect(client.getPortfolio(PROFILE_ADDRESS)).rejects.toMatchObject({
        code: "INVALID_PORTFOLIO_RESPONSE"
      });
    }
  );

  it("paginates current and closed positions and includes realized losses once", async () => {
    const currentOffsets: number[] = [];
    const closedOffsets: number[] = [];
    const client = portfolioClient((path, offset, limit) => {
      if (path === "/positions") {
        currentOffsets.push(offset);
        if (offset === 0) {
          return Array.from({ length: limit }, (_, index) =>
            currentPosition(index)
          );
        }
        if (offset === 500) {
          return [currentPosition(500)];
        }
        throw new Error(`Unexpected current-position offset ${offset}.`);
      }
      closedOffsets.push(offset);
      if (offset !== 0) {
        throw new Error(`Unexpected closed-position offset ${offset}.`);
      }
      return [
        {
          ...closedPosition(0, "-999"),
          asset: currentPosition(0).asset,
          conditionId: currentPosition(0).conditionId
        },
        closedPosition(1_000, "-2")
      ];
    });

    const portfolio = await client.getPortfolio(PROFILE_ADDRESS);

    expect(currentOffsets).toEqual([0, 500]);
    expect(closedOffsets).toEqual([0]);
    expect(portfolio.positions).toHaveLength(501);
    expect(portfolio.totalPositionValueMicros).toBe(501_000_000n);
    expect(portfolio.totalPnlMicros).toBe(38_080_000n);
  });

  it("detects an API that ignores the pagination offset", async () => {
    const fullPage = Array.from({ length: 500 }, (_, index) =>
      currentPosition(index)
    );
    const offsets: number[] = [];
    const client = portfolioClient((path, offset) => {
      if (path === "/closed-positions") {
        return [];
      }
      offsets.push(offset);
      return fullPage;
    });

    await expect(client.getPortfolio(PROFILE_ADDRESS)).rejects.toMatchObject({
      code: "PORTFOLIO_RESPONSE_TRUNCATED"
    });
    expect(offsets).toEqual([0, 500]);
  });

  it("fails closed when the internal closed-position page cap is exhausted", async () => {
    let closedPageCount = 0;
    const client = portfolioClient((path, offset, limit) => {
      if (path === "/positions") {
        return [];
      }
      closedPageCount += 1;
      return Array.from({ length: limit }, (_, index) =>
        closedPosition(offset + index, "-0.01")
      );
    });

    await expect(client.getPortfolio(PROFILE_ADDRESS)).rejects.toMatchObject({
      code: "PORTFOLIO_RESPONSE_TRUNCATED"
    });
    expect(closedPageCount).toBe(200);
  });

  it.each([
    { label: "negative size", field: "size", value: "-0.000001" },
    { label: "sub-micro negative size", field: "size", value: "-0.0000001" },
    { label: "negative average price", field: "avgPrice", value: "-0.01" },
    { label: "average price above one", field: "avgPrice", value: "1.000001" },
    {
      label: "sub-micro average price above one",
      field: "avgPrice",
      value: "1.0000001"
    },
    { label: "negative current price", field: "curPrice", value: "-0.01" },
    { label: "current price above one", field: "curPrice", value: "1.000001" },
    { label: "negative current value", field: "currentValue", value: "-0.01" },
    { label: "non-finite size", field: "size", value: "Infinity" },
    { label: "non-finite average price", field: "avgPrice", value: "NaN" },
    { label: "non-finite current price", field: "curPrice", value: "Infinity" },
    { label: "non-finite current value", field: "currentValue", value: "NaN" },
    { label: "non-finite cash PnL", field: "cashPnl", value: "Infinity" },
    {
      label: "non-finite realized PnL",
      field: "realizedPnl",
      value: "NaN"
    }
  ])("rejects a position with $label", async ({ field, value }) => {
    const client = portfolioClient((path) =>
      path === "/positions"
        ? [{ ...currentPosition(0), [field]: value }]
        : []
    );

    await expect(client.getPortfolio(PROFILE_ADDRESS)).rejects.toMatchObject({
      code: "INVALID_PORTFOLIO_RESPONSE"
    });
  });

  it("accepts inclusive zero and one price boundaries", async () => {
    const client = portfolioClient((path) =>
      path === "/positions"
        ? [{ ...currentPosition(0), avgPrice: "0", curPrice: "1" }]
        : []
    );

    await expect(client.getPortfolio(PROFILE_ADDRESS)).resolves.toMatchObject({
      positions: [
        expect.objectContaining({
          averagePriceMicros: 0n,
          currentPriceMicros: 1_000_000n
        })
      ]
    });
  });

  it("rejects non-finite realized PnL in a closed position", async () => {
    const client = portfolioClient((path) =>
      path === "/positions" ? [] : [closedPosition(0, "Infinity")]
    );

    await expect(client.getPortfolio(PROFILE_ADDRESS)).rejects.toMatchObject({
      code: "INVALID_PORTFOLIO_RESPONSE"
    });
  });
});

function snapshot(
  client: PolymarketPublicClient
) {
  return client.getMarketSnapshot({
    conditionId: CONDITION_ID,
    tokenId: TOKEN_ID,
    side: "BUY",
    limitPriceMicros: 500_000n
  });
}

function snapshotClient(
  bookPayload: unknown,
  overrides: {
    feeRate?: number;
    gamma?: Record<string, unknown>;
    clob?: Record<string, unknown>;
  } = {}
): PolymarketPublicClient {
  const fetchMock: PublicFetch = async (input) => {
    const url = new URL(input.toString());
    if (url.hostname === "gamma.test" && url.pathname === "/markets") {
      return jsonResponse([
        {
          conditionId: CONDITION_ID,
          question: "Will the controlled event occur?",
          slug: "controlled-event",
          category: "Politics",
          rules: "Resolves from the stated official source.",
          resolutionSource: "https://example.invalid/controlled-source",
          endDate: "2027-12-01T00:00:00.000Z",
          active: true,
          closed: false,
          acceptingOrders: true,
          negRisk: false,
          feesEnabled: true,
          orderPriceMinTickSize: "0.01",
          clobTokenIds: [TOKEN_ID, "controlled-token-no"],
          outcomes: ["Yes", "No"],
          ...overrides.gamma
        }
      ]);
    }
    if (url.hostname === "clob.test" && url.pathname === "/book") {
      return jsonResponse(bookPayload);
    }
    if (
      url.hostname === "clob.test" &&
      url.pathname === `/clob-markets/${CONDITION_ID}`
    ) {
      return jsonResponse({
        c: CONDITION_ID,
        t: [
          { t: TOKEN_ID, o: "Yes" },
          { t: "controlled-token-no", o: "No" }
        ],
        mts: 0.01,
        mos: 5,
        ao: true,
        nr: false,
        fd: { r: 0, e: 1, to: true },
        ...overrides.clob
      });
    }
    if (url.hostname === "clob.test" && url.pathname === "/fee-rate") {
      return jsonResponse({ base_fee: overrides.feeRate ?? 0 });
    }
    throw new Error(`Unexpected controlled URL ${url.toString()}.`);
  };
  return new PolymarketPublicClient({
    gammaHost: "https://gamma.test",
    clobHost: "https://clob.test",
    fetch: fetchMock,
    now: () => NOW_MS,
    maxAttempts: 1
  });
}

function validBook() {
  return {
    market: CONDITION_ID,
    asset_id: TOKEN_ID,
    timestamp: String(NOW_MS - 1_000),
    tick_size: "0.01",
    min_order_size: "5",
    neg_risk: false,
    bids: [{ price: "0.40", size: "10" }],
    asks: [{ price: "0.41", size: "10" }]
  };
}

function portfolioClient(
  payloadFor: (
    path: "/positions" | "/closed-positions",
    offset: number,
    limit: number
  ) => unknown
): PolymarketPublicClient {
  const fetchMock: PublicFetch = async (input) => {
    const url = new URL(input.toString());
    if (
      url.hostname !== "data.test" ||
      (url.pathname !== "/positions" &&
        url.pathname !== "/closed-positions")
    ) {
      throw new Error(`Unexpected controlled URL ${url.toString()}.`);
    }
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return jsonResponse(
      payloadFor(
        url.pathname as "/positions" | "/closed-positions",
        offset,
        limit
      )
    );
  };
  return new PolymarketPublicClient({
    dataHost: "https://data.test",
    fetch: fetchMock,
    now: () => NOW_MS,
    maxAttempts: 1
  });
}

function currentPosition(index: number) {
  return {
    proxyWallet: PROFILE_ADDRESS,
    asset: `controlled-open-asset-${index}`,
    conditionId: conditionId(index),
    title: `Controlled open position ${index}`,
    outcome: "Yes",
    size: "2",
    avgPrice: "0.4",
    curPrice: "0.5",
    currentValue: "1",
    cashPnl: "0.1",
    realizedPnl: "-0.02",
    endDate: "2027-12-01T00:00:00.000Z"
  };
}

function closedPosition(index: number, realizedPnl: string) {
  return {
    proxyWallet: PROFILE_ADDRESS,
    asset: `controlled-closed-asset-${index}`,
    conditionId: conditionId(index + 20_000),
    realizedPnl
  };
}

function conditionId(index: number): string {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
