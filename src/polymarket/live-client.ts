import {
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  getContractConfig,
  isV2Order,
  type ApiKeyCreds,
  type ClobClientOptions,
  type CreateOrderOptions,
  type MarketDetails,
  type OrderResponse,
  type SignedOrder,
  type TickSize,
  type UserOrderV2
} from "@polymarket/clob-client-v2";
import { hashTypedData, type Address, type Hex } from "viem";
import { verifyProposalHash } from "../domain/proposals.js";
import { DEFAULT_RISK_POLICY } from "../domain/risk-policy.js";
import {
  PUSD_SCALE,
  formatMicros,
  type OrderProposal
} from "../domain/types.js";
import { parseApiDecimalToMicros } from "./public-client.js";
import {
  SafeExternalServiceError,
  sanitizeErrorMessage,
  toSafeExternalError
} from "./safe-error.js";

const DEFAULT_CLOB_HOST = "https://clob.polymarket.com";
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const CANCELLATION_TIMEOUT_MS = 10_000;
const GTD_SERVER_BUFFER_SECONDS = 60;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as const;
const ALLOWED_TICK_SIZES = new Set<TickSize>([
  "0.1",
  "0.01",
  "0.005",
  "0.0025",
  "0.001",
  "0.0001"
]);
const ORDER_EIP712_TYPES = [
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
] as const;

export type InjectedClobSigner = NonNullable<ClobClientOptions["signer"]>;

export interface LiveAuthentication {
  signer: InjectedClobSigner;
  creds: ApiKeyCreds;
  signatureType: SignatureTypeV2.POLY_PROXY | SignatureTypeV2.POLY_1271;
  funderAddress: string;
}

export interface LiveClobClient {
  getClobMarketInfo(conditionId: string): Promise<MarketDetails>;
  getFeeRateBps(tokenId: string): Promise<number>;
  getVersion(): Promise<number>;
  createOrder(
    userOrder: UserOrderV2,
    options: Partial<CreateOrderOptions> | undefined
  ): Promise<SignedOrder>;
  postOrder(
    order: SignedOrder,
    orderType: OrderType.GTD,
    postOnly?: boolean,
    deferExec?: boolean
  ): Promise<OrderResponse>;
  cancelOrder(payload: { orderID: string }): Promise<unknown>;
  cancelAll(): Promise<unknown>;
  postHeartbeat(heartbeatId?: string): Promise<{
    heartbeat_id: string;
    error_msg?: string;
  }>;
}

export type LiveClobClientFactory = (
  options: ClobClientOptions
) => LiveClobClient;

export interface HeartbeatScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface LiveClientOptions {
  auth: LiveAuthentication;
  host?: string;
  client?: LiveClobClient;
  clientFactory?: LiveClobClientFactory;
  now?: () => number;
  scheduler?: HeartbeatScheduler;
  onHeartbeatFailure?: (
    error: SafeExternalServiceError
  ) => void | Promise<void>;
  signedOrderHashEvidence?: () => string | null;
}

export interface CancelResult {
  canceled: string[];
  notCanceled: Record<string, string>;
}

export interface HeartbeatState {
  running: boolean;
  inFlight: boolean;
  lastHeartbeatId: string | null;
  lastError: SafeExternalServiceError | null;
}

export interface SubmittedOrderEvidence {
  orderHash: `0x${string}`;
  metadata: `0x${string}`;
  builder: `0x${string}`;
  expiration: number;
  timestampMs: number;
  makerAmountMicros: bigint;
  takerAmountMicros: bigint;
}

export interface SubmittedOrder {
  response: OrderResponse;
  evidence: SubmittedOrderEvidence;
}

/**
 * Narrow authenticated adapter. It has no methods for arbitrary signatures,
 * transfers, withdrawals, allowance changes, or API-key derivation.
 */
export class PolymarketLiveClient {
  private readonly client: LiveClobClient;
  private readonly auth: LiveAuthentication;
  private readonly now: () => number;
  private readonly scheduler: HeartbeatScheduler;
  private readonly onHeartbeatFailure:
    | ((error: SafeExternalServiceError) => void | Promise<void>)
    | undefined;
  private readonly signedOrderHashEvidence:
    | (() => string | null)
    | undefined;

  private heartbeatRunning = false;
  private heartbeatId = "";
  private heartbeatHandle: unknown;
  private heartbeatPromise: Promise<void> | undefined;
  private heartbeatError: SafeExternalServiceError | null = null;

  constructor(options: LiveClientOptions) {
    validateAuthentication(options.auth);
    this.auth = options.auth;
    const host = normalizeHost(options.host ?? DEFAULT_CLOB_HOST);
    if (options.client !== undefined && options.clientFactory !== undefined) {
      throw new Error("Provide either client or clientFactory, not both.");
    }

    const factory: LiveClobClientFactory =
      options.clientFactory ??
      ((clientOptions) =>
        new ClobClient(clientOptions) as unknown as LiveClobClient);
    this.client =
      options.client ??
      factory({
        host,
        chain: Chain.POLYGON,
        signer: options.auth.signer,
        creds: options.auth.creds,
        signatureType: options.auth.signatureType,
        funderAddress: options.auth.funderAddress,
        useServerTime: true,
        retryOnError: false,
        throwOnError: true
      });
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultHeartbeatScheduler;
    this.onHeartbeatFailure = options.onHeartbeatFailure;
    this.signedOrderHashEvidence = options.signedOrderHashEvidence;
  }

  async executeApprovedProposal(
    proposal: OrderProposal
  ): Promise<SubmittedOrder> {
    this.assertProposalCanExecute(proposal);

    let marketInfo: MarketDetails;
    let tokenFeeRateBps: number;
    let clobVersion: number;
    try {
      [marketInfo, tokenFeeRateBps, clobVersion] = await Promise.all([
        this.client.getClobMarketInfo(proposal.market.conditionId),
        this.client.getFeeRateBps(proposal.market.tokenId),
        this.client.getVersion()
      ]);
    } catch (error) {
      throw toSafeExternalError(error, {
        code: "CLOB_MARKET_INFO_ERROR",
        service: "clob",
        fallbackMessage: "Could not refresh the CLOB market."
      });
    }
    if (clobVersion !== 2) {
      throw new SafeExternalServiceError(
        "The CLOB order version changed and requires a new security review.",
        {
          code: "CLOB_VERSION_UNSUPPORTED",
          service: "clob",
          retryable: false
        }
      );
    }
    const orderOptions = validateFreshMarket(
      proposal,
      marketInfo,
      tokenFeeRateBps
    );
    const expiration =
      Math.floor(this.now() / 1_000) +
      GTD_SERVER_BUFFER_SECONDS +
      Math.ceil(DEFAULT_RISK_POLICY.effectiveGtdMs / 1_000);
    const userOrder: UserOrderV2 = {
      tokenID: proposal.market.tokenId,
      price: microsToSdkNumber(proposal.limitPriceMicros, "limit price"),
      size: microsToSdkNumber(proposal.sharesMicros, "share size"),
      side: proposal.side === "BUY" ? Side.BUY : Side.SELL,
      expiration,
      metadata: `0x${proposal.hash}`,
      builderCode: ZERO_BYTES32
    };

    let signedOrder: SignedOrder;
    try {
      signedOrder = await this.client.createOrder(userOrder, orderOptions);
    } catch (error) {
      throw toSafeExternalError(error, {
        code: "CLOB_ORDER_SIGNING_ERROR",
        service: "clob",
        fallbackMessage: "The approved CLOB order could not be prepared."
      });
    }
    const evidence = await validateAndHashSignedOrder(
      proposal,
      signedOrder,
      expiration,
      this.auth,
      this.now()
    );
    if (this.signedOrderHashEvidence !== undefined) {
      const signerHash = this.signedOrderHashEvidence();
      if (
        typeof signerHash !== "string" ||
        signerHash.toLowerCase() !== evidence.orderHash
      ) {
        throw new SafeExternalServiceError(
          "The signed EIP-712 payload does not match the prepared CLOB order.",
          {
            code: "SIGNER_ORDER_HASH_MISMATCH",
            service: "local",
            retryable: false
          }
        );
      }
    }

    let response: OrderResponse;
    try {
      response = await this.client.postOrder(
        signedOrder,
        OrderType.GTD,
        false,
        true
      );
    } catch (error) {
      process.stderr.write(`[post-order-debug] ${error instanceof Error ? (error as any).stack ?? error.message : JSON.stringify(error)}\n`);
      throw toSafeExternalError(error, {
        code: "CLOB_ORDER_SUBMISSION_ERROR",
        service: "clob",
        fallbackMessage: "The CLOB rejected the order submission."
      });
    }

    if (
      response === null ||
      typeof response !== "object" ||
      response.success !== true ||
      typeof response.orderID !== "string" ||
      response.orderID.toLowerCase() !== evidence.orderHash
    ) {
      const message =
        response !== null &&
        typeof response === "object" &&
        typeof response.errorMsg === "string" &&
        response.errorMsg.length > 0
          ? response.errorMsg
          : "The CLOB did not confirm the order.";
      throw toSafeExternalError(
        { message },
        {
          code: "CLOB_ORDER_REJECTED",
          service: "clob",
          fallbackMessage: "The CLOB rejected the order."
        }
      );
    }

    return { response, evidence };
  }

  async cancelOrder(orderId: string): Promise<CancelResult> {
    if (orderId.trim().length === 0) {
      throw new Error("orderId is required.");
    }
    try {
      return normalizeCancelResult(
        await this.client.cancelOrder({ orderID: orderId })
      );
    } catch (error) {
      throw toSafeExternalError(error, {
        code: "CLOB_CANCEL_ERROR",
        service: "clob",
        fallbackMessage: "The CLOB order could not be cancelled."
      });
    }
  }

  async cancelAll(): Promise<CancelResult> {
    try {
      return normalizeCancelResult(await this.client.cancelAll());
    } catch (error) {
      throw toSafeExternalError(error, {
        code: "CLOB_CANCEL_ALL_ERROR",
        service: "clob",
        fallbackMessage: "Open CLOB orders could not be cancelled."
      });
    }
  }

  /**
   * Starts the five-second heartbeat chain and waits for its first response.
   * Each subsequent timer is created only after the prior request completes.
   */
  async startHeartbeat(): Promise<void> {
    if (this.heartbeatRunning) {
      return;
    }
    this.heartbeatRunning = true;
    this.heartbeatError = null;
    await this.runHeartbeatCycle(true);
  }

  stopHeartbeat(): void {
    this.heartbeatRunning = false;
    if (this.heartbeatHandle !== undefined) {
      this.scheduler.cancel(this.heartbeatHandle);
      this.heartbeatHandle = undefined;
    }
    this.heartbeatId = "";
  }

  getHeartbeatState(): HeartbeatState {
    return {
      running: this.heartbeatRunning,
      inFlight: this.heartbeatPromise !== undefined,
      lastHeartbeatId: this.heartbeatId.length === 0 ? null : this.heartbeatId,
      lastError: this.heartbeatError
    };
  }

  /**
   * Public for deterministic health checks and tests. Concurrent callers share
   * the same request, so heartbeat requests can never overlap.
   */
  sendHeartbeatOnce(): Promise<void> {
    if (this.heartbeatPromise !== undefined) {
      return this.heartbeatPromise;
    }

    const operation = this.performHeartbeat();
    this.heartbeatPromise = operation;
    const clearOperation = (): void => {
      if (this.heartbeatPromise === operation) {
        this.heartbeatPromise = undefined;
      }
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }

  private async performHeartbeat(): Promise<void> {
    try {
      const response = await withTimeout(
        this.client.postHeartbeat(this.heartbeatId),
        HEARTBEAT_TIMEOUT_MS,
        "The CLOB heartbeat timed out."
      );
      if (
        response === null ||
        typeof response !== "object" ||
        typeof response.heartbeat_id !== "string" ||
        response.heartbeat_id.length === 0
      ) {
        throw new Error("The heartbeat response was malformed.");
      }
      if (
        typeof response.error_msg === "string" &&
        response.error_msg.trim().length > 0
      ) {
        throw new Error(response.error_msg);
      }
      this.heartbeatId = response.heartbeat_id;
    } catch (error) {
      throw toSafeExternalError(error, {
        code: "CLOB_HEARTBEAT_ERROR",
        service: "clob",
        fallbackMessage: "The CLOB heartbeat failed."
      });
    }
  }

  private async runHeartbeatCycle(propagateError: boolean): Promise<void> {
    try {
      await this.sendHeartbeatOnce();
    } catch (error) {
      const safeError = toSafeExternalError(error, {
        code: "CLOB_HEARTBEAT_ERROR",
        service: "clob"
      });
      await this.handleHeartbeatFailure(safeError);
      if (propagateError) {
        throw safeError;
      }
      return;
    }

    if (!this.heartbeatRunning) {
      return;
    }
    this.heartbeatHandle = this.scheduler.schedule(() => {
      this.heartbeatHandle = undefined;
      void this.runHeartbeatCycle(false);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private async handleHeartbeatFailure(
    error: SafeExternalServiceError
  ): Promise<void> {
    this.heartbeatError = error;
    this.stopHeartbeat();
    if (this.onHeartbeatFailure !== undefined) {
      try {
        await this.onHeartbeatFailure(error);
      } catch {
        // The caller must make its lock callback idempotent and non-throwing.
      }
    }
    try {
      await withTimeout(
        this.cancelAll(),
        CANCELLATION_TIMEOUT_MS,
        "CLOB cancellation timed out."
      );
    } catch {
      // Heartbeat loss is already the primary error; cancellation is best effort.
    }
  }

  private assertProposalCanExecute(proposal: OrderProposal): void {
    if (proposal.executionMode !== "live") {
      throw new SafeExternalServiceError(
        "A paper proposal cannot be submitted to the live CLOB.",
        {
          code: "LIVE_EXECUTION_MODE_REQUIRED",
          service: "local",
          retryable: false
        }
      );
    }
    if (proposal.status !== "LOCALLY_APPROVED") {
      throw new SafeExternalServiceError(
        "The proposal has not received local approval.",
        {
          code: "LOCAL_APPROVAL_REQUIRED",
          service: "local",
          retryable: false
        }
      );
    }
    if (!verifyProposalHash(proposal)) {
      throw new SafeExternalServiceError(
        "The approved proposal hash does not match its immutable contents.",
        {
          code: "PROPOSAL_HASH_MISMATCH",
          service: "local",
          retryable: false
        }
      );
    }
    if (proposal.expiresAtMs <= this.now()) {
      throw new SafeExternalServiceError("The approved proposal has expired.", {
        code: "PROPOSAL_EXPIRED",
        service: "local",
        retryable: false
      });
    }
    if (
      proposal.limitPriceMicros <= 0n ||
      proposal.limitPriceMicros >= PUSD_SCALE ||
      proposal.sharesMicros <= 0n ||
      proposal.market.tickSizeMicros <= 0n ||
      proposal.limitPriceMicros % proposal.market.tickSizeMicros !== 0n
    ) {
      throw new SafeExternalServiceError(
        "The approved order contains invalid price, size, or tick values.",
        {
          code: "INVALID_APPROVED_ORDER",
          service: "local",
          retryable: false
        }
      );
    }
  }
}

function validateFreshMarket(
  proposal: OrderProposal,
  marketInfo: MarketDetails,
  tokenFeeRateBps: number
): Partial<CreateOrderOptions> {
  if (marketInfo.c.toLowerCase() !== proposal.market.conditionId.toLowerCase()) {
    throw new SafeExternalServiceError(
      "The refreshed CLOB market does not match the approved market.",
      {
        code: "CLOB_MARKET_MISMATCH",
        service: "clob",
        retryable: false
      }
    );
  }
  if (!marketInfo.t.some((token) => token.t === proposal.market.tokenId)) {
    throw new SafeExternalServiceError(
      "The approved outcome token is absent from the refreshed CLOB market.",
      {
        code: "CLOB_TOKEN_MISMATCH",
        service: "clob",
        retryable: false
      }
    );
  }
  if (marketInfo.ao !== true) {
    throw new SafeExternalServiceError(
      "The refreshed CLOB market is not accepting orders.",
      {
        code: "CLOB_MARKET_NOT_TRADEABLE",
        service: "clob",
        retryable: false
      }
    );
  }

  const tickSize = toTickSize(marketInfo.mts);
  const tickMicros = parseApiDecimalToMicros(tickSize);
  if (
    tickMicros !== proposal.market.tickSizeMicros ||
    proposal.limitPriceMicros % tickMicros !== 0n
  ) {
    throw new SafeExternalServiceError(
      "The market tick size changed after approval.",
      {
        code: "CLOB_TICK_CHANGED",
        service: "clob",
        retryable: false
      }
    );
  }

  if (
    marketInfo.nr !== undefined &&
    typeof marketInfo.nr !== "boolean"
  ) {
    throw new SafeExternalServiceError(
      "The refreshed CLOB market omitted its negRisk setting.",
      {
        code: "CLOB_NEGRISK_INDETERMINATE",
        service: "clob",
        retryable: false
      }
    );
  }
  const negRisk = marketInfo.nr ?? false;
  if (negRisk !== proposal.market.negRisk) {
    throw new SafeExternalServiceError(
      "The market negRisk setting changed after approval.",
      {
        code: "CLOB_NEGRISK_CHANGED",
        service: "clob",
        retryable: false
      }
    );
  }
  if (
    !Number.isSafeInteger(tokenFeeRateBps) ||
    tokenFeeRateBps < 0 ||
    tokenFeeRateBps > 100_000
  ) {
    throw new SafeExternalServiceError(
      "The refreshed token fee rate was invalid.",
      {
        code: "CLOB_FEE_INDETERMINATE",
        service: "clob",
        retryable: false
      }
    );
  }
  const minOrderSizeMicros = parseApiDecimalToMicros(
    marketInfo.mos,
    "nearest"
  );
  if (
    minOrderSizeMicros <= 0n ||
    minOrderSizeMicros !== proposal.market.minOrderSizeMicros ||
    proposal.sharesMicros < minOrderSizeMicros
  ) {
    throw new SafeExternalServiceError(
      "The market minimum order size changed or exceeds the approved size.",
      {
        code: "CLOB_MIN_ORDER_SIZE_CHANGED",
        service: "clob",
        retryable: false
      }
    );
  }

  const feeDetails = marketInfo.fd;
  if (feeDetails === undefined || feeDetails === null) {
    if (
      proposal.market.feesEnabled ||
      proposal.market.feeRateBps !== 0 ||
      proposal.market.feeExponent !== 0 ||
      tokenFeeRateBps !== 0
    ) {
      throw new SafeExternalServiceError(
        "The refreshed CLOB market omitted required fee parameters.",
        {
          code: "CLOB_FEE_INDETERMINATE",
          service: "clob",
          retryable: false
        }
      );
    }
    return { tickSize, negRisk, version: 2 };
  }
  if (
    typeof feeDetails.r !== "number" ||
    !Number.isFinite(feeDetails.r) ||
    feeDetails.r < 0 ||
    typeof feeDetails.e !== "number" ||
    !Number.isSafeInteger(feeDetails.e) ||
    feeDetails.e < 0 ||
    feeDetails.e > 8 ||
    typeof feeDetails.to !== "boolean"
  ) {
    throw new SafeExternalServiceError(
      "The refreshed CLOB market omitted valid fee parameters.",
      {
        code: "CLOB_FEE_INDETERMINATE",
        service: "clob",
        retryable: false
      }
    );
  }
  const feeRateScaled = feeDetails.r * 10_000;
  if (!Number.isSafeInteger(feeRateScaled) || feeRateScaled < 0) {
    throw new SafeExternalServiceError(
      "The refreshed CLOB fee rate cannot be represented exactly.",
      {
        code: "CLOB_FEE_INDETERMINATE",
        service: "clob",
        retryable: false
      }
    );
  }
  const refreshedFeeRateBps = feeRateScaled;
  const refreshedFeeExponent = feeDetails.e;
  const refreshedTakerOnly = feeDetails.to;
  const effectiveFeeRateBps = tokenFeeRateBps > 0 ? tokenFeeRateBps : refreshedFeeRateBps;
  if (
    proposal.market.feeExponent === undefined ||
    proposal.market.feesTakerOnly === undefined ||
    effectiveFeeRateBps !== proposal.market.feeRateBps ||
    refreshedFeeExponent !== proposal.market.feeExponent ||
    refreshedTakerOnly !== proposal.market.feesTakerOnly
  ) {
    throw new SafeExternalServiceError(
      "The market fee parameters changed after approval.",
      {
        code: "CLOB_FEE_CHANGED",
        service: "clob",
        retryable: false
      }
    );
  }
  return { tickSize, negRisk, version: 2 };
}

function toTickSize(value: number): TickSize {
  const candidate = String(value) as TickSize;
  if (!ALLOWED_TICK_SIZES.has(candidate)) {
    throw new SafeExternalServiceError(
      "The refreshed CLOB market has an unsupported tick size.",
      {
        code: "CLOB_UNSUPPORTED_TICK",
        service: "clob",
        retryable: false
      }
    );
  }
  return candidate;
}

function microsToSdkNumber(value: bigint, label: string): number {
  const decimal = formatMicros(value);
  const numeric = Number(decimal);
  if (
    !Number.isFinite(numeric) ||
    parseApiDecimalToMicros(numeric) !== value
  ) {
    throw new SafeExternalServiceError(
      `The ${label} cannot be represented safely by the CLOB SDK.`,
      {
        code: "CLOB_NUMERIC_PRECISION_ERROR",
        service: "local",
        retryable: false
      }
    );
  }
  return numeric;
}

function normalizeCancelResult(value: unknown): CancelResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The CLOB cancellation response was malformed.");
  }
  const record = value as Record<string, unknown>;
  const canceled = Array.isArray(record.canceled)
    ? record.canceled.filter((item): item is string => typeof item === "string")
    : [];
  const rawNotCanceled =
    record.not_canceled ?? record.notCanceled ?? Object.create(null);
  const notCanceled: Record<string, string> = {};
  if (
    typeof rawNotCanceled === "object" &&
    rawNotCanceled !== null &&
    !Array.isArray(rawNotCanceled)
  ) {
    for (const [orderId, reason] of Object.entries(rawNotCanceled)) {
      if (typeof reason === "string") {
        notCanceled[orderId] = sanitizeErrorMessage(reason);
      }
    }
  }
  return { canceled, notCanceled };
}

async function validateAndHashSignedOrder(
  proposal: OrderProposal,
  order: SignedOrder,
  expectedExpiration: number,
  auth: LiveAuthentication,
  nowMs: number
): Promise<SubmittedOrderEvidence> {
  if (!isV2Order(order)) {
    throw new SafeExternalServiceError(
      "The SDK prepared a non-V2 order.",
      {
        code: "CLOB_SIGNED_ORDER_INVALID",
        service: "local",
        retryable: false
      }
    );
  }
  const signerAddress = (
    await resolveInjectedSignerAddress(auth.signer)
  ).toLowerCase();
  const expectedOrderSigner =
    auth.signatureType === SignatureTypeV2.POLY_1271
      ? auth.funderAddress.toLowerCase()
      : signerAddress;
  const makerAmount = parseUnsignedOrderField(
    order.makerAmount,
    "makerAmount"
  );
  const takerAmount = parseUnsignedOrderField(
    order.takerAmount,
    "takerAmount"
  );
  const timestamp = parseUnsignedOrderField(order.timestamp, "timestamp");
  const expiration = parseUnsignedOrderField(
    order.expiration,
    "expiration"
  );
  const salt = parseUnsignedOrderField(order.salt, "salt");
  const expectedMakerAmount =
    proposal.side === "BUY"
      ? proposal.maxCostMicros
      : proposal.sharesMicros;
  const expectedTakerAmount =
    proposal.side === "BUY"
      ? proposal.sharesMicros
      : proposal.maxCostMicros;
  const expectedMetadata = `0x${proposal.hash}`.toLowerCase();
  const expectedSide = proposal.side === "BUY" ? Side.BUY : Side.SELL;
  if (
    salt <= 0n ||
    !isHexAddress(order.maker) ||
    order.maker.toLowerCase() !== auth.funderAddress.toLowerCase() ||
    !isHexAddress(order.signer) ||
    order.signer.toLowerCase() !== expectedOrderSigner ||
    order.tokenId !== proposal.market.tokenId ||
    makerAmount !== expectedMakerAmount ||
    takerAmount !== expectedTakerAmount ||
    order.side !== expectedSide ||
    order.signatureType !== auth.signatureType ||
    !isBytes32(order.metadata) ||
    order.metadata.toLowerCase() !== expectedMetadata ||
    !isBytes32(order.builder) ||
    order.builder.toLowerCase() !== ZERO_BYTES32 ||
    expiration !== BigInt(expectedExpiration) ||
    timestamp < BigInt(nowMs - 300_000) ||
    timestamp > BigInt(nowMs + 60_000) ||
    typeof order.signature !== "string" ||
    !/^0x(?:[a-fA-F0-9]{2})+$/u.test(order.signature)
  ) {
    throw new SafeExternalServiceError(
      "The locally signed V2 order does not match the approved proposal.",
      {
        code: "CLOB_SIGNED_ORDER_MISMATCH",
        service: "local",
        retryable: false
      }
    );
  }

  const contracts = getContractConfig(Chain.POLYGON);
  const verifyingContract = (proposal.market.negRisk
    ? contracts.negRiskExchangeV2
    : contracts.exchangeV2) as Address;
  const orderHash = hashTypedData({
    domain: {
      name: "Polymarket CTF Exchange",
      version: "2",
      chainId: 137,
      verifyingContract
    },
    types: { Order: ORDER_EIP712_TYPES },
    primaryType: "Order",
    message: {
      salt,
      maker: order.maker as Address,
      signer: order.signer as Address,
      tokenId: BigInt(order.tokenId),
      makerAmount,
      takerAmount,
      side: proposal.side === "BUY" ? 0 : 1,
      signatureType: order.signatureType,
      timestamp,
      metadata: order.metadata as Hex,
      builder: order.builder as Hex
    }
  }).toLowerCase() as `0x${string}`;

  return {
    orderHash,
    metadata: order.metadata.toLowerCase() as `0x${string}`,
    builder: order.builder.toLowerCase() as `0x${string}`,
    expiration: expectedExpiration,
    timestampMs: Number(timestamp),
    makerAmountMicros: makerAmount,
    takerAmountMicros: takerAmount
  };
}

function parseUnsignedOrderField(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new SafeExternalServiceError(
      `The signed order ${label} is malformed.`,
      {
        code: "CLOB_SIGNED_ORDER_INVALID",
        service: "local",
        retryable: false
      }
    );
  }
  return BigInt(value);
}

function isHexAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/u.test(value);
}

function isBytes32(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/u.test(value);
}

async function resolveInjectedSignerAddress(
  signer: InjectedClobSigner
): Promise<string> {
  const candidate = signer as unknown as {
    getAddress?: () => Promise<string>;
    address?: unknown;
    account?: { address?: unknown };
  };
  const address =
    typeof candidate.getAddress === "function"
      ? await candidate.getAddress()
      : typeof candidate.address === "string"
        ? candidate.address
        : candidate.account?.address;
  if (typeof address !== "string" || !isHexAddress(address)) {
    throw new SafeExternalServiceError(
      "The injected signer address is unavailable.",
      {
        code: "CLOB_SIGNER_ADDRESS_INVALID",
        service: "local",
        retryable: false
      }
    );
  }
  return address;
}

function validateAuthentication(auth: LiveAuthentication): void {
  if (
    auth.signatureType !== SignatureTypeV2.POLY_PROXY &&
    auth.signatureType !== SignatureTypeV2.POLY_1271
  ) {
    throw new Error("Only POLY_PROXY and POLY_1271 social-wallet signatures are allowed.");
  }
  if (!/^0x[a-fA-F0-9]{40}$/u.test(auth.funderAddress)) {
    throw new Error("funderAddress must be a 20-byte hexadecimal address.");
  }
  if (
    auth.signer === undefined ||
    auth.creds.key.length === 0 ||
    auth.creds.secret.length === 0 ||
    auth.creds.passphrase.length === 0
  ) {
    throw new Error("Injected signer and CLOB credentials are required.");
  }
}

function normalizeHost(host: string): string {
  const url = new URL(host);
  if (
    url.protocol !== "https:" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "localhost"
  ) {
    throw new Error("The CLOB host must use HTTPS, except for loopback tests.");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

const defaultHeartbeatScheduler: HeartbeatScheduler = {
  schedule(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
};

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref();
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export { PolymarketLiveClient as LivePolymarketClient };
