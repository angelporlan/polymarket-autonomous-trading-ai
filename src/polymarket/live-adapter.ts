import {
  AssetType,
  Chain,
  ClobClient,
  SignatureTypeV2,
  getContractConfig,
  type ApiKeyCreds,
  type BalanceAllowanceResponse,
  type ClobClientOptions,
  type OpenOrder,
  type OrderResponse,
  type SignedOrder,
  type Trade
} from "@polymarket/clob-client-v2";
import type { LiveTradingPort, LiveOrderResult } from "../application/ports.js";
import { verifyProposalHash } from "../domain/proposals.js";
import type { OrderProposal } from "../domain/types.js";
import {
  L2_CREDENTIALS_ACCOUNT,
  SOCIAL_PRIVATE_KEY_ACCOUNT,
  type KeychainItemStatus,
  type KeychainPort,
  type KeychainReadContext
} from "../security/keychain.js";
import { RestrictedKeychainSigner } from "../security/restricted-signer.js";
import type {
  AccountBindingRecord,
  TradingDatabase
} from "../storage/database.js";
import {
  PolymarketLiveClient,
  type HeartbeatScheduler,
  type InjectedClobSigner,
  type LiveClobClient
} from "./live-client.js";
import { SafeExternalServiceError } from "./safe-error.js";
import {
  PolymarketUserChannelMonitor,
  type UserChannelEvent,
  type UserChannelMonitorOptions
} from "./user-channel-monitor.js";

interface RuntimeKeychainPort extends KeychainPort {
  status(
    account:
      | typeof SOCIAL_PRIVATE_KEY_ACCOUNT
      | typeof L2_CREDENTIALS_ACCOUNT
  ): Promise<KeychainItemStatus>;
  readL2Credentials(context: KeychainReadContext): Promise<Uint8Array>;
}

export interface GuardedLiveTradingOptions {
  database: TradingDatabase;
  keychain: RuntimeKeychainPort;
  profileAddress: string;
  clobHost?: string;
  now?: () => number;
  /** Test seam for the public /version probe; production uses direct fetch. */
  clobVersionReader?: () => Promise<number>;
  /**
   * Test seam for a fully controlled CLOB double. Production callers omit it.
   * It deliberately retains the narrow SDK type and cannot add new operations
   * to the live adapter.
   */
  clobClientFactory?: (options: ClobClientOptions) => ClobClient;
  heartbeatScheduler?: HeartbeatScheduler;
  /**
   * Returns true while at least one remote/local order still requires active
   * heartbeat supervision. False stops both loops after a final clean cycle.
   */
  safetyCheck?: () => Promise<boolean>;
  userChannelMonitorFactory?: (
    options: UserChannelMonitorOptions
  ) => PolymarketUserChannelMonitor;
}

interface AuthenticatedClient {
  raw: ClobClient;
  guarded: PolymarketLiveClient;
}

const BEST_EFFORT_CANCEL_TIMEOUT_MS = 10_000;
const SAFETY_CHECK_TIMEOUT_MS = 4_000;
const SAFETY_CHECK_INTERVAL_MS = 5_000;
const LIVE_PREFLIGHT_TIMEOUT_MS = 4_000;
const LIVE_SUBMISSION_TIMEOUT_MS = 8_000;
const USER_CHANNEL_START_TIMEOUT_MS = 12_000;
const CLOB_VERSION_TIMEOUT_MS = 4_000;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as const;
const VERIFIED_TERMINAL_EXECUTION_STATUSES = new Set([
  "CANCELLED",
  "CANCELED",
  "EXPIRED",
  "CONFIRMED",
  "REJECTED"
]);

/**
 * Runtime bridge for the narrow live client. It never derives credentials,
 * updates allowances, transfers funds, or exposes a general signing method.
 */
export class GuardedLiveTradingAdapter implements LiveTradingPort {
  private readonly now: () => number;
  private active: AuthenticatedClient | null = null;
  private submitting: AuthenticatedClient | null = null;
  private pendingHeartbeat: AuthenticatedClient | null = null;
  private heartbeatHandoff: Promise<void> | null = null;
  private submissionReserved = false;
  private abortSubmission = false;
  private safetyRunning = false;
  private safetyHandle: NodeJS.Timeout | null = null;
  private safetyPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private submittingUserMonitor: PolymarketUserChannelMonitor | null = null;
  private readonly userMonitors = new Map<
    string,
    PolymarketUserChannelMonitor
  >();

  constructor(private readonly options: GuardedLiveTradingOptions) {
    this.now = options.now ?? Date.now;
  }

  async configured(): Promise<boolean> {
    const binding = this.validBinding();
    if (binding === null) {
      return false;
    }
    const [social, l2] = await Promise.all([
      this.options.keychain.status(SOCIAL_PRIVATE_KEY_ACCOUNT),
      this.options.keychain.status(L2_CREDENTIALS_ACCOUNT)
    ]);
    return social.exists && l2.exists;
  }

  async submitGtd(
    proposal: OrderProposal,
    finalPreflight: () => Promise<void>
  ): Promise<LiveOrderResult> {
    if (
      this.shuttingDown ||
      this.submissionReserved ||
      this.submitting !== null ||
      this.pendingHeartbeat !== null
    ) {
      throw new SafeExternalServiceError(
        "Another live submission is still being finalized.",
        {
          code: "LIVE_SUBMISSION_IN_PROGRESS",
          service: "local",
          retryable: false
        }
      );
    }
    this.submissionReserved = true;
    try {
      return await this.submitReservedGtd(proposal, finalPreflight);
    } finally {
      this.submissionReserved = false;
    }
  }

  private async submitReservedGtd(
    proposal: OrderProposal,
    finalPreflight: () => Promise<void>
  ): Promise<LiveOrderResult> {
    if (this.options.database.getEmergencyStop().active) {
      throw new SafeExternalServiceError(
        "The emergency lock is active.",
        {
          code: "EMERGENCY_STOPPED",
          service: "local",
          retryable: false
        }
      );
    }
    if (this.shuttingDown) {
      throw new SafeExternalServiceError(
        "The local live adapter is shutting down.",
        {
          code: "LIVE_ADAPTER_SHUTTING_DOWN",
          service: "local",
          retryable: false
        }
      );
    }
    this.abortSubmission = false;
    const binding = this.requireBinding();
    const creds = await this.readCredentials({
      reason: "Authorize authenticated Polymarket order preflight",
      proposalId: proposal.id,
      proposalHash: proposal.hash
    });
    let client: AuthenticatedClient | null = null;
    const signer = this.createOrderSigner(
      proposal,
      binding,
      async () => {
        await finalPreflight();
        if (client === null) {
          throw new SafeExternalServiceError(
            "The final authenticated preflight client is unavailable.",
            {
              code: "FINAL_PREFLIGHT_UNAVAILABLE",
              service: "local",
              retryable: false
            }
          );
        }
        await assertBalanceAndAllowance(
          client.raw,
          proposal,
          this.options.database
        );
      }
    );
    client = this.createClient(creds, binding, signer);
    this.submitting = client;
    let boundOrderId: string | null = null;
    const pendingUserEvents: UserChannelEvent[] = [];
    const userMonitor = this.createUserChannelMonitor(async (event) => {
      if (boundOrderId === null) {
        if (pendingUserEvents.length >= 100) {
          throw new Error("USER_CHANNEL_PRE_SUBMISSION_BACKLOG");
        }
        pendingUserEvents.push(event);
        return;
      }
      this.recordUserChannelEvent(event, boundOrderId, proposal);
    });
    this.submittingUserMonitor = userMonitor;

    let response: OrderResponse;
    let localOrder:
      | Awaited<
          ReturnType<PolymarketLiveClient["executeStagedProposal"]>
        >["evidence"]
      | null = null;
    try {
      await withTimeout(
        finalPreflight(),
        LIVE_PREFLIGHT_TIMEOUT_MS,
        "Live final preflight timed out."
      );
      await withTimeout(
        assertBalanceAndAllowance(
          client.raw,
          proposal,
          this.options.database
        ),
        LIVE_PREFLIGHT_TIMEOUT_MS,
        "Authenticated balance preflight timed out."
      );
      await withTimeout(
        userMonitor.start(
          {
            apiKey: creds.key,
            secret: creds.secret,
            passphrase: creds.passphrase
          },
          [proposal.market.conditionId]
        ),
        USER_CHANNEL_START_TIMEOUT_MS,
        "Authenticated user-channel startup timed out."
      );
      const submission = await withTimeout(
        client.guarded.executeStagedProposal(proposal),
        LIVE_SUBMISSION_TIMEOUT_MS,
        "CLOB submission result timed out."
      );
      response = submission.response;
      localOrder = submission.evidence;
      boundOrderId = response.orderID;
      for (const event of pendingUserEvents) {
        this.recordUserChannelEvent(event, boundOrderId, proposal);
      }
      pendingUserEvents.length = 0;
      this.pendingHeartbeat = this.createReadOnlyClient(creds, binding);
      this.userMonitors.set(boundOrderId, userMonitor);
      this.submittingUserMonitor = null;
      this.submitting = null;
    } catch (error) {
      this.abortSubmission = true;
      userMonitor.stop();
      if (this.submittingUserMonitor === userMonitor) {
        this.submittingUserMonitor = null;
      }
      this.options.database.setEmergencyStop(
        true,
        error instanceof SafeExternalServiceError
          ? error.code
          : "LIVE_SUBMISSION_FAILED",
        this.now()
      );
      try {
        await withTimeout(
          client.guarded.cancelAll(),
          BEST_EFFORT_CANCEL_TIMEOUT_MS
        );
      } catch {
        // Submission may have reached the CLOB. The persistent lock was set
        // first and manual reconciliation remains mandatory.
      }
      if (this.submitting === client) {
        this.submitting = null;
      }
      throw error;
    }

    return {
      orderId: response.orderID,
      status: response.status,
      response: {
        success: response.success,
        orderID: response.orderID,
        status: response.status,
        takingAmount: response.takingAmount,
        makingAmount: response.makingAmount,
        transactionsHashes: response.transactionsHashes ?? [],
        tradeIDs: response.tradeIDs ?? [],
        localOrder
      }
    };
  }

  async cancelOrder(orderId: string): Promise<Record<string, unknown>> {
    const client = await this.getOrCreateAuthenticatedClient(
      "Authorize cancellation of a Polymarket order"
    );
    const result = await client.guarded.cancelOrder(orderId);
    return {
      canceled: result.canceled,
      notCanceled: result.notCanceled
    };
  }

  async cancelAll(): Promise<Record<string, unknown>> {
    this.abortSubmission = true;
    this.stopSafetySupervisor();
    this.stopHeartbeatClients();
    this.stopUserChannelMonitors();
    const client = await this.getOrCreateAuthenticatedClient(
      "Authorize cancellation of all Polymarket orders"
    );
    const result = await client.guarded.cancelAll();
    return {
      canceled: result.canceled,
      notCanceled: result.notCanceled
    };
  }

  async getOrderStatus(orderId: string): Promise<Record<string, unknown> | null> {
    const client = await this.getOrCreateAuthenticatedClient(
      "Authorize read-only Polymarket order status"
    );
    try {
      const order = await client.raw.getOrder(orderId);
      return sanitizeOpenOrder(order);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "status" in error &&
        (error as { status?: unknown }).status === 404
      ) {
        return null;
      }
      throw new SafeExternalServiceError(
        "The authenticated order status request failed.",
        {
          code: "CLOB_ORDER_STATUS_ERROR",
          service: "clob",
          retryable: false
        }
      );
    }
  }

  async getOpenOrders(): Promise<Array<Record<string, unknown>>> {
    const client = await this.getOrCreateAuthenticatedClient(
      "Authorize read-only reconciliation of Polymarket open orders"
    );
    try {
      const [orders, closedOnly] = await Promise.all([
        client.raw.getOpenOrders(undefined, false),
        client.raw.getClosedOnlyMode()
      ]);
      assertAccountOpenMode(closedOnly);
      return orders.map(sanitizeOpenOrder);
    } catch (error) {
      if (error instanceof SafeExternalServiceError) {
        throw error;
      }
      throw new SafeExternalServiceError(
        "The authenticated open-order reconciliation failed.",
        {
          code: "CLOB_OPEN_ORDERS_ERROR",
          service: "clob",
          retryable: false
        }
      );
    }
  }

  async getTrades(
    tradeIds: string[]
  ): Promise<Array<Record<string, unknown>>> {
    const uniqueIds = [...new Set(tradeIds)];
    if (
      uniqueIds.length > 100 ||
      uniqueIds.some((tradeId) => tradeId.trim().length === 0)
    ) {
      throw new SafeExternalServiceError(
        "The trade reconciliation request is invalid.",
        {
          code: "INVALID_TRADE_RECONCILIATION_REQUEST",
          service: "local",
          retryable: false
        }
      );
    }
    if (uniqueIds.length === 0) {
      return [];
    }
    const client = await this.getOrCreateAuthenticatedClient(
      "Authorize read-only reconciliation of Polymarket fills"
    );
    try {
      const pages = await Promise.all(
        uniqueIds.map((tradeId) =>
          client.raw.getTrades({ id: tradeId }, true)
        )
      );
      return pages.flat().map(sanitizeTrade);
    } catch {
      throw new SafeExternalServiceError(
        "The authenticated fill reconciliation failed.",
        {
          code: "CLOB_TRADE_RECONCILIATION_ERROR",
          service: "clob",
          retryable: false
        }
      );
    }
  }

  async startHeartbeat(): Promise<void> {
    if (this.heartbeatHandoff !== null) {
      return this.heartbeatHandoff;
    }
    const handoff = this.performHeartbeatHandoff();
    this.heartbeatHandoff = handoff;
    try {
      await handoff;
      await this.startSafetySupervisor();
    } finally {
      if (this.heartbeatHandoff === handoff) {
        this.heartbeatHandoff = null;
      }
    }
  }

  private async performHeartbeatHandoff(): Promise<void> {
    const next = this.pendingHeartbeat ?? this.active;
    if (next === null) {
      throw new SafeExternalServiceError(
        "No authenticated client is available for heartbeat.",
        {
          code: "HEARTBEAT_CLIENT_UNAVAILABLE",
          service: "local",
          retryable: false
        }
      );
    }
    await next.guarded.startHeartbeat();
    if (
      this.abortSubmission ||
      this.options.database.getEmergencyStop().active
    ) {
      next.guarded.stopHeartbeat();
      throw new SafeExternalServiceError(
        "The heartbeat handoff was interrupted by the emergency lock.",
        {
          code: "HEARTBEAT_HANDOFF_ABORTED",
          service: "local",
          retryable: false
        }
      );
    }
    if (this.pendingHeartbeat === next) {
      const previous = this.active;
      this.active = next;
      this.pendingHeartbeat = null;
      if (previous !== null && previous !== next) {
        previous.guarded.stopHeartbeat();
      }
    }
  }

  async stopHeartbeat(): Promise<void> {
    this.stopSafetySupervisor();
    this.stopHeartbeatClients();
    this.stopUserChannelMonitors();
  }

  private stopHeartbeatClients(): void {
    this.active?.guarded.stopHeartbeat();
    if (this.pendingHeartbeat !== this.active) {
      this.pendingHeartbeat?.guarded.stopHeartbeat();
    }
    if (
      this.submitting !== this.active &&
      this.submitting !== this.pendingHeartbeat
    ) {
      this.submitting?.guarded.stopHeartbeat();
    }
  }

  /**
   * Synchronously prevents any later signing/submission. If local state says a
   * live execution may still be open, the persistent lock is written before
   * the caller performs its first await.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
    this.abortSubmission = true;
    this.stopSafetySupervisor();
    this.stopHeartbeatClients();
    this.stopUserChannelMonitors();
    const liveWorkInFlight =
      this.submissionReserved ||
      this.submitting !== null ||
      this.pendingHeartbeat !== null ||
      this.options.database
        .listExecutions()
        .some(
          (execution) =>
            execution.status.toUpperCase() === "CLAIMED" ||
            (execution.clobOrderId !== null &&
              !VERIFIED_TERMINAL_EXECUTION_STATUSES.has(
                execution.status.toUpperCase()
              ))
        );
    if (liveWorkInFlight) {
      this.options.database.setEmergencyStop(
        true,
        "LIVE_ADAPTER_SHUTDOWN_WITH_OPEN_EXECUTION",
        this.now()
      );
      this.options.database.setLiveActivation(false, this.now());
    }
  }

  close(): void {
    this.beginShutdown();
    this.active = null;
    this.submitting = null;
    this.pendingHeartbeat = null;
  }

  private async startSafetySupervisor(): Promise<void> {
    if (this.options.safetyCheck === undefined || this.safetyRunning) {
      return;
    }
    this.safetyRunning = true;
    await this.runSafetyCycle(true);
  }

  private stopSafetySupervisor(): void {
    this.safetyRunning = false;
    if (this.safetyHandle !== null) {
      clearTimeout(this.safetyHandle);
      this.safetyHandle = null;
    }
  }

  private async runSafetyCycle(propagateError: boolean): Promise<void> {
    if (!this.safetyRunning || this.options.safetyCheck === undefined) {
      return;
    }
    if (this.safetyPromise !== null) {
      return this.safetyPromise;
    }
    const operation = (async () => {
      try {
        const keepRunning = await withTimeout(
          this.options.safetyCheck!(),
          SAFETY_CHECK_TIMEOUT_MS
        );
        if (!keepRunning) {
          this.stopSafetySupervisor();
          this.stopHeartbeatClients();
          this.stopUserChannelMonitors();
          return;
        }
        this.pruneTerminalUserChannelMonitors();
      } catch (error) {
        await this.handleSafetyFailure(error);
        if (propagateError) {
          throw error;
        }
        return;
      }
      if (this.safetyRunning) {
        this.safetyHandle = setTimeout(() => {
          this.safetyHandle = null;
          void this.runSafetyCycle(false);
        }, SAFETY_CHECK_INTERVAL_MS);
        this.safetyHandle.unref();
      }
    })();
    this.safetyPromise = operation;
    try {
      await operation;
    } finally {
      if (this.safetyPromise === operation) {
        this.safetyPromise = null;
      }
    }
  }

  private async handleSafetyFailure(error: unknown): Promise<void> {
    this.abortSubmission = true;
    this.stopSafetySupervisor();
    this.options.database.setEmergencyStop(
      true,
      safeSupervisorCode(error),
      this.now()
    );
    this.stopHeartbeatClients();
    this.stopUserChannelMonitors();
    const client =
      this.submitting ?? this.pendingHeartbeat ?? this.active;
    if (client === null) {
      return;
    }
    try {
      await withTimeout(
        client.guarded.cancelAll(),
        BEST_EFFORT_CANCEL_TIMEOUT_MS
      );
    } catch {
      // The persistent lock is the source of truth when remote cancellation
      // cannot be confirmed within the bounded shutdown window.
    }
  }

  private async getOrCreateAuthenticatedClient(
    reason: string
  ): Promise<AuthenticatedClient> {
    const existing =
      this.submitting ?? this.pendingHeartbeat ?? this.active;
    if (existing !== null) {
      return existing;
    }
    const binding = this.requireBinding();
    const creds = await this.readCredentials({ reason });
    const addressOnlySigner: InjectedClobSigner = {
      async getAddress() {
        return binding.signerAddress;
      },
      async _signTypedData() {
        throw new SafeExternalServiceError(
          "This client is not permitted to sign orders.",
          {
            code: "SIGNING_NOT_PERMITTED",
            service: "local",
            retryable: false
          }
        );
      }
    };
    this.active = this.createClient(creds, binding, addressOnlySigner);
    return this.active;
  }

  private createUserChannelMonitor(
    onEvent: (event: UserChannelEvent) => void | Promise<void>
  ): PolymarketUserChannelMonitor {
    const options: UserChannelMonitorOptions = {
      onEvent,
      onFailure: async (error) => {
        await this.handleSafetyFailure(error);
      }
    };
    return (
      this.options.userChannelMonitorFactory?.(options) ??
      new PolymarketUserChannelMonitor(options)
    );
  }

  private recordUserChannelEvent(
    event: UserChannelEvent,
    preferredOrderId: string,
    preferredProposal: OrderProposal
  ): void {
    const candidateOrderIds =
      event.kind === "order"
        ? [event.orderId]
        : [
            event.takerOrderId,
            ...event.makerOrders.map((order) => order.orderId)
          ];
    const preferredMatches = candidateOrderIds.filter(
      (orderId) => orderId.toLowerCase() === preferredOrderId.toLowerCase()
    ).length;

    let orderId: string;
    let proposal: OrderProposal;
    if (preferredMatches === 1) {
      orderId = preferredOrderId;
      proposal = preferredProposal;
    } else {
      const localMatches = candidateOrderIds
        .map((candidateOrderId) => ({
          candidateOrderId,
          execution:
            this.options.database.getExecutionByOrderId(candidateOrderId)
        }))
        .filter(
          (
            value
          ): value is typeof value & {
            execution: NonNullable<typeof value.execution>;
          } => value.execution !== null
        );
      const uniqueOrderIds = new Set(
        localMatches.map((value) => value.candidateOrderId.toLowerCase())
      );
      if (localMatches.length !== 1 || uniqueOrderIds.size !== 1) {
        throw new Error("USER_CHANNEL_EVENT_NOT_ATTRIBUTABLE");
      }
      const match = localMatches[0]!;
      const storedProposal = this.options.database.getProposal(
        match.execution.proposalId
      );
      if (storedProposal === null) {
        throw new Error("USER_CHANNEL_PROPOSAL_MISSING");
      }
      orderId = match.candidateOrderId;
      proposal = storedProposal;
    }

    const role = assertUserChannelEventMatchesProposal(
      event,
      orderId,
      proposal
    );
    this.options.database.appendAudit(
      event.kind === "order"
        ? "USER_CHANNEL_ORDER"
        : "USER_CHANNEL_TRADE",
      orderId,
      {
        proposalId: proposal.id,
        proposalHash: proposal.hash,
        role,
        event
      }
    );
  }

  private pruneTerminalUserChannelMonitors(): void {
    for (const [orderId, monitor] of this.userMonitors) {
      const execution = this.options.database.getExecutionByOrderId(orderId);
      if (
        execution !== null &&
        VERIFIED_TERMINAL_EXECUTION_STATUSES.has(
          execution.status.toUpperCase()
        )
      ) {
        monitor.stop();
        this.userMonitors.delete(orderId);
      }
    }
  }

  private stopUserChannelMonitors(): void {
    this.submittingUserMonitor?.stop();
    this.submittingUserMonitor = null;
    for (const monitor of this.userMonitors.values()) {
      monitor.stop();
    }
    this.userMonitors.clear();
  }

  private createClient(
    creds: ApiKeyCreds,
    binding: AccountBindingRecord,
    signer: InjectedClobSigner
  ): AuthenticatedClient {
    const signatureType =
      binding.signatureType === 1
        ? SignatureTypeV2.POLY_PROXY
        : SignatureTypeV2.POLY_1271;
    const clientOptions: ClobClientOptions = {
      host: this.options.clobHost ?? "https://clob.polymarket.com",
      chain: Chain.POLYGON,
      signer,
      creds,
      signatureType,
      funderAddress: binding.funderAddress,
      useServerTime: true,
      retryOnError: false,
      throwOnError: true
    };
    const raw =
      this.options.clobClientFactory?.(clientOptions) ??
      new ClobClient(clientOptions);
    const guardedClient: LiveClobClient = {
      getClobMarketInfo: (conditionId) => raw.getClobMarketInfo(conditionId),
      getFeeRateBps: (tokenId) => raw.getFeeRateBps(tokenId),
      getVersion: () =>
        this.options.clobVersionReader?.() ??
        readClobVersion(this.options.clobHost ?? "https://clob.polymarket.com"),
      createOrder: (
        userOrder,
        orderOptions
      ) => raw.createOrder(userOrder, orderOptions),
      postOrder: async (
        signedOrder: SignedOrder,
        orderType,
        postOnly,
        deferExec
      ) => {
        if (
          this.abortSubmission ||
          this.options.database.getEmergencyStop().active
        ) {
          throw new SafeExternalServiceError(
            "Live submission was interrupted by the emergency lock.",
            {
              code: "SUBMISSION_ABORTED",
              service: "local",
              retryable: false
            }
          );
        }
        const response = await raw.postOrder(
          signedOrder,
          orderType,
          postOnly,
          deferExec
        );
        if (
          this.abortSubmission ||
          this.options.database.getEmergencyStop().active
        ) {
          try {
            await raw.cancelOrder({ orderID: response.orderID });
          } catch {
            // The persistent lock and the outer cancel-all path remain active.
          }
          throw new SafeExternalServiceError(
            "The order response arrived after the emergency lock activated.",
            {
              code: "SUBMISSION_ABORTED_AFTER_POST",
              service: "local",
              retryable: false
            }
          );
        }
        return response;
      },
      cancelOrder: (payload) => raw.cancelOrder(payload),
      cancelAll: () => raw.cancelAll(),
      postHeartbeat: (heartbeatId) => raw.postHeartbeat(heartbeatId)
    };
    const guarded = new PolymarketLiveClient({
      auth: {
        signer,
        creds,
        signatureType,
        funderAddress: binding.funderAddress
      },
      ...(this.options.clobHost === undefined
        ? {}
        : { host: this.options.clobHost }),
      client: guardedClient,
      now: this.now,
      ...(typeof (
        signer as InjectedClobSigner & {
          getLastOrderHash?: () => string | null;
        }
      ).getLastOrderHash === "function"
        ? {
            signedOrderHashEvidence: () =>
              (
                signer as InjectedClobSigner & {
                  getLastOrderHash: () => string | null;
                }
              ).getLastOrderHash()
          }
        : {}),
      ...(this.options.heartbeatScheduler === undefined
        ? {}
        : { scheduler: this.options.heartbeatScheduler }),
      onHeartbeatFailure: async (error) => {
        this.options.database.setEmergencyStop(
          true,
          error.code,
          this.now()
        );
      }
    });
    return { raw, guarded };
  }

  private createReadOnlyClient(
    creds: ApiKeyCreds,
    binding: AccountBindingRecord
  ): AuthenticatedClient {
    const addressOnlySigner: InjectedClobSigner = {
      async getAddress() {
        return binding.signerAddress;
      },
      async _signTypedData() {
        throw new SafeExternalServiceError(
          "This authenticated monitor cannot sign orders.",
          {
            code: "SIGNING_NOT_PERMITTED",
            service: "local",
            retryable: false
          }
        );
      }
    };
    return this.createClient(creds, binding, addressOnlySigner);
  }

  private createOrderSigner(
    proposal: OrderProposal,
    binding: AccountBindingRecord,
    beforeSign: () => Promise<void>
  ): InjectedClobSigner {
    const contracts = getContractConfig(Chain.POLYGON);
    const makerAmount =
      proposal.side === "BUY"
        ? proposal.maxCostMicros
        : proposal.sharesMicros;
    const takerAmount =
      proposal.side === "BUY"
        ? proposal.sharesMicros
        : proposal.maxCostMicros;
    return new RestrictedKeychainSigner({
      keychain: this.options.keychain,
      permit: {
        purpose: "order",
        proposalId: proposal.id,
        proposalHash: proposal.hash,
        expectedAddress: binding.signerAddress as `0x${string}`,
        expiresAtMs: proposal.expiresAtMs,
        maker: binding.funderAddress as `0x${string}`,
        orderSigner: (binding.signatureType === 3
          ? binding.funderAddress
          : binding.signerAddress) as `0x${string}`,
        tokenId: BigInt(proposal.market.tokenId),
        side: proposal.side === "BUY" ? 0 : 1,
        signatureType: binding.signatureType,
        maxMakerAmount: makerAmount,
        maxTakerAmount: takerAmount,
        allowedVerifyingContracts: [
          (proposal.market.negRisk
            ? contracts.negRiskExchangeV2
            : contracts.exchangeV2) as `0x${string}`
        ],
        allowedDomainVersions: ["2"],
        metadata: `0x${proposal.hash}`,
        builder: ZERO_BYTES32
      },
      now: this.now,
      beforeSign
    }) as InjectedClobSigner;
  }

  private async readCredentials(
    context: KeychainReadContext
  ): Promise<ApiKeyCreds> {
    const secret = await this.options.keychain.readL2Credentials(context);
    try {
      if (secret.byteLength > 16_384) {
        throw new Error("L2 credential record is too large.");
      }
      const parsed = JSON.parse(Buffer.from(secret).toString("utf8")) as unknown;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(",") !==
          "key,passphrase,secret" ||
        !isCredentialField((parsed as Record<string, unknown>).key) ||
        !isCredentialField((parsed as Record<string, unknown>).secret) ||
        !isCredentialField((parsed as Record<string, unknown>).passphrase)
      ) {
        throw new Error("L2 credential record is malformed.");
      }
      const record = parsed as Record<"key" | "secret" | "passphrase", string>;
      return {
        key: record.key,
        secret: record.secret,
        passphrase: record.passphrase
      };
    } finally {
      secret.fill(0);
    }
  }

  private validBinding(): AccountBindingRecord | null {
    const binding = this.options.database.getAccountBinding();
    if (
      binding === null ||
      binding.profileAddress !== this.options.profileAddress.toLowerCase() ||
      binding.funderAddress !== this.options.profileAddress.toLowerCase() ||
      (binding.signatureType !== 1 && binding.signatureType !== 3)
    ) {
      return null;
    }
    return binding;
  }

  private requireBinding(): AccountBindingRecord {
    const binding = this.validBinding();
    if (binding === null) {
      throw new SafeExternalServiceError(
        "The verified signer, funder, and profile binding is missing.",
        {
          code: "ACCOUNT_BINDING_MISSING",
          service: "local",
          retryable: false
        }
      );
    }
    return binding;
  }
}

/**
 * Probe the public CLOB /version endpoint with an injectable fetch function.
 * The injected seam is only for deterministic tests; production callers use
 * the platform fetch implementation and still fail closed on any ambiguity.
 */
export async function readClobVersion(
  host: string,
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOB_VERSION_TIMEOUT_MS);
  timeout.unref();
  try {
    const response = await fetchFn(`${host.replace(/\/+$/u, "")}/version`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new SafeExternalServiceError(
        "The CLOB version endpoint did not return a successful response.",
        {
          code: "CLOB_VERSION_HTTP_ERROR",
          service: "clob",
          status: response.status,
          retryable: false
        }
      );
    }
    const payload = (await response.json()) as unknown;
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof (payload as { version?: unknown }).version !== "number" ||
      !Number.isSafeInteger((payload as { version: number }).version) ||
      (payload as { version: number }).version < 1
    ) {
      throw new SafeExternalServiceError(
        "The CLOB version response was indeterminate.",
        {
          code: "CLOB_VERSION_INDETERMINATE",
          service: "clob",
          retryable: false
        }
      );
    }
    return (payload as { version: number }).version;
  } catch (error) {
    if (error instanceof SafeExternalServiceError) {
      throw error;
    }
    throw new SafeExternalServiceError(
      "The CLOB version probe failed safely.",
      {
        code: "CLOB_VERSION_ERROR",
        service: "clob",
        retryable: false
      }
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function assertBalanceAndAllowance(
  client: ClobClient,
  proposal: OrderProposal,
  database: TradingDatabase
): Promise<void> {
  const collateral = proposal.side === "BUY";
  const [response, openOrders, closedOnly] = await Promise.all([
    client.getBalanceAllowance({
      asset_type: collateral ? AssetType.COLLATERAL : AssetType.CONDITIONAL,
      ...(collateral ? {} : { token_id: proposal.market.tokenId })
    }),
    client.getOpenOrders(undefined, false),
    client.getClosedOnlyMode()
  ]);
  assertAccountOpenMode(closedOnly);
  const knownOrderIds = new Set(
    database
      .listExecutions()
      .map((execution) => execution.clobOrderId)
      .filter((orderId): orderId is string => orderId !== null)
  );
  const untrackedOrderIds = openOrders
    .map((order) => order.id)
    .filter((orderId) => !knownOrderIds.has(orderId));
  if (untrackedOrderIds.length > 0) {
    throw new SafeExternalServiceError(
      "The account has open orders outside the local ledger.",
      {
        code: "UNTRACKED_OPEN_ORDERS",
        service: "clob",
        retryable: false
      }
    );
  }
  const requiredBalance = collateral
    ? proposal.maxLossMicros
    : proposal.sharesMicros;
  const requiredAllowance = collateral
    ? proposal.maxLossMicros
    : proposal.sharesMicros;
  const balance = parseBaseUnits(response.balance, "balance");
  if (balance < requiredBalance) {
    throw new SafeExternalServiceError(
      "The account balance is below the approved order requirement.",
      {
        code: "INSUFFICIENT_BALANCE",
        service: "clob",
        retryable: false
      }
    );
  }

  const contracts = getContractConfig(Chain.POLYGON);
  const exchange = (proposal.market.negRisk
    ? contracts.negRiskExchangeV2
    : contracts.exchangeV2).toLowerCase();
  const allowance = readAllowance(response, exchange);
  if (allowance < requiredAllowance) {
    throw new SafeExternalServiceError(
      "The existing allowance is below the approved order requirement.",
      {
        code: "INSUFFICIENT_ALLOWANCE",
        service: "clob",
        retryable: false
      }
    );
  }
}

function assertAccountOpenMode(value: unknown): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).closed_only !== "boolean" ||
    (value as { closed_only: boolean }).closed_only
  ) {
    throw new SafeExternalServiceError(
      "The account is closed-only or its trading mode is indeterminate.",
      {
        code: "ACCOUNT_CLOSED_ONLY_OR_INDETERMINATE",
        service: "clob",
        retryable: false
      }
    );
  }
}

function readAllowance(
  response: BalanceAllowanceResponse,
  expectedAddress: string
): bigint {
  for (const [address, value] of Object.entries(response.allowances)) {
    if (address.toLowerCase() === expectedAddress) {
      return parseBaseUnits(value, "allowance");
    }
  }
  return 0n;
}

function parseBaseUnits(value: string, label: string): bigint {
  if (!/^\d+$/u.test(value)) {
    throw new SafeExternalServiceError(
      `The authenticated ${label} response was malformed.`,
      {
        code: "INVALID_BALANCE_ALLOWANCE",
        service: "clob",
        retryable: false
      }
    );
  }
  return BigInt(value);
}

function sanitizeOpenOrder(order: OpenOrder): Record<string, unknown> {
  return {
    id: order.id,
    status: order.status,
    makerAddress: order.maker_address,
    market: order.market,
    assetId: order.asset_id,
    side: order.side,
    originalSize: order.original_size,
    sizeMatched: order.size_matched,
    price: order.price,
    outcome: order.outcome,
    createdAt: order.created_at,
    expiration: order.expiration,
    orderType: order.order_type,
    associateTrades: order.associate_trades
  };
}

function sanitizeTrade(trade: Trade): Record<string, unknown> {
  return {
    id: trade.id,
    takerOrderId: trade.taker_order_id,
    traderSide: trade.trader_side,
    makerAddress: trade.maker_address,
    feeRateBps: trade.fee_rate_bps,
    makerOrders: trade.maker_orders.map((order) => ({
      orderId: order.order_id,
      makerAddress: order.maker_address,
      matchedAmount: order.matched_amount,
      price: order.price,
      feeRateBps: order.fee_rate_bps,
      assetId: order.asset_id,
      outcome: order.outcome,
      side: order.side ?? null
    })),
    market: trade.market,
    assetId: trade.asset_id,
    side: trade.side,
    size: trade.size,
    price: trade.price,
    status: trade.status,
    transactionHash: trade.transaction_hash || null,
    matchTime: trade.match_time,
    lastUpdate: trade.last_update
  };
}

function assertUserChannelEventMatchesProposal(
  event: UserChannelEvent,
  orderId: string,
  proposal: OrderProposal
): "ORDER" | "TAKER" | "MAKER" {
  if (
    proposal.executionMode !== "live" ||
    !verifyProposalHash(proposal) ||
    event.conditionId !== proposal.market.conditionId.toLowerCase()
  ) {
    throw new Error("USER_CHANNEL_PROPOSAL_MISMATCH");
  }
  const earliestEventMs = proposal.createdAtMs - 300_000;
  if (event.kind === "order") {
    if (
      event.orderId.toLowerCase() !== orderId.toLowerCase() ||
      event.tokenId !== proposal.market.tokenId ||
      event.side !== proposal.side ||
      event.originalSizeMicros !== proposal.sharesMicros ||
      event.sizeMatchedMicros > proposal.sharesMicros ||
      event.priceMicros !== proposal.limitPriceMicros ||
      event.orderType !== "GTD" ||
      event.timestampMs < earliestEventMs
    ) {
      throw new Error("USER_CHANNEL_ORDER_MISMATCH");
    }
    return "ORDER";
  }

  if (event.status === "FAILED" || event.lastUpdateMs < earliestEventMs) {
    throw new Error("USER_CHANNEL_TRADE_FAILED_OR_STALE");
  }
  const isTaker =
    event.takerOrderId.toLowerCase() === orderId.toLowerCase();
  const makerMatches = event.makerOrders.filter(
    (order) => order.orderId.toLowerCase() === orderId.toLowerCase()
  );
  if (Number(isTaker) + makerMatches.length !== 1) {
    throw new Error("USER_CHANNEL_TRADE_ATTRIBUTION_INVALID");
  }
  if (
    (event.traderSide === "TAKER" && !isTaker) ||
    (event.traderSide === "MAKER" && makerMatches.length !== 1)
  ) {
    throw new Error("USER_CHANNEL_TRADE_ROLE_MISMATCH");
  }
  if (isTaker) {
    if (
      event.tokenId !== proposal.market.tokenId ||
      event.side !== proposal.side ||
      event.sizeMicros <= 0n ||
      event.sizeMicros > proposal.sharesMicros ||
      event.feeRateBps !== proposal.market.feeRateBps ||
      !fillPriceWithinLimit(proposal, event.priceMicros)
    ) {
      throw new Error("USER_CHANNEL_TAKER_TRADE_MISMATCH");
    }
    return "TAKER";
  }
  const maker = makerMatches[0]!;
  if (
    maker.tokenId !== proposal.market.tokenId ||
    maker.matchedSizeMicros <= 0n ||
    maker.matchedSizeMicros > proposal.sharesMicros ||
    !fillPriceWithinLimit(proposal, maker.priceMicros)
  ) {
    throw new Error("USER_CHANNEL_MAKER_TRADE_MISMATCH");
  }
  return "MAKER";
}

function fillPriceWithinLimit(
  proposal: OrderProposal,
  priceMicros: bigint
): boolean {
  return proposal.side === "BUY"
    ? priceMicros <= proposal.limitPriceMicros
    : priceMicros >= proposal.limitPriceMicros;
}

function isCredentialField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096;
}

function safeSupervisorCode(error: unknown): string {
  if (
    error instanceof Error &&
    /^[A-Z][A-Z0-9_]{2,100}$/u.test(error.message)
  ) {
    return error.message;
  }
  if (error instanceof SafeExternalServiceError) {
    return error.code;
  }
  return "LIVE_SAFETY_SUPERVISOR_FAILED";
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message = "CLOB operation timed out."
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(message)),
          timeoutMs
        );
        timeout.unref();
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
