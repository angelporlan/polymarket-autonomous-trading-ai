import {
  Chain,
  OrderType,
  Side,
  SignatureTypeV2,
  getContractConfig,
  type CreateOrderOptions,
  type MarketDetails,
  type OrderResponse,
  type SignedOrder,
  type UserOrderV2
} from "@polymarket/clob-client-v2";
import { hashTypedData } from "viem";
import { describe, expect, it } from "vitest";
import type { MarketDataPort } from "../src/application/ports.js";
import { createOrderProposal } from "../src/domain/proposals.js";
import type { OrderProposal } from "../src/domain/types.js";
import {
  PolymarketLiveClient,
  type HeartbeatScheduler,
  type InjectedClobSigner,
  type LiveAuthentication,
  type LiveClobClient
} from "../src/polymarket/live-client.js";
import {
  PolymarketPublicClient,
  parseApiDecimalToMicros,
  type PublicFetch
} from "../src/polymarket/public-client.js";
import {
  SafeExternalServiceError,
  toSafeExternalError
} from "../src/polymarket/safe-error.js";
import {
  intentFixture,
  marketFixture,
  riskContextFixture
} from "./fixtures.js";

const NOW_MS = 1_800_000_000_000;
const CONDITION_ID = `0x${"1".repeat(64)}`;
const PROFILE_ADDRESS = `0x${"a".repeat(40)}`;

describe("safe external errors", () => {
  it("drops credentials, bearer values, private keys, and query secrets", () => {
    const privateKey = `0x${"b".repeat(64)}`;
    const unsafe = {
      status: 401,
      message:
        `Authorization: Bearer bearer-value secret=secret-value ` +
        `private_key=${privateKey} https://service.test/path?token=query-value`
    };

    const safe = toSafeExternalError(unsafe, {
      code: "AUTH_FAILURE",
      service: "clob"
    });

    expect(safe).toBeInstanceOf(SafeExternalServiceError);
    expect(safe.status).toBe(401);
    expect(safe.message).not.toContain("bearer-value");
    expect(safe.message).not.toContain("secret-value");
    expect(safe.message).not.toContain(privateKey);
    expect(safe.message).not.toContain("query-value");
  });

  it("redacts quoted JSON credential fields", () => {
    const safe = toSafeExternalError(
      new Error(
        '{"apiKey":"visible-api-key","secret":"visible-secret","passphrase":"visible-passphrase","Authorization":"Bearer visible-bearer"}'
      )
    );

    expect(safe.message).not.toContain("visible-api-key");
    expect(safe.message).not.toContain("visible-secret");
    expect(safe.message).not.toContain("visible-passphrase");
    expect(safe.message).not.toContain("visible-bearer");
    expect(safe.message).toContain("[REDACTED]");
  });
});

describe("public Polymarket adapter", () => {
  it("parses base-10 API values to micros without floating point", () => {
    expect(parseApiDecimalToMicros("1.234567")).toBe(1_234_567n);
    expect(parseApiDecimalToMicros("1.2345678")).toBe(1_234_568n);
    expect(parseApiDecimalToMicros("9e-7", "floor")).toBe(0n);
    expect(parseApiDecimalToMicros("-9e-7", "floor")).toBe(-1n);
  });

  it("uses Gamma, Data, and CLOB with retry/backoff and exact DTOs", async () => {
    let initialGammaFailures = 1;
    const sleepDelays: number[] = [];
    const requestedUrls: string[] = [];

    const fetchMock: PublicFetch = async (input) => {
      const url = new URL(input.toString());
      requestedUrls.push(url.toString());

      if (
        url.hostname === "gamma.test" &&
        url.pathname === "/markets" &&
        url.searchParams.has("condition_ids")
      ) {
        return jsonResponse([
          {
            conditionId: CONDITION_ID,
            question: "Will the election result be certified?",
            slug: "election-certified",
            category: "Politics",
            rules:
              "Resolves according to the final certification published by the official authority.",
            resolutionSource: "https://example.gov/certification",
            endDate: "2027-12-01T00:00:00.000Z",
            active: true,
            closed: false,
            acceptingOrders: true,
            negRisk: false,
            feesEnabled: true,
            orderPriceMinTickSize: "0.01",
            clobTokenIds: JSON.stringify(["token-yes", "token-no"]),
            outcomes: JSON.stringify(["Yes", "No"]),
            events: [{ id: 42 }]
          }
        ]);
      }

      if (url.hostname === "gamma.test" && url.pathname === "/markets") {
        if (initialGammaFailures > 0) {
          initialGammaFailures -= 1;
          return jsonResponse({ error: "busy" }, 503);
        }
        return jsonResponse([
          {
            conditionId: "politics-condition",
            slug: "election-market",
            question: "Who will win the election?",
            category: "Politics",
            active: true,
            closed: false,
            endDate: "2027-01-01T00:00:00.000Z",
            volume24hr: "123.4567894",
            liquidity: "50.0000009",
            bestBid: "0.40",
            bestAsk: "0.42",
            clobTokenIds: JSON.stringify(["p-yes", "p-no"])
          },
          {
            conditionId: "economics-condition",
            slug: "inflation-market",
            question: "Will inflation fall?",
            category: "Economics",
            active: true,
            closed: false,
            endDate: "2027-02-01T00:00:00.000Z",
            volume24hr: "2",
            liquidity: "3",
            spread: "0.01",
            clobTokenIds: ["e-yes", "e-no"]
          },
          {
            conditionId: "technology-condition",
            slug: "ai-market",
            question: "Will an AI benchmark be reached?",
            category: "Technology",
            active: true,
            closed: false,
            endDate: "2027-03-01T00:00:00.000Z",
            volume24hr: "4",
            liquidity: "5",
            clobTokenIds: ["t-yes", "t-no"]
          },
          {
            conditionId: "sports-condition",
            slug: "sports-market",
            question: "Will the team win?",
            category: "Sports",
            active: true,
            closed: false,
            endDate: "2027-04-01T00:00:00.000Z",
            volume24hr: "999",
            liquidity: "999",
            clobTokenIds: ["s-yes", "s-no"]
          }
        ]);
      }

      if (
        url.hostname === "gamma.test" &&
        url.pathname === "/public-profile"
      ) {
        return jsonResponse({
          proxyWallet: PROFILE_ADDRESS,
          createdAt: "2026-01-01T00:00:00.000Z"
        });
      }
      if (url.hostname === "clob.test" && url.pathname === "/book") {
        return jsonResponse({
          market: CONDITION_ID,
          asset_id: "token-yes",
          timestamp: String(NOW_MS - 1_000),
          tick_size: "0.01",
          min_order_size: "5",
          neg_risk: false,
          bids: [
            { price: "0.38", size: "20" },
            { price: "0.39", size: "10" }
          ],
          asks: [
            { price: "0.42", size: "5" },
            { price: "0.40", size: "10" }
          ]
        });
      }
      if (
        url.hostname === "clob.test" &&
        url.pathname === `/clob-markets/${CONDITION_ID}`
      ) {
        return jsonResponse({
          c: CONDITION_ID,
          t: [
            { t: "token-yes", o: "Yes" },
            { t: "token-no", o: "No" }
          ],
          mts: 0.01,
          mos: 5,
          nr: false,
          ao: true,
          fd: { r: 0.0012, e: 1, to: true }
        });
      }
      if (url.hostname === "clob.test" && url.pathname === "/fee-rate") {
        return jsonResponse({ base_fee: 12 });
      }
      if (url.hostname === "data.test" && url.pathname === "/positions") {
        return jsonResponse([
          {
            proxyWallet: PROFILE_ADDRESS,
            asset: "token-yes",
            conditionId: CONDITION_ID,
            title: "Will the election result be certified?",
            outcome: "Yes",
            size: "10.1234564",
            avgPrice: "0.4",
            curPrice: "0.45",
            currentValue: "4.5555555",
            cashPnl: "0.5",
            realizedPnl: "-0.1",
            endDate: "2027-12-01T00:00:00.000Z"
          }
        ]);
      }
      if (
        url.hostname === "data.test" &&
        url.pathname === "/closed-positions"
      ) {
        return jsonResponse([]);
      }
      if (
        url.hostname === "polymarket.test" &&
        url.pathname === "/api/geoblock"
      ) {
        return jsonResponse({
          blocked: false,
          country: "ES",
          region: "MD"
        });
      }
      throw new Error(`Unexpected test URL: ${url.origin}${url.pathname}`);
    };

    const client = new PolymarketPublicClient({
      gammaHost: "https://gamma.test",
      dataHost: "https://data.test",
      clobHost: "https://clob.test",
      geoblockHost: "https://polymarket.test",
      fetch: fetchMock,
      now: () => NOW_MS,
      sleep: async (delayMs) => {
        sleepDelays.push(delayMs);
      },
      random: () => 0
    });
    const marketDataPort: MarketDataPort = client;

    const candidates = await marketDataPort.scanCandidates([
      "politics",
      "economics",
      "technology"
    ]);
    expect(candidates.map((candidate) => candidate.category)).toEqual([
      "politics",
      "economics",
      "technology"
    ]);
    expect(candidates[0]).toMatchObject({
      volume24hMicros: 123_456_789n,
      liquidityMicros: 50_000_000n,
      spreadMicros: 20_000n
    });
    expect(sleepDelays).toEqual([150]);
    await expect(marketDataPort.profileExists(PROFILE_ADDRESS)).resolves.toBe(true);
    await expect(marketDataPort.checkGeoblock()).resolves.toEqual({
      blocked: false,
      country: "ES",
      region: "MD",
      checkedAtMs: NOW_MS
    });

    const snapshot = await client.getMarketSnapshot({
      conditionId: CONDITION_ID,
      tokenId: "token-yes",
      side: "BUY",
      limitPriceMicros: 410_000n
    });
    expect(snapshot).toMatchObject({
      outcome: "Yes",
      category: "politics",
      tickSizeMicros: 10_000n,
      minOrderSizeMicros: 5_000_000n,
      feesEnabled: true,
      feeRateBps: 12,
      bestBidMicros: 390_000n,
      bestAskMicros: 400_000n,
      spreadMicros: 10_000n,
      depthPusdMicrosAtLimit: 4_000_000n,
      capturedAtMs: NOW_MS - 1_000
    });

    const portfolio = await client.getPortfolio(PROFILE_ADDRESS);
    expect(portfolio.pUsdBalanceMicros).toBeNull();
    expect(portfolio.totalPositionValueMicros).toBe(4_555_556n);
    expect(portfolio.totalPnlMicros).toBe(400_000n);
    expect(portfolio.positions[0]).toMatchObject({
      sizeMicros: 10_123_456n,
      realizedPnlMicros: -100_000n
    });

    expect(requestedUrls).toHaveLength(10);
    expect(
      requestedUrls.every((url) => !url.includes(PROFILE_ADDRESS.slice(2, 10)))
    ).toBe(false);
  });
});

describe("authenticated CLOB adapter", () => {
  it("submits only an approved immutable V2 GTD order and cancels by payload", async () => {
    const proposal = approvedLiveProposal(NOW_MS);
    const posted: Array<{
      order: UserOrderV2;
      options: Partial<CreateOrderOptions> | undefined;
      orderType: OrderType.GTD;
      postOnly: boolean | undefined;
      deferExec: boolean | undefined;
    }> = [];
    const cancelPayloads: Array<{ orderID: string }> = [];
    let prepared:
      | {
          order: UserOrderV2;
          options: Partial<CreateOrderOptions> | undefined;
        }
      | undefined;
    const fakeClient = createFakeLiveClient({
      async createOrder(order, options) {
        prepared = { order, options };
        return makeSignedOrder(order);
      },
      async postOrder(_signedOrder, orderType, postOnly, deferExec) {
        posted.push({ ...prepared!, orderType, postOnly, deferExec });
        return successfulOrderResponse(_signedOrder);
      },
      async cancelOrder(payload) {
        cancelPayloads.push(payload);
        return { canceled: [payload.orderID], not_canceled: {} };
      }
    });
    const client = new PolymarketLiveClient({
      auth: liveAuthentication(),
      client: fakeClient,
      now: () => NOW_MS
    });

    const response = await client.executeStagedProposal(proposal);
    expect(response.response.orderID).toBe(response.evidence.orderHash);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      order: {
        tokenID: proposal.market.tokenId,
        price: 0.4,
        size: 10,
        side: Side.BUY,
        expiration: Math.floor(NOW_MS / 1_000) + 60 + 15 * 60,
        metadata: `0x${proposal.hash}`,
        builderCode: `0x${"00".repeat(32)}`
      },
      options: { tickSize: "0.01", negRisk: false, version: 2 },
      orderType: OrderType.GTD,
      postOnly: false,
      deferExec: true
    });

    await expect(client.cancelOrder("order-1")).resolves.toEqual({
      canceled: ["order-1"],
      notCanceled: {}
    });
    expect(cancelPayloads).toEqual([{ orderID: "order-1" }]);
  });

  it("rejects tampering before calling the SDK", async () => {
    const proposal = approvedLiveProposal(NOW_MS);
    proposal.limitPriceMicros = 410_000n;
    let submitCalls = 0;
    const fakeClient = createFakeLiveClient({
      async createOrder() {
        submitCalls += 1;
        return makeSignedOrder({
          tokenID: proposal.market.tokenId,
          price: 0.4,
          size: 10,
          side: Side.BUY
        });
      }
    });
    const client = new PolymarketLiveClient({
      auth: liveAuthentication(),
      client: fakeClient,
      now: () => NOW_MS
    });

    await expect(client.executeStagedProposal(proposal)).rejects.toMatchObject({
      code: "PROPOSAL_HASH_MISMATCH"
    });
    expect(submitCalls).toBe(0);
  });

  it("sanitizes SDK errors without retaining credentials", async () => {
    const proposal = approvedLiveProposal(NOW_MS);
    const fakeClient = createFakeLiveClient({
      async createOrder() {
        throw {
          status: 401,
          message: "secret=do-not-leak passphrase=also-private"
        };
      }
    });
    const client = new PolymarketLiveClient({
      auth: liveAuthentication(),
      client: fakeClient,
      now: () => NOW_MS
    });

    let caught: unknown;
    try {
      await client.executeStagedProposal(proposal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SafeExternalServiceError);
    expect((caught as Error).message).not.toContain("do-not-leak");
    expect((caught as Error).message).not.toContain("also-private");
  });

  it("serializes heartbeat requests and chains them every five seconds", async () => {
    let resolveFirst:
      | ((value: { heartbeat_id: string }) => void)
      | undefined;
    const heartbeatIds: string[] = [];
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const scheduler: HeartbeatScheduler = {
      schedule(callback, delayMs) {
        scheduled.push({ callback, delayMs });
        return callback;
      },
      cancel(handle) {
        const index = scheduled.findIndex((item) => item.callback === handle);
        if (index >= 0) {
          scheduled.splice(index, 1);
        }
      }
    };
    let heartbeatCallCount = 0;
    const fakeClient = createFakeLiveClient({
      postHeartbeat(heartbeatId = "") {
        heartbeatIds.push(heartbeatId);
        heartbeatCallCount += 1;
        if (heartbeatCallCount === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({ heartbeat_id: `heartbeat-${heartbeatCallCount}` });
      }
    });
    const client = new PolymarketLiveClient({
      auth: liveAuthentication(),
      client: fakeClient,
      now: () => NOW_MS,
      scheduler
    });

    const first = client.sendHeartbeatOnce();
    const concurrent = client.sendHeartbeatOnce();
    expect(concurrent).toBe(first);
    expect(heartbeatCallCount).toBe(1);
    resolveFirst?.({ heartbeat_id: "heartbeat-1" });
    await Promise.all([first, concurrent]);

    await client.startHeartbeat();
    expect(heartbeatIds).toEqual(["", "heartbeat-1"]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(5_000);

    scheduled[0]?.callback();
    await waitForMicrotasks();
    expect(heartbeatIds).toEqual(["", "heartbeat-1", "heartbeat-2"]);
    expect(scheduled).toHaveLength(2);
    client.stopHeartbeat();
  });

  it("cancels all orders and reports only sanitized heartbeat failures", async () => {
    let cancelAllCalls = 0;
    const fakeClient = createFakeLiveClient({
      async postHeartbeat() {
        throw new Error("api_key=heartbeat-secret");
      },
      async cancelAll() {
        cancelAllCalls += 1;
        return { canceled: ["open-order"], not_canceled: {} };
      }
    });
    const client = new PolymarketLiveClient({
      auth: liveAuthentication(),
      client: fakeClient
    });

    let caught: unknown;
    try {
      await client.startHeartbeat();
    } catch (error) {
      caught = error;
    }
    expect(cancelAllCalls).toBe(1);
    expect(caught).toBeInstanceOf(SafeExternalServiceError);
    expect((caught as Error).message).not.toContain("heartbeat-secret");
    expect(client.getHeartbeatState()).toMatchObject({
      running: false,
      lastHeartbeatId: null
    });
  });
});

function approvedLiveProposal(nowMs: number): OrderProposal {
  const intent = intentFixture(nowMs);
  intent.executionMode = "live";
  intent.sessionId = "fixture-session";
  const proposal = createOrderProposal(intent, riskContextFixture(nowMs));
  return { ...proposal, status: "EXECUTING" };
}

function liveAuthentication(): LiveAuthentication {
  const signer = {
    async getAddress() {
      return `0x${"c".repeat(40)}`;
    },
    async _signTypedData() {
      return `0x${"d".repeat(130)}`;
    }
  } as InjectedClobSigner;

  return {
    signer,
    creds: {
      key: "injected-key",
      secret: "injected-secret",
      passphrase: "injected-passphrase"
    },
    signatureType: SignatureTypeV2.POLY_PROXY,
    funderAddress: `0x${"e".repeat(40)}`
  };
}

function createFakeLiveClient(
  overrides: Partial<LiveClobClient> = {}
): LiveClobClient {
  const market = marketFixture(NOW_MS);
  const details: MarketDetails = {
    c: market.conditionId,
    t: [
      { t: market.tokenId, o: market.outcome },
      { t: "opposite-token", o: "No" }
    ],
    mts: 0.01,
    mos: 1,
    nr: false,
    r: null,
    ao: true,
    fd: { r: 0, e: 1, to: true }
  };

  return {
    async getClobMarketInfo() {
      return details;
    },
    async getFeeRateBps() {
      return market.feeRateBps;
    },
    async getVersion() {
      return 2;
    },
    async createOrder(order) {
      return makeSignedOrder(order);
    },
    async postOrder(order) {
      return successfulOrderResponse(order);
    },
    async cancelOrder(payload) {
      return { canceled: [payload.orderID], not_canceled: {} };
    },
    async cancelAll() {
      return { canceled: [], not_canceled: {} };
    },
    async postHeartbeat() {
      return { heartbeat_id: "heartbeat-default" };
    },
    ...overrides
  };
}

function successfulOrderResponse(order: SignedOrder): OrderResponse {
  return {
    success: true,
    errorMsg: "",
    orderID: signedOrderHash(order),
    status: "live",
    takingAmount: "4",
    makingAmount: "10"
  };
}

function makeSignedOrder(order: UserOrderV2): SignedOrder {
  const sizeMicros = BigInt(Math.round(order.size * 1_000_000));
  const priceMicros = BigInt(Math.round(order.price * 1_000_000));
  const costMicros = (sizeMicros * priceMicros) / 1_000_000n;
  return {
    salt: "1",
    maker: `0x${"e".repeat(40)}`,
    signer: `0x${"c".repeat(40)}`,
    tokenId: order.tokenID,
    makerAmount:
      order.side === Side.BUY
        ? costMicros.toString()
        : sizeMicros.toString(),
    takerAmount:
      order.side === Side.BUY
        ? sizeMicros.toString()
        : costMicros.toString(),
    side: order.side,
    signatureType: SignatureTypeV2.POLY_PROXY,
    timestamp: NOW_MS.toString(),
    metadata: order.metadata ?? `0x${"00".repeat(32)}`,
    builder: order.builderCode ?? `0x${"00".repeat(32)}`,
    expiration: String(order.expiration ?? 0),
    signature: `0x${"dd".repeat(65)}`
  };
}

function signedOrderHash(order: SignedOrder): `0x${string}` {
  if (!("metadata" in order) || !("timestamp" in order)) {
    throw new Error("Expected a V2 signed order fixture.");
  }
  return hashTypedData({
    domain: {
      name: "Polymarket CTF Exchange",
      version: "2",
      chainId: 137,
      verifyingContract: getContractConfig(Chain.POLYGON).exchangeV2 as `0x${string}`
    },
    types: {
      Order: [
        { name: "salt", type: "uint256" },
        { name: "maker", type: "address" },
        { name: "signer", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "makerAmount", type: "uint256" },
        { name: "takerAmount", type: "uint256" },
        { name: "side", type: "uint8" },
        { name: "signatureType", type: "uint8" },
        { name: "timestamp", type: "uint256" },
        { name: "metadata", type: "bytes32" },
        { name: "builder", type: "bytes32" }
      ]
    },
    primaryType: "Order",
    message: {
      salt: BigInt(String(order.salt)),
      maker: String(order.maker) as `0x${string}`,
      signer: String(order.signer) as `0x${string}`,
      tokenId: BigInt(String(order.tokenId)),
      makerAmount: BigInt(String(order.makerAmount)),
      takerAmount: BigInt(String(order.takerAmount)),
      side: order.side === Side.BUY ? 0 : 1,
      signatureType: order.signatureType,
      timestamp: BigInt(String(order.timestamp)),
      metadata: String(order.metadata) as `0x${string}`,
      builder: String(order.builder) as `0x${string}`
    }
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function waitForMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
