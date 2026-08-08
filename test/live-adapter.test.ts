import {
  Chain,
  ClobClient,
  Side,
  SignatureTypeV2,
  getContractConfig,
  type ClobClientOptions,
  type MarketDetails,
  type OrderResponse,
  type SignedOrder,
  type UserOrderV2
} from "@polymarket/clob-client-v2";
import { bytesToHex, hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { createOrderProposal } from "../src/domain/proposals.js";
import type { OrderProposal } from "../src/domain/types.js";
import {
  GuardedLiveTradingAdapter,
  readClobVersion,
  type GuardedLiveTradingOptions
} from "../src/polymarket/live-adapter.js";
import type { HeartbeatScheduler } from "../src/polymarket/live-client.js";
import type { PolymarketUserChannelMonitor } from "../src/polymarket/user-channel-monitor.js";
import type { TradingDatabase } from "../src/storage/database.js";
import {
  intentFixture,
  riskContextFixture
} from "./fixtures.js";

const NOW_MS = 1_800_000_000_000;
const PROFILE_ADDRESS = `0x${"a".repeat(40)}`;
const FIXTURE_PRIVATE_KEY = new Uint8Array(32).fill(7);
const SIGNER_ADDRESS = privateKeyToAccount(
  bytesToHex(FIXTURE_PRIVATE_KEY)
).address;
const EXCHANGE_ADDRESS =
  getContractConfig(Chain.POLYGON).exchangeV2.toLowerCase();

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface ScheduledHeartbeat {
  callback: () => void;
  delayMs: number;
  canceled: boolean;
}

interface RawClientControl {
  alterSaltAfterSigning?: boolean;
  closedOnly?: boolean;
  postOrder?: (order: SignedOrder) => Promise<OrderResponse>;
  postHeartbeat?: (
    heartbeatId?: string
  ) => Promise<{ heartbeat_id: string; error_msg?: string }>;
  cancelAll?: () => Promise<unknown>;
}

type RawClientDouble = ReturnType<typeof createRawClientDouble>;

describe("guarded live adapter lifecycle", () => {
  it("reads the authenticated collateral balance without signing", async () => {
    const harness = createHarness([{}]);

    await expect(
      harness.adapter.getVerifiedCollateralBalance()
    ).resolves.toBe(1_000_000_000n);
    expect(harness.rawClients[0]?.getBalanceAllowance).toHaveBeenCalledWith({
      asset_type: "COLLATERAL"
    });
    harness.adapter.close();
  });

  it("blocks a non-V2 CLOB version before signing", async () => {
    const harness = createHarness(
      [{}],
      async () => encodedFixtureCredentials(),
      1
    );

    await expect(
      harness.adapter.submitGtd(approvedProposal(), async () => {})
    ).rejects.toMatchObject({ code: "CLOB_VERSION_UNSUPPORTED" });
    expect(harness.rawClients[0]?.createOrder).not.toHaveBeenCalled();
    expect(harness.database.getEmergencyStop().active).toBe(true);
    harness.adapter.close();
  });

  it("fails closed for missing, malformed, and unsuccessful CLOB version responses", async () => {
    const fetchResponse = (payload: unknown, status = 200): Response =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" }
      });
    const fetchStub = vi.fn<typeof fetch>(async () => fetchResponse({}));

    await expect(
      readClobVersion("https://clob.example.test/", fetchStub)
    ).rejects.toMatchObject({ code: "CLOB_VERSION_INDETERMINATE" });

    fetchStub.mockResolvedValueOnce(fetchResponse({ version: "2" }));
    await expect(
      readClobVersion("https://clob.example.test", fetchStub)
    ).rejects.toMatchObject({ code: "CLOB_VERSION_INDETERMINATE" });

    fetchStub.mockResolvedValueOnce(fetchResponse({ error: "upstream" }, 503));
    await expect(
      readClobVersion("https://clob.example.test", fetchStub)
    ).rejects.toMatchObject({ code: "CLOB_VERSION_HTTP_ERROR" });

    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(fetchStub.mock.calls[0]?.[0]).toBe(
      "https://clob.example.test/version"
    );
  });

  it("accepts only a positive integer V2 version from the probe", async () => {
    const fetchStub = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ version: 2 }), { status: 200 })
    );
    await expect(
      readClobVersion("https://clob.example.test", fetchStub)
    ).resolves.toBe(2);
  });

  it("locks and cancels when the safety supervisor cannot verify state", async () => {
    const harness = createHarness(
      [{}, {}],
      async () => encodedFixtureCredentials(),
      2,
      async () => {
        throw new Error("indeterminate safety state");
      }
    );

    await harness.adapter.submitGtd(approvedProposal(), async () => {});
    await expect(harness.adapter.startHeartbeat()).rejects.toThrow(
      "indeterminate safety state"
    );

    expect(harness.database.getEmergencyStop()).toMatchObject({
      active: true,
      reason: "LIVE_SAFETY_SUPERVISOR_FAILED"
    });
    expect(harness.rawClients[1]?.cancelAll).toHaveBeenCalledTimes(1);
    expect(harness.schedulerState.scheduled[0]?.canceled).toBe(true);
    harness.adapter.close();
  });

  it("keeps the prior heartbeat until the replacement client proves healthy", async () => {
    const replacementHeartbeat =
      deferred<{ heartbeat_id: string }>();
    const harness = createHarness([
      {},
      {},
      {},
      {
        postHeartbeat() {
          return replacementHeartbeat.promise;
        }
      }
    ]);
    const firstSchedule = harness.schedulerState.scheduled;

    await harness.adapter.submitGtd(approvedProposal(), async () => {});
    await harness.adapter.startHeartbeat();
    expect(firstSchedule).toHaveLength(1);
    expect(firstSchedule[0]).toMatchObject({
      delayMs: 5_000,
      canceled: false
    });

    await harness.adapter.submitGtd(approvedProposal(), async () => {});
    const handoff = harness.adapter.startHeartbeat();
    const concurrentHandoff = harness.adapter.startHeartbeat();
    await waitForMicrotasks();

    expect(harness.rawClients[3]?.postHeartbeat).toHaveBeenCalledTimes(1);
    expect(firstSchedule[0]?.canceled).toBe(false);
    await expect(
      harness.adapter.submitGtd(approvedProposal(), async () => {})
    ).rejects.toMatchObject({ code: "LIVE_SUBMISSION_IN_PROGRESS" });

    replacementHeartbeat.resolve({ heartbeat_id: "replacement-heartbeat" });
    await Promise.all([handoff, concurrentHandoff]);

    expect(firstSchedule).toHaveLength(2);
    expect(firstSchedule[0]?.canceled).toBe(true);
    expect(firstSchedule[1]).toMatchObject({
      delayMs: 5_000,
      canceled: false
    });
    harness.adapter.close();
  });

  it("aborts an in-flight second order when emergency stop races its response", async () => {
    const postEntered = deferred<void>();
    const postResponse = deferred<OrderResponse>();
    const harness = createHarness([
      {},
      {},
      {
        async postOrder() {
          postEntered.resolve();
          return postResponse.promise;
        }
      },
      {}
    ]);

    await harness.adapter.submitGtd(approvedProposal(), async () => {});
    await harness.adapter.startHeartbeat();
    const oldHeartbeat = harness.schedulerState.scheduled[0];

    const submission = harness.adapter.submitGtd(
      approvedProposal(),
      async () => {}
    );
    await postEntered.promise;

    harness.database.setEmergencyStop(true, "TEST_EMERGENCY", NOW_MS);
    await harness.adapter.cancelAll();

    expect(oldHeartbeat?.canceled).toBe(true);
    expect(harness.rawClients[2]?.cancelAll).toHaveBeenCalledTimes(1);

    postResponse.resolve(successfulResponse("late-order"));
    await expect(submission).rejects.toMatchObject({
      code: "SUBMISSION_ABORTED_AFTER_POST"
    });
    expect(harness.rawClients[2]?.cancelOrder).toHaveBeenCalledWith({
      orderID: "late-order"
    });
    expect(harness.rawClients[2]?.cancelAll).toHaveBeenCalledTimes(2);
    expect(harness.database.getEmergencyStop().active).toBe(true);
    harness.adapter.close();
  });

  it("locks first and cancels all after an ambiguous submission response", async () => {
    let lockWasActiveAtCancellation = false;
    const harness = createHarness([
      {
        async postOrder() {
          throw new Error("controlled transport failure");
        },
        async cancelAll() {
          lockWasActiveAtCancellation =
            harness.database.getEmergencyStop().active;
          return { canceled: [], not_canceled: {} };
        }
      }
    ]);

    await expect(
      harness.adapter.submitGtd(approvedProposal(), async () => {})
    ).rejects.toMatchObject({ code: "CLOB_ORDER_SUBMISSION_UNKNOWN" });

    expect(lockWasActiveAtCancellation).toBe(true);
    expect(harness.rawClients[0]?.cancelAll).toHaveBeenCalledTimes(1);
    expect(harness.database.getEmergencyStop()).toMatchObject({
      active: true,
      reason: "CLOB_ORDER_SUBMISSION_UNKNOWN"
    });
    harness.adapter.close();
  });

  it("blocks before signing or posting when the account is closed-only", async () => {
    const harness = createHarness([{ closedOnly: true }]);

    await expect(
      harness.adapter.submitGtd(approvedProposal(), async () => {})
    ).rejects.toMatchObject({
      code: "ACCOUNT_CLOSED_ONLY_OR_INDETERMINATE"
    });

    expect(harness.rawClients[0]?.createOrder).not.toHaveBeenCalled();
    expect(harness.rawClients[0]?.postOrder).not.toHaveBeenCalled();
    expect(harness.database.getEmergencyStop()).toMatchObject({
      active: true,
      reason: "ACCOUNT_CLOSED_ONLY_OR_INDETERMINATE"
    });
    harness.adapter.close();
  });

  it("blocks before POST if the SDK mutates the order after signing", async () => {
    const harness = createHarness([{ alterSaltAfterSigning: true }]);

    await expect(
      harness.adapter.submitGtd(approvedProposal(), async () => {})
    ).rejects.toMatchObject({ code: "SIGNER_ORDER_HASH_MISMATCH" });

    expect(harness.rawClients[0]?.postOrder).not.toHaveBeenCalled();
    expect(harness.database.getEmergencyStop()).toMatchObject({
      active: true,
      reason: "SIGNER_ORDER_HASH_MISMATCH"
    });
    harness.adapter.close();
  });

  it("reserves submission before Keychain I/O and releases it after failure", async () => {
    const firstKeychainRead = deferred<Uint8Array>();
    let readCount = 0;
    const harness = createHarness(
      [{}, {}],
      async () => {
        readCount += 1;
        if (readCount === 1) {
          return firstKeychainRead.promise;
        }
        return encodedFixtureCredentials();
      }
    );

    const first = harness.adapter.submitGtd(
      approvedProposal(),
      async () => {}
    );
    await waitForMicrotasks();

    await expect(
      harness.adapter.submitGtd(approvedProposal(), async () => {})
    ).rejects.toMatchObject({ code: "LIVE_SUBMISSION_IN_PROGRESS" });
    expect(readCount).toBe(1);

    firstKeychainRead.reject(new Error("controlled Keychain failure"));
    await expect(first).rejects.toThrow("controlled Keychain failure");

    await expect(
      harness.adapter.submitGtd(approvedProposal(), async () => {})
    ).resolves.toMatchObject({ orderId: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(readCount).toBe(2);
    harness.adapter.close();
  });
});

function createHarness(
  controls: RawClientControl[],
  readL2Credentials: () => Promise<Uint8Array> = async () =>
    encodedFixtureCredentials(),
  clobVersion = 2,
  safetyCheck?: () => Promise<boolean>
): {
  adapter: GuardedLiveTradingAdapter;
  database: TradingDatabase;
  rawClients: RawClientDouble[];
  schedulerState: { scheduled: ScheduledHeartbeat[] };
} {
  let emergency = { active: false, reason: "", updatedAtMs: 0 };
  const database = {
    getAccountBinding() {
      return {
        profileAddress: PROFILE_ADDRESS,
        funderAddress: PROFILE_ADDRESS,
        signerAddress: SIGNER_ADDRESS,
        signatureType: 1 as const,
        verifiedAtMs: NOW_MS
      };
    },
    getEmergencyStop() {
      return { ...emergency };
    },
    setEmergencyStop(active: boolean, reason: string, updatedAtMs: number) {
      emergency = { active, reason, updatedAtMs };
    },
    setLiveActivation() {
      // Lifecycle tests use an in-memory state double.
    },
    listExecutions() {
      return [];
    }
  } as unknown as TradingDatabase;

  const keychain = {
    async status() {
      return { exists: true };
    },
    readL2Credentials,
    async readSocialPrivateKey() {
      return new Uint8Array(32).fill(7);
    }
  };
  const schedulerState = { scheduled: [] as ScheduledHeartbeat[] };
  const scheduler: HeartbeatScheduler = {
    schedule(callback, delayMs) {
      const handle = { callback, delayMs, canceled: false };
      schedulerState.scheduled.push(handle);
      return handle;
    },
    cancel(handle) {
      (handle as ScheduledHeartbeat).canceled = true;
    }
  };
  const rawClients: RawClientDouble[] = [];
  let nextControl = 0;
  const options: GuardedLiveTradingOptions = {
    database,
    keychain,
    profileAddress: PROFILE_ADDRESS,
    now: () => NOW_MS,
    clobVersionReader: async () => clobVersion,
    ...(safetyCheck === undefined ? {} : { safetyCheck }),
    heartbeatScheduler: scheduler,
    userChannelMonitorFactory() {
      return {
        async start() {
          return undefined;
        },
        stop() {
          return undefined;
        },
        status() {
          return {
            state: "running",
            awaitingPong: false,
            subscribedMarketCount: 1,
            pendingEventCount: 0,
            lastMessageAtMs: NOW_MS
          };
        }
      } as unknown as PolymarketUserChannelMonitor;
    },
    clobClientFactory(clientOptions) {
      const control = controls[nextControl];
      if (control === undefined) {
        throw new Error("No controlled CLOB client remains.");
      }
      nextControl += 1;
      if (clientOptions.signer === undefined) {
        throw new Error("Controlled CLOB client requires a signer.");
      }
      const raw = createRawClientDouble(control, clientOptions.signer);
      rawClients.push(raw);
      return raw as unknown as ClobClient;
    }
  };

  return {
    adapter: new GuardedLiveTradingAdapter(options),
    database,
    rawClients,
    schedulerState
  };
}

function createRawClientDouble(
  control: RawClientControl,
  signer: NonNullable<ClobClientOptions["signer"]>
) {
  const typedDataSigner = signer as unknown as {
    _signTypedData(
      domain: Record<string, unknown>,
      types: Record<string, Array<{ name: string; type: string }>>,
      value: Record<string, unknown>
    ): Promise<string>;
  };
  const market = intentFixture(NOW_MS).market;
  const details: MarketDetails = {
    c: market.conditionId,
    t: [
      { t: market.tokenId, o: market.outcome },
      { t: "controlled-opposite-token", o: "No" }
    ],
    mts: 0.01,
    mos: 1,
    nr: false,
    r: null,
    ao: true,
    fd: { r: 0, e: 1, to: true }
  };
  return {
    getClobMarketInfo: vi.fn(async () => details),
    getFeeRateBps: vi.fn(async () => 0),
    getVersion: vi.fn(async () => 2),
    getBalanceAllowance: vi.fn(async () => ({
      balance: "1000000000",
      allowances: { [EXCHANGE_ADDRESS]: "1000000000" }
    })),
    getOpenOrders: vi.fn(async () => []),
    getClosedOnlyMode: vi.fn(async () => ({
      closed_only: control.closedOnly ?? false
    })),
    createOrder: vi.fn(async (order: UserOrderV2) => {
      const signedOrder = makeSignedOrder(order);
      const signature = await typedDataSigner._signTypedData(
        {
          name: "Polymarket CTF Exchange",
          version: "2",
          chainId: 137,
          verifyingContract: EXCHANGE_ADDRESS
        },
        {
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
        {
          salt: signedOrder.salt,
          maker: signedOrder.maker,
          signer: signedOrder.signer,
          tokenId: signedOrder.tokenId,
          makerAmount: signedOrder.makerAmount,
          takerAmount: signedOrder.takerAmount,
          side: signedOrder.side === Side.BUY ? 0 : 1,
          signatureType: signedOrder.signatureType,
          timestamp: signedOrder.timestamp,
          metadata: signedOrder.metadata,
          builder: signedOrder.builder
        }
      );
      return {
        ...signedOrder,
        ...(control.alterSaltAfterSigning ? { salt: "2" } : {}),
        signature
      };
    }),
    postOrder: vi.fn(
      control.postOrder ??
        (async (order: SignedOrder) => successfulResponse(order))
    ),
    cancelOrder: vi.fn(async (payload: { orderID: string }) => ({
      canceled: [payload.orderID],
      not_canceled: {}
    })),
    cancelAll: vi.fn(
      control.cancelAll ??
        (async () => ({ canceled: [], not_canceled: {} }))
    ),
    postHeartbeat: vi.fn(
      control.postHeartbeat ??
        (async () => ({ heartbeat_id: "healthy-heartbeat" }))
    ),
    getOrder: vi.fn()
  };
}

function approvedProposal(): OrderProposal {
  const intent = intentFixture(NOW_MS);
  intent.executionMode = "live";
  intent.sessionId = "fixture-session";
  const proposal = createOrderProposal(intent, riskContextFixture(NOW_MS));
  return { ...proposal, status: "EXECUTING" };
}

function successfulResponse(order: SignedOrder | string): OrderResponse {
  return {
    success: true,
    errorMsg: "",
    orderID:
      typeof order === "string" ? order : signedOrderHash(order),
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
    maker: PROFILE_ADDRESS,
    signer: SIGNER_ADDRESS,
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
    throw new Error("Expected V2 signed order fixture.");
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

function encodedFixtureCredentials(): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      key: "fixture-only-key",
      secret: "fixture-only-secret",
      passphrase: "fixture-only-passphrase"
    }),
    "utf8"
  );
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise
  };
}

async function waitForMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
