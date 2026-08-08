import { existsSync } from "node:fs";
import path from "node:path";
import type {
  AccountBindingPort,
  PaperGatePort
} from "./application/ports.js";
import { DatabaseRiskContext } from "./application/risk-context.js";
import { TradingService } from "./application/trading-service.js";
import { DashboardHttpServer } from "./approval/server.js";
import { loadConfig, type AppConfig } from "./config.js";
import { ProposalRejectedError } from "./domain/proposals.js";
import { DEFAULT_RISK_POLICY, RISK_POLICY_VERSION } from "./domain/risk-policy.js";
import {
  formatMicros,
  parseDecimalToMicros,
  type CandidateMarket,
  type MarketSnapshot,
  type OrderProposal,
  type PaperTrade,
  type PortfolioSnapshot,
  type ResearchBundle,
  type LegacyImportReport
} from "./domain/types.js";
import type { TradingSession } from "./domain/session.js";
import {
  PublicMcpToolError,
  type McpToolDependencies
} from "./mcp/server.js";
import {
  PaperReconciler,
  ReconciledPaperGate
} from "./paper/reconciler.js";
import type {
  CancelOrderInput,
  CancelOrderOutput,
  EmergencyStopInput,
  EmergencyStopOutput,
  EndTradingSessionInput,
  EndTradingSessionOutput,
  ExecuteStagedOrderInput,
  ExecuteStagedOrderOutput,
  GetAccountStatusOutput,
  GetMarketSnapshotInput,
  GetMarketSnapshotOutput,
  GetOrderStatusInput,
  GetOrderStatusOutput,
  GetPortfolioOutput,
  GetRiskStatusOutput,
  GetTradingSessionInput,
  GetTradingSessionOutput,
  ScanCandidatesInput,
  ScanCandidatesOutput,
  StageOrderInput,
  StageOrderOutput,
  ActivateTradingSessionInput,
  ActivateTradingSessionOutput,
  PrepareTradingSessionInput,
  PrepareTradingSessionOutput,
  PrepareResearchBundleInput,
  PrepareResearchBundleOutput,
  SupervisePositionsInput,
  SupervisePositionsOutput,
  ImportLegacyPositionInput,
  ImportLegacyPositionOutput
} from "./mcp/schemas.js";
import { GuardedLiveTradingAdapter } from "./polymarket/live-adapter.js";
import { PolygonReceiptVerifier } from "./polymarket/onchain-verifier.js";
import { PolymarketPublicClient } from "./polymarket/public-client.js";
import { parseClobFixed6 } from "./polymarket/reconciliation.js";
import { SafeExternalServiceError } from "./polymarket/safe-error.js";
import {
  KEYCHAIN_SERVICE,
  L2_CREDENTIALS_ACCOUNT,
  MacOSKeychain,
  SOCIAL_PRIVATE_KEY_ACCOUNT,
  KeychainHelperError
} from "./security/keychain.js";
import { parseWithBigInts } from "./storage/codec.js";
import { TradingDatabase } from "./storage/database.js";
import { ResearchVerifier } from "./research/verifier.js";
import type {
  SupervisorCycleResult,
  SupervisorHeartbeat
} from "./supervisor/types.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TERMINAL_PROPOSAL_STATUSES = new Set([
  "CANCELLED",
  "EXPIRED",
  "REJECTED",
  "SIMULATED"
]);
const TERMINAL_REMOTE_STATUSES = new Set([
  "CANCELLED",
  "CANCELED",
  "EXPIRED",
  "CONFIRMED",
  "REJECTED"
]);

class RuntimeAccountBinding implements AccountBindingPort {
  constructor(
    private readonly database: TradingDatabase,
    private readonly keychain: MacOSKeychain | null,
    private readonly helperAvailable: boolean
  ) {}

  async signerConfigured(): Promise<boolean> {
    if (this.keychain === null || !this.helperAvailable) {
      return false;
    }
    try {
      return (
        this.database.getAccountBinding() !== null &&
        (await this.keychain.status(SOCIAL_PRIVATE_KEY_ACCOUNT)).exists
      );
    } catch {
      return false;
    }
  }

  async signerAddress(): Promise<string | null> {
    return this.database.getAccountBinding()?.signerAddress ?? null;
  }

  async signatureType(): Promise<1 | 3 | null> {
    return this.database.getAccountBinding()?.signatureType ?? null;
  }

  async funderAddress(): Promise<string | null> {
    return this.database.getAccountBinding()?.funderAddress ?? null;
  }
}

export class PolymarketRuntime {
  private readonly config: AppConfig;
  private readonly database: TradingDatabase;
  private readonly publicClient: PolymarketPublicClient;
  private readonly keychain: MacOSKeychain | null;
  private readonly keychainHelperAvailable: boolean;
  private readonly paperGate: PaperGatePort;
  private readonly liveTrading: GuardedLiveTradingAdapter | null;
  private readonly dashboardServer: DashboardHttpServer;
  private readonly service: TradingService;
  private readonly researchVerifier: ResearchVerifier;
  private closed = false;

  constructor() {
    this.config = loadConfig();
    this.database = new TradingDatabase(this.config.databasePath);
    this.researchVerifier = new ResearchVerifier();
    this.publicClient = new PolymarketPublicClient({
      gammaHost: this.config.gammaHost,
      dataHost: this.config.dataHost,
      clobHost: this.config.clobHost
    });
    const helperPath = path.resolve("bin/polymarket-keychain-helper");
    this.keychainHelperAvailable =
      process.platform === "darwin" && existsSync(helperPath);
    this.keychain =
      process.platform === "darwin"
        ? new MacOSKeychain({ helperPath })
        : null;
    this.paperGate = new ReconciledPaperGate(
      this.database,
      new PaperReconciler(this.database, this.publicClient)
    );
    const accountBinding = new RuntimeAccountBinding(
      this.database,
      this.keychain,
      this.keychainHelperAvailable
    );
    let service: TradingService;
    this.liveTrading =
      this.keychain === null
        ? null
        : new GuardedLiveTradingAdapter({
            database: this.database,
            keychain: this.keychain,
            profileAddress: this.config.profileAddress,
            clobHost: this.config.clobHost,
            safetyCheck: () => service.monitorLiveSafety()
          });

    this.lockAfterUnsafeRestart();
    this.dashboardServer = new DashboardHttpServer({
      host: this.config.approvalHost,
      port: this.config.approvalPort,
      database: this.database
    });
    const riskContexts = new DatabaseRiskContext({
      database: this.database,
      marketData: this.publicClient,
      profileAddress: this.config.profileAddress,
      timeZone: "Europe/Madrid"
    });
    service = new TradingService({
      profileAddress: this.config.profileAddress,
      liveEnvironmentEnabled: this.config.liveEnabled,
      database: this.database,
      marketData: this.publicClient,
      accountBinding,
      riskContexts,
      paperGate: this.paperGate,
      paperGateSkip: this.config.paperGateSkip,
      liveTrading: this.liveTrading,
      onchainSettlement: new PolygonReceiptVerifier({
        rpcUrls: this.config.polygonRpcUrls
      }),
    });
    this.service = service;
  }

  async startDashboard(): Promise<void> {
    if (this.closed) {
      throw new Error("RUNTIME_CLOSED");
    }
    await this.dashboardServer.start();
  }

  async getAccountStatus(): Promise<GetAccountStatusOutput> {
    const paperGate = await this.paperGateOutput();
    if (this.config.profileAddress === ZERO_ADDRESS) {
      return {
        status: "UNCONFIGURED",
        profileAddress: null,
        signerAddress: null,
        funderAddress: null,
        walletType: null,
        keychainReady: false,
        l2CredentialsReady: false,
        liveEnabled: false,
        emergencyStopped: this.database.getEmergencyStop().active,
        paperGate,
        capturedAt: new Date().toISOString()
      };
    }

    const account = await this.service.getAccountStatus();
    const keychainState = await this.keychainState();
    const status: GetAccountStatusOutput["status"] = account.emergencyStopped
      ? "EMERGENCY_STOPPED"
      : account.mode === "live_ready"
        ? "LIVE_READY"
        : account.mode === "live_locked"
          ? "LIVE_LOCKED"
        : account.profileExists
          ? "PAPER"
          : "READ_ONLY";
    return {
      status,
      profileAddress: account.configuredProfileAddress,
      signerAddress: account.signerAddress,
      funderAddress: account.funderAddress,
      walletType:
        account.signatureType === 1
          ? "POLY_PROXY"
          : account.signatureType === 3
            ? "POLY_1271"
            : null,
      keychainReady: keychainState.social,
      l2CredentialsReady: keychainState.l2,
      liveEnabled: account.mode === "live_ready",
      emergencyStopped: account.emergencyStopped,
      paperGate,
      capturedAt: new Date().toISOString()
    };
  }

  async getPortfolio(): Promise<GetPortfolioOutput> {
    this.requireProfile();
    return portfolioOutput(await this.service.getPortfolio());
  }

  async scanCandidates(
    input: ScanCandidatesInput
  ): Promise<ScanCandidatesOutput> {
    const candidates = await this.publicClient.scanCandidates(input.categories);
    const minimum = parseDecimalToMicros(input.minLiquidityPusd ?? "0");
    return {
      candidates: candidates
        .filter(
          (candidate) =>
            candidate.liquidityMicros >= minimum &&
            candidate.tokenIds.length > 0
        )
        .slice(0, input.limit)
        .map(candidateOutput),
      capturedAt: new Date().toISOString()
    };
  }

  async getMarketSnapshot(
    input: GetMarketSnapshotInput
  ): Promise<GetMarketSnapshotOutput> {
    const reference = await this.publicClient.resolveMarketReference({
      ...(input.conditionId === undefined
        ? {}
        : { conditionId: input.conditionId }),
      ...(input.tokenId === undefined ? {} : { tokenId: input.tokenId })
    });
    const snapshot = await this.publicClient.getMarketSnapshot({
      ...reference,
      ...(input.side === undefined ? {} : { side: input.side }),
      ...(input.limitPricePusd === undefined
        ? {}
        : { limitPriceMicros: parseDecimalToMicros(input.limitPricePusd) })
    });
    let geoblockStatus: "allowed" | "blocked" | "unknown" = "unknown";
    try {
      const geo = await this.publicClient.checkGeoblock();
      geoblockStatus = geo.blocked ? "blocked" : "allowed";
    } catch {
      geoblockStatus = "unknown";
    }
    return marketSnapshotOutput(
      snapshot,
      geoblockStatus,
      input.limitPricePusd !== undefined
    );
  }

  async getRiskStatus(): Promise<GetRiskStatusOutput> {
    this.requireProfile();
    const status = await this.service.getRiskStatus();
    const coolingDownUntilMs =
      typeof status.coolingDownUntilMs === "number"
        ? status.coolingDownUntilMs
        : null;
    const paused =
      status.emergencyStopped ||
      !status.dailyPnlKnown ||
      !status.liveActivation.active ||
      !status.paperGate.passed ||
      !this.config.liveEnabled ||
      (coolingDownUntilMs !== null && coolingDownUntilMs > Date.now());
    const canary = status.liveTradeCount < DEFAULT_RISK_POLICY.canaryTradeCount;
    const activeViolations: Array<{ code: string; message: string }> = [];
    if (status.emergencyStopped) {
      activeViolations.push({
        code: "EMERGENCY_STOPPED",
        message: "The persistent emergency stop is active."
      });
    }
    if (status.dailyPnlMicros <= -DEFAULT_RISK_POLICY.dailyStopMicros) {
      activeViolations.push({
        code: "DAILY_STOP",
        message: "The daily 10 pUSD loss stop has been reached."
      });
    }
    if (!status.dailyPnlKnown) {
      activeViolations.push({
        code: "DAILY_PNL_UNAVAILABLE",
        message:
          "The daily risk session is not armed; live trading remains paused."
      });
    }
    if (!this.config.liveEnabled) {
      activeViolations.push({
        code: "LIVE_ENVIRONMENT_DISABLED",
        message: "The non-secret live environment switch is disabled."
      });
    }
    if (!status.liveActivation.active) {
      activeViolations.push({
        code: "LOCAL_LIVE_ACTIVATION_MISSING",
        message: "Live trading has not been activated through the local CLI."
      });
    }
    if (!status.paperGate.passed) {
      activeViolations.push({
        code: "PAPER_GATE_NOT_PASSED",
        message: "The 30-day and 50-operation paper gate has not passed."
      });
    }
    if (coolingDownUntilMs !== null && coolingDownUntilMs > Date.now()) {
      activeViolations.push({
        code: "COOLING_DOWN",
        message: "The 24-hour cooldown is active."
      });
    }
    return {
      phase: paused ? "PAUSED" : canary ? "CANARY" : "PILOT",
      policyVersion: RISK_POLICY_VERSION,
      emergencyStopped: status.emergencyStopped,
      coolingDownUntil:
        coolingDownUntilMs === null
          ? null
          : new Date(coolingDownUntilMs).toISOString(),
      limits: {
        allocatedCapitalPusd: formatMicros(DEFAULT_RISK_POLICY.capitalMicros),
        maxOrderPusd: formatMicros(
          canary
            ? DEFAULT_RISK_POLICY.canaryMaxOrderMicros
            : DEFAULT_RISK_POLICY.pilotMaxOrderMicros
        ),
        maxMarketOrCorrelationPusd: formatMicros(
          DEFAULT_RISK_POLICY.maxMarketOrCorrelationMicros
        ),
        maxTotalExposurePusd: formatMicros(
          canary
            ? DEFAULT_RISK_POLICY.canaryMaxOpenExposureMicros
            : DEFAULT_RISK_POLICY.pilotMaxOpenExposureMicros
        ),
        maxOpenMarkets: DEFAULT_RISK_POLICY.maxOpenMarkets,
        dailyStopPusd: formatMicros(DEFAULT_RISK_POLICY.dailyStopMicros),
        canaryTradesRequired: DEFAULT_RISK_POLICY.canaryTradeCount
      },
      totalOpenExposurePusd: formatMicros(status.totalOpenExposureMicros),
      dailyPnlPusd: formatMicros(status.dailyPnlMicros),
      openMarketCount: status.openMarketCount,
      liveTradeCount: status.liveTradeCount,
      activeViolations,
      paperGate: await this.paperGateOutput(),
      capturedAt: new Date().toISOString()
    };
  }

  async prepareTradingSession(
    input: PrepareTradingSessionInput
  ): Promise<PrepareTradingSessionOutput> {
    this.requireProfile();
    const ttlMs = (input.ttlHours ?? 8) * 3600 * 1000;
    const prepared = await this.service.prepareTradingSession({
      executionMode: input.executionMode,
      ttlMs
    });
    return {
      pendingSessionId: prepared.pending.id,
      executionMode: prepared.pending.executionMode,
      cashAvailablePusd:
        prepared.pending.cashAvailableMicros === null
          ? null
          : formatMicros(prepared.pending.cashAvailableMicros),
      openExposurePusd: formatMicros(prepared.pending.openExposureMicros),
      hardCeilingRemainingPusd: formatMicros(
        prepared.pending.hardCeilingRemainingMicros
      ),
      dailyStopRemainingPusd: formatMicros(
        prepared.pending.dailyStopRemainingMicros
      ),
      maximumAuthorizablePusd: formatMicros(
        prepared.pending.maximumAuthorizableMicros
      ),
      expiresAt: new Date(prepared.pending.expiresAtMs).toISOString()
    };
  }

  async prepareResearchBundle(
    input: PrepareResearchBundleInput
  ): Promise<PrepareResearchBundleOutput> {
    this.requireProfile();
    const bundle = await this.researchVerifier.verify({
      marketConditionId: input.conditionId,
      tokenId: input.tokenId,
      estimatedProbabilityMicros: parseDecimalToMicros(
        input.estimatedProbability
      ),
      eventVolatilityClass: input.eventVolatilityClass,
      requestedUrls: input.sourceUrls,
      sourceEvidence: input.sourceEvidence.map((evidence) => ({
        requestedUrl: evidence.requestedUrl,
        supportedClaims: evidence.supportedClaims,
        contradictedClaims: evidence.contradictedClaims,
        quotedFacts: evidence.quotedFacts,
        probabilityImpactMicros: parseDecimalToMicros(
          evidence.probabilityImpact.replace(/^-/, "")
        ) * (evidence.probabilityImpact.startsWith("-") ? -1n : 1n)
      })),
      rationale: input.rationale,
      counterRationale: input.counterRationale
    });
    this.database.saveResearchBundle(bundle);
    return researchBundleOutput(bundle);
  }

  async activateTradingSession(
    input: ActivateTradingSessionInput
  ): Promise<ActivateTradingSessionOutput> {
    this.requireProfile();
    const session = await this.service.activateTradingSession(
      input.pendingSessionId
    );
    return tradingSessionOutput(session);
  }

  async getTradingSession(
    input: GetTradingSessionInput
  ): Promise<GetTradingSessionOutput> {
    this.requireProfile();
    const active = await this.service.getActiveTradingSession(input.executionMode);
    return {
      activeSession: active === null ? null : tradingSessionOutput(active),
      checkedAt: new Date().toISOString()
    };
  }

  async endTradingSession(
    input: EndTradingSessionInput
  ): Promise<EndTradingSessionOutput> {
    this.requireProfile();
    const active = await this.service.getActiveTradingSession(input.executionMode);
    if (!active) {
      throw new PublicMcpToolError("NO_ACTIVE_SESSION", "No active trading session was found.");
    }
    const closedSession = await this.service.closeTradingSession(active.id, input.reason);
    return {
      sessionId: closedSession.id,
      closed: true,
      closedAt: new Date(closedSession.closedAtMs).toISOString(),
      message: `Trading session ${closedSession.id} closed.`
    };
  }

  async supervisePositions(
    _input?: SupervisePositionsInput
  ): Promise<SupervisePositionsOutput> {
    this.requireProfile();
    const result = await this.service.supervisePositions();
    return {
      evaluatedPositionsCount: result.actions.length,
      actions: result.actions.map((action) => ({
        tokenId: action.tokenId,
        conditionId: action.conditionId,
        question: action.question,
        shouldExit: action.shouldExit,
        triggerReason: action.triggerReason,
        explanation: action.explanation,
        recommendedOrderSide: action.recommendedOrderSide
      })),
      evaluatedAt: new Date().toISOString()
    };
  }

  async importLegacyPosition(
    input: ImportLegacyPositionInput
  ): Promise<ImportLegacyPositionOutput> {
    this.requireProfile();
    const result = await this.service.importLegacyPosition(input.tokenId);
    return legacyImportOutput(result.report, result.imported);
  }

  /**
   * Entry point for the detached local daemon. It evaluates deterministic
   * entries, then supervises exits; session creation, research fetching and
   * arbitrary signing remain outside this loop.
   */
  async runSupervisorCycle(): Promise<SupervisorCycleResult> {
    this.requireProfile();
    const reconciliationActive = this.config.liveEnabled
      ? await this.service.monitorLiveSafety()
      : false;
    const entry = await this.service.runAutonomousEntryCycle(
      this.config.liveEnabled ? "live" : "paper"
    );
    const result = await this.service.supervisePositions();
    const priorityReevaluation = result.actions.some(
      (action) => action.triggerReason === "RESEARCH_REQUIRED"
    );
    return {
      evaluatedPositionsCount: result.actions.length,
      actions: result.actions.map((action) => ({
        tokenId: action.tokenId,
        conditionId: action.conditionId,
        question: action.question,
        shouldExit: action.shouldExit,
        triggerReason: action.triggerReason,
        explanation: action.explanation,
        recommendedOrderSide: action.recommendedOrderSide
      })),
      evaluatedAt: new Date().toISOString(),
      reconciliationActive,
      priorityReevaluation,
      entryEvaluatedCandidatesCount: entry.evaluatedCandidatesCount,
      entryStagedCount: entry.stagedCount,
      entryExecutedCount: entry.executedCount,
      entrySkippedCount: entry.skippedCount
    };
  }

  saveSupervisorHeartbeat(heartbeat: SupervisorHeartbeat): void {
    this.database.saveSupervisorHeartbeat(heartbeat);
  }

  getSupervisorHeartbeat(): SupervisorHeartbeat | null {
    return this.database.getSupervisorHeartbeat();
  }

  async failSafeSupervisor(): Promise<void> {
    const reason = "SUPERVISOR_CYCLE_FAILED";
    this.database.setEmergencyStop(true, reason);
    if (this.config.liveEnabled && this.liveTrading !== null) {
      await this.service.emergencyStop(reason);
    }
  }

  async getOrderStatus(
    input: GetOrderStatusInput
  ): Promise<GetOrderStatusOutput> {
    const execution =
      input.proposalId !== undefined
        ? this.database.getExecution(input.proposalId)
        : this.database.getExecutionByOrderId(input.orderId!);
    const proposalId = input.proposalId ?? execution?.proposalId;
    if (proposalId === undefined) {
      throw new PublicMcpToolError("ORDER_NOT_FOUND", "Order was not found.");
    }
    const proposal = this.database.getProposal(proposalId);
    if (proposal === null) {
      throw new PublicMcpToolError("ORDER_NOT_FOUND", "Order was not found.");
    }

    const paper = this.database.getPaperTradeByProposal(proposalId);
    const originalShares = proposal.sharesMicros;
    const liveLedger =
      paper === null && execution !== null
        ? readValidatedLiveLedgerMetrics(execution, proposal)
        : null;
    const filledShares =
      paper?.filledSharesMicros ?? liveLedger?.filledSharesMicros ?? 0n;
    const averageFillPriceMicros =
      paper?.averageFillPriceMicros ??
      liveLedger?.averageFillPriceMicros ??
      null;
    const updatedAtMs =
      paper?.closedAtMs ??
      liveLedger?.updatedAtMs ??
      execution?.submittedAtMs ??
      proposal.createdAtMs;
    return {
      proposalId: proposal.id,
      proposalHash: proposal.hash,
      orderId: execution?.clobOrderId ?? null,
      status:
        paper?.status ??
        execution?.status ??
        proposal.status,
      side: proposal.side,
      limitPricePusd: formatMicros(proposal.limitPriceMicros),
      originalShares: formatMicros(originalShares),
      filledShares: formatMicros(filledShares),
      remainingShares: formatMicros(
        originalShares > filledShares ? originalShares - filledShares : 0n
      ),
      averageFillPricePusd:
        averageFillPriceMicros === null
          ? null
          : formatMicros(averageFillPriceMicros),
      feesPusd: formatMicros(
        paper?.feesMicros ?? liveLedger?.feesMicros ?? 0n
      ),
      createdAt: new Date(proposal.createdAtMs).toISOString(),
      updatedAt: new Date(updatedAtMs).toISOString()
    };
  }

  async stageOrder(input: StageOrderInput): Promise<StageOrderOutput> {
    this.requireProfile();
    if (input.executionMode === "live") {
      const status = await this.service.getAccountStatus();
      if (status.mode !== "live_ready") {
        throw new PublicMcpToolError(
          "LIVE_LOCKED",
          "Live staging is locked until every local and paper gate passes."
        );
      }
    }
    const reference = await this.publicClient.resolveMarketReference({
      ...(input.conditionId === undefined
        ? {}
        : { conditionId: input.conditionId }),
      tokenId: input.tokenId
    });
    const result = await this.service.stageOrder({
      executionMode: input.executionMode,
      intent: input.intent,
      conditionId: reference.conditionId,
      tokenId: reference.tokenId,
      outcome: input.outcome,
      side: input.side,
      shares: input.shares,
      limitPrice: input.limitPricePusd,
      estimatedProbability: input.estimatedProbability,
      thesis: input.thesis,
      counterThesis: input.counterThesis,
      sources: input.sources,
      ...(input.researchBundleId === undefined
        ? {}
        : { researchBundleId: input.researchBundleId }),
      ...(input.exitReason === undefined
        ? {}
        : { exitReason: input.exitReason })
    });
    return proposalOutput(result.proposal);
  }

  async executeStagedOrder(
    input: ExecuteStagedOrderInput
  ): Promise<ExecuteStagedOrderOutput> {
    this.requireProfile();
    const proposal = this.database.getProposal(input.proposalId);
    if (!proposal || proposal.hash !== input.proposalHash) {
      throw new PublicMcpToolError(
        "PROPOSAL_NOT_FOUND",
        "The staged proposal was not found or hash mismatched."
      );
    }
    const result = await this.service.executeStagedProposal(
      input.proposalId,
      input.proposalHash
    );
    return {
      proposalId: proposal.id,
      proposalHash: proposal.hash,
      status: result.accepted ? "EXECUTING" : "FAILED",
      message: result.message
    };
  }

  async cancelOrder(input: CancelOrderInput): Promise<CancelOrderOutput> {
    const nowMs = Date.now();
    const execution =
      input.proposalId === undefined
        ? this.database.getExecutionByOrderId(input.orderId!)
        : this.database.getExecution(input.proposalId);
    const proposalId = input.proposalId ?? execution?.proposalId ?? null;
    const proposal =
      proposalId === null ? null : this.database.getProposal(proposalId);
    if (proposal === null && execution === null) {
      return {
        orderId: input.orderId ?? null,
        proposalId,
        status: "NOT_FOUND",
        cancelledAt: new Date(nowMs).toISOString(),
        message: "No matching local proposal or CLOB order was found."
      };
    }

    if (
      proposal !== null &&
      proposal.status === "STAGED"
    ) {
      const cancelled = this.database.transitionProposal(
        proposal.id,
        proposal.status,
        "CANCELLED",
        nowMs
      );
      return {
        orderId: execution?.clobOrderId ?? input.orderId ?? null,
        proposalId: proposal.id,
        status: cancelled === null ? "ALREADY_TERMINAL" : "CANCELLED",
        cancelledAt: new Date(nowMs).toISOString(),
        message:
          cancelled === null
            ? "The proposal was already terminal."
            : "The unsubmitted proposal was cancelled locally."
      };
    }

    const orderId = input.orderId ?? execution?.clobOrderId ?? null;
    if (
      orderId === null ||
      this.liveTrading === null ||
      (proposal !== null && TERMINAL_PROPOSAL_STATUSES.has(proposal.status))
    ) {
      return {
        orderId,
        proposalId,
        status: "ALREADY_TERMINAL",
        cancelledAt: new Date(nowMs).toISOString(),
        message: "There is no cancellable live order."
      };
    }
    const response = await this.liveTrading.cancelOrder(orderId);
    const canceled = readStringArray(response.canceled).includes(orderId);
    if (execution !== null && canceled) {
      this.database.updateExecutionStatus(
        execution.proposalId,
        "CANCEL_REQUESTED",
        JSON.stringify(response),
        nowMs
      );
    }
    return {
      orderId,
      proposalId,
      status: canceled ? "CANCEL_REQUESTED" : "ALREADY_TERMINAL",
      cancelledAt: new Date(nowMs).toISOString(),
      message: canceled
        ? "The CLOB accepted the cancellation request; terminal state still requires reconciliation."
        : "The CLOB did not report this order as newly cancelled."
    };
  }

  async emergencyStop(
    input: EmergencyStopInput
  ): Promise<EmergencyStopOutput> {
    const openOrderIds = this.database
      .listExecutions()
      .filter(
        (execution) =>
          execution.clobOrderId !== null &&
          !TERMINAL_REMOTE_STATUSES.has(execution.status.toUpperCase())
      )
      .map((execution) => execution.clobOrderId!)
      .filter((value, index, values) => values.indexOf(value) === index);
    const result = await this.service.emergencyStop(input.reason);
    const response =
      "response" in result &&
      result.response !== null &&
      typeof result.response === "object"
        ? (result.response as Record<string, unknown>)
        : {};
    const cancelledOrderIds = readStringArray(response.canceled);
    const failedOrderIds = openOrderIds.filter(
      (orderId) => !cancelledOrderIds.includes(orderId)
    );
    return {
      active: true,
      cancelledOrderIds,
      failedOrderIds,
      activatedAt: new Date().toISOString(),
      message:
        failedOrderIds.length === 0
          ? "Emergency lock is active and cancellation requests were accepted for all known open orders; terminal state still requires reconciliation."
          : "Emergency lock is active; some cancellation requests failed or still require manual verification."
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // Stop future gates and signing synchronously. The dashboard is then
    // drained so an already accepted callback cannot claim an execution after
    // the final ledger check.
    this.database.setLiveActivation(false);
    this.liveTrading?.beginShutdown();
    await this.dashboardServer.stop();

    if (this.hasUnreconciledLiveExecution()) {
      this.database.setEmergencyStop(
        true,
        "RUNTIME_SHUTDOWN_WITH_OPEN_EXECUTION"
      );
      await this.service.emergencyStop(
        "RUNTIME_SHUTDOWN_WITH_OPEN_EXECUTION"
      );
    }
    await this.liveTrading?.stopHeartbeat();
    this.liveTrading?.close();
    this.database.close();
  }

  private async paperGateOutput(): Promise<
    GetAccountStatusOutput["paperGate"]
  > {
    const [metrics, result] = await Promise.all([
      this.paperGate.metrics(),
      this.paperGate.result(this.config.paperGateSkip)
    ]);
    return {
      passed: result.passed,
      skipped: result.skipped === true || this.config.paperGateSkip,
      firstTradeAt:
        metrics.firstTradeAtMs === null
          ? null
          : new Date(metrics.firstTradeAtMs).toISOString(),
      daysObserved:
        metrics.firstTradeAtMs === null
          ? 0
          : Math.max(0, (Date.now() - metrics.firstTradeAtMs) / 86_400_000),
      totalTrades: metrics.totalTrades,
      closedTrades: metrics.closedTrades,
      netPnlPusd: formatMicros(metrics.netPnlMicros),
      maxDrawdownPusd: formatMicros(metrics.maxDrawdownMicros),
      riskViolations: metrics.riskViolations,
      reconciliationErrors: metrics.reconciliationErrors,
      reasons: result.reasons
    };
  }

  private async keychainState(): Promise<{ social: boolean; l2: boolean }> {
    if (this.keychain === null || !this.keychainHelperAvailable) {
      return { social: false, l2: false };
    }
    try {
      const [social, l2] = await Promise.all([
        this.keychain.status(SOCIAL_PRIVATE_KEY_ACCOUNT),
        this.keychain.status(L2_CREDENTIALS_ACCOUNT)
      ]);
      return { social: social.exists, l2: l2.exists };
    } catch {
      return { social: false, l2: false };
    }
  }

  private lockAfterUnsafeRestart(): void {
    if (
      this.hasUnreconciledLiveExecution() &&
      !this.database.getEmergencyStop().active
    ) {
      this.database.setEmergencyStop(
        true,
        "RESTART_WITH_UNRECONCILED_OPEN_ORDERS"
      );
    }
  }

  private hasUnreconciledLiveExecution(): boolean {
    return this.database
      .listExecutions()
      .some(
        (execution) =>
          execution.status.toUpperCase() === "CLAIMED" ||
          execution.status.toUpperCase() === "SUBMISSION_UNKNOWN" ||
          (execution.clobOrderId !== null &&
            !TERMINAL_REMOTE_STATUSES.has(execution.status.toUpperCase()))
      );
  }

  private requireProfile(): void {
    if (this.config.profileAddress === ZERO_ADDRESS) {
      throw new PublicMcpToolError(
        "PROFILE_NOT_CONFIGURED",
        "Set the public POLYMARKET_PROFILE_ADDRESS first."
      );
    }
  }
}

export async function createMcpToolDependencies(): Promise<McpToolDependencies> {
  const runtime = new PolymarketRuntime();
  return {
    start: () => runtime.startDashboard(),
    getAccountStatus: () => guarded(() => runtime.getAccountStatus()),
    getPortfolio: () => guarded(() => runtime.getPortfolio()),
    scanCandidates: (input) => guarded(() => runtime.scanCandidates(input)),
    getMarketSnapshot: (input) =>
      guarded(() => runtime.getMarketSnapshot(input)),
    getRiskStatus: () => guarded(() => runtime.getRiskStatus()),
    getOrderStatus: (input) => guarded(() => runtime.getOrderStatus(input)),
    prepareTradingSession: (input) =>
      guarded(() => runtime.prepareTradingSession(input)),
    prepareResearchBundle: (input) =>
      guarded(() => runtime.prepareResearchBundle(input)),
    activateTradingSession: (input) =>
      guarded(() => runtime.activateTradingSession(input)),
    getTradingSession: (input) =>
      guarded(() => runtime.getTradingSession(input)),
    endTradingSession: (input) =>
      guarded(() => runtime.endTradingSession(input)),
    supervisePositions: (input) =>
      guarded(() => runtime.supervisePositions(input)),
    importLegacyPosition: (input) =>
      guarded(() => runtime.importLegacyPosition(input)),
    stageOrder: (input) => guarded(() => runtime.stageOrder(input)),
    executeStagedOrder: (input) =>
      guarded(() => runtime.executeStagedOrder(input)),
    cancelOrder: (input) => guarded(() => runtime.cancelOrder(input)),
    emergencyStop: (input) => guarded(() => runtime.emergencyStop(input)),
    close: () => runtime.close()
  };
}

async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PublicMcpToolError) {
      throw error;
    }
    if (error instanceof ProposalRejectedError) {
      throw new PublicMcpToolError(
        "RISK_REJECTED",
        `Proposal rejected: ${error.violations
          .map((violation) => violation.code)
          .join(", ")}.`
      );
    }
    if (error instanceof SafeExternalServiceError) {
      throw new PublicMcpToolError(error.code, error.message);
    }
    if (error instanceof KeychainHelperError) {
      throw new PublicMcpToolError(
        error.code,
        "The protected local credential operation did not complete."
      );
    }
    throw error;
  }
}

function portfolioOutput(portfolio: PortfolioSnapshot): GetPortfolioOutput {
  return {
    profileAddress: portfolio.profileAddress,
    pUsdBalancePusd:
      portfolio.pUsdBalanceMicros === null
        ? null
        : formatMicros(portfolio.pUsdBalanceMicros),
    totalPositionValuePusd: formatMicros(portfolio.totalPositionValueMicros),
    totalPnlPusd: formatMicros(portfolio.totalPnlMicros),
    positions: portfolio.positions.map((position) => ({
      tokenId: position.tokenId,
      conditionId: position.conditionId,
      question: position.question || "Unavailable market title",
      outcome: position.outcome || "Unavailable outcome",
      sizeShares: formatMicros(position.sizeMicros),
      averagePricePusd: formatMicros(position.averagePriceMicros),
      currentPricePusd: formatMicros(position.currentPriceMicros),
      currentValuePusd: formatMicros(position.currentValueMicros),
      cashPnlPusd: formatMicros(position.cashPnlMicros),
      realizedPnlPusd: formatMicros(position.realizedPnlMicros),
      endTime: new Date(position.endTimeMs).toISOString()
    })),
    capturedAt: new Date(portfolio.capturedAtMs).toISOString(),
    source: portfolio.source
  };
}

function candidateOutput(candidate: CandidateMarket) {
  return {
    conditionId: candidate.conditionId,
    slug: candidate.slug,
    question: candidate.question,
    category: candidate.category,
    endTime: new Date(candidate.endTimeMs).toISOString(),
    volume24hPusd: formatMicros(candidate.volume24hMicros),
    liquidityPusd: formatMicros(candidate.liquidityMicros),
    spreadPusd:
      candidate.spreadMicros === null
        ? null
        : formatMicros(candidate.spreadMicros),
    tokenIds: candidate.tokenIds,
    active: candidate.active,
    acceptingOrders: candidate.acceptingOrders
  };
}

function marketSnapshotOutput(
  market: MarketSnapshot,
  geoblockStatus: "allowed" | "blocked" | "unknown",
  hasLimit: boolean
): GetMarketSnapshotOutput {
  return {
    conditionId: market.conditionId,
    tokenId: market.tokenId,
    eventId: market.eventId,
    question: market.question || "Unavailable market question",
    slug: market.slug || "unavailable",
    outcome: market.outcome || "Unavailable outcome",
    category: market.category,
    rules: market.rules || "UNAVAILABLE",
    resolutionSource: market.resolutionSource || "UNAVAILABLE",
    endTime: new Date(market.endTimeMs).toISOString(),
    active: market.active,
    closed: market.closed,
    acceptingOrders: market.acceptingOrders,
    negRisk: market.negRisk,
    tickSizePusd: formatMicros(market.tickSizeMicros),
    minOrderSizeShares: formatMicros(market.minOrderSizeMicros),
    feesEnabled: market.feesEnabled,
    feeRateBps: market.feeRateBps,
    feeExponent: market.feeExponent ?? 1,
    feesTakerOnly: market.feesTakerOnly ?? true,
    bestBidPusd:
      market.bestBidMicros > 0n ? formatMicros(market.bestBidMicros) : null,
    bestAskPusd:
      market.bestAskMicros > 0n ? formatMicros(market.bestAskMicros) : null,
    spreadPusd:
      market.bestBidMicros > 0n && market.bestAskMicros > 0n
        ? formatMicros(market.spreadMicros)
        : null,
    depthPusdAtLimit: hasLimit
      ? formatMicros(market.depthPusdMicrosAtLimit)
      : null,
    bids: market.bids.map((level) => ({
      pricePusd: formatMicros(level.priceMicros),
      shares: formatMicros(level.sharesMicros)
    })),
    asks: market.asks.map((level) => ({
      pricePusd: formatMicros(level.priceMicros),
      shares: formatMicros(level.sharesMicros)
    })),
    geoblockStatus,
    capturedAt: new Date(market.capturedAtMs).toISOString()
  };
}

function tradingSessionOutput(session: TradingSession) {
  return {
    sessionId: session.id,
    executionMode: session.executionMode,
    authorizedBudgetPusd: formatMicros(session.authorizedBudgetMicros),
    usedBudgetPusd: formatMicros(
      session.authorizedBudgetMicros - session.remainingBudgetMicros
    ),
    remainingBudgetPusd: formatMicros(session.remainingBudgetMicros),
    status: session.status,
    createdAt: new Date(session.createdAtMs).toISOString(),
    expiresAt: new Date(session.expiresAtMs).toISOString()
  };
}

function proposalOutput(proposal: OrderProposal): StageOrderOutput {
  return {
    proposalId: proposal.id,
    proposalHash: proposal.hash,
    status:
      proposal.status === "SIMULATED"
        ? "SIMULATED"
        : "STAGED",
    executionMode: proposal.executionMode,
    intent: proposal.intent,
    sessionId: proposal.sessionId,
    researchBundleId: proposal.researchBundleId,
    createdAt: new Date(proposal.createdAtMs).toISOString(),
    expiresAt: new Date(proposal.expiresAtMs).toISOString(),
    market: marketSnapshotOutput(proposal.market, "unknown", true),
    side: proposal.side,
    shares: formatMicros(proposal.sharesMicros),
    limitPricePusd: formatMicros(proposal.limitPriceMicros),
    maxCostPusd: formatMicros(proposal.maxCostMicros),
    maxLossPusd: formatMicros(proposal.maxLossMicros),
    estimatedFeePusd: formatMicros(proposal.estimatedFeeMicros),
    estimatedProbability: formatMicros(proposal.estimatedProbabilityMicros),
    expectedEdge: formatMicros(proposal.expectedEdgeMicros),
    postTradeMarketExposurePusd: formatMicros(
      proposal.postTradeMarketExposureMicros
    ),
    postTradeTotalExposurePusd: formatMicros(
      proposal.postTradeTotalExposureMicros
    ),
    thesis: proposal.thesis,
    counterThesis: proposal.counterThesis,
    sources: proposal.sources,
    correlationKey: proposal.correlationKey,
    policyVersion: proposal.policyVersion,
    ...(proposal.exitReason === undefined
      ? {}
      : { exitReason: proposal.exitReason })
  };
}

function researchBundleOutput(
  bundle: ResearchBundle
): PrepareResearchBundleOutput {
  return {
    researchBundleId: bundle.id,
    conditionId: bundle.marketConditionId,
    tokenId: bundle.tokenId,
    estimatedProbability: formatMicros(bundle.estimatedProbabilityMicros),
    eventVolatilityClass: bundle.eventVolatilityClass,
    createdAt: new Date(bundle.createdAtMs).toISOString(),
    expiresAt: new Date(bundle.expiresAtMs).toISOString(),
    sources: bundle.sources.map((source) => ({
      requestedUrl: source.requestedUrl,
      finalUrl: source.finalUrl,
      registrableDomain: source.registrableDomain,
      publisher: source.publisher,
      title: source.title,
      publishedAt: new Date(source.publishedAtMs).toISOString(),
      retrievedAt: new Date(source.retrievedAtMs).toISOString(),
      httpStatus: source.httpStatus,
      contentType: source.contentType as
        | "text/html"
        | "text/plain"
        | "application/xhtml+xml",
      excerptHash: source.excerptHash,
      responseBodyHash: source.responseBodyHash,
      supportedClaims: source.supportedClaims,
      contradictedClaims: source.contradictedClaims,
      quotedFactHashes: source.quotedFactHashes,
      probabilityImpact: formatMicros(source.probabilityImpactMicros)
    })),
    rationale: bundle.rationale,
    counterRationale: bundle.counterRationale,
    contentHash: bundle.contentHash
  };
}

function legacyImportOutput(
  report: LegacyImportReport,
  imported: boolean
): ImportLegacyPositionOutput {
  return {
    reportId: report.id,
    imported,
    tokenId: report.tokenId,
    conditionId: report.conditionId,
    quality: report.quality,
    automaticExitPolicy: report.automaticExitPolicy,
    shares: formatMicros(report.sharesMicros),
    averageEntryPricePusd: formatMicros(report.averagePriceMicros),
    openedAt:
      report.openedAtMs === null
        ? null
        : new Date(report.openedAtMs).toISOString(),
    feesPusd:
      report.feesMicros === null ? null : formatMicros(report.feesMicros),
    activityFillCount: report.activityFillCount,
    localEvidenceCount: report.localEvidenceCount,
    reconciledOrderCount: report.reconciledOrderCount,
    reconciledFillCount: report.reconciledFillCount,
    remoteOpenOrderCount: report.remoteOpenOrderCount,
    ordersChecked: report.ordersChecked,
    transactionHashes: report.transactionHashes,
    importedAt: new Date(report.importedAtMs).toISOString(),
    message: report.message
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is string => typeof candidate === "string")
    : [];
}

function readValidatedLiveLedgerMetrics(
  execution: NonNullable<ReturnType<TradingDatabase["getExecution"]>>,
  proposal: OrderProposal
): {
  filledSharesMicros: bigint;
  averageFillPriceMicros: bigint | null;
  feesMicros: bigint;
  updatedAtMs: number;
} {
  try {
    const response = parseWithBigInts<Record<string, unknown>>(
      execution.responseJson
    );
    let filledSharesMicros = 0n;
    if (response.order !== undefined) {
      const order = requireLocalRecord(response.order);
      if (
        order.id !== execution.clobOrderId ||
        typeof order.market !== "string" ||
        order.market.toLowerCase() !==
          proposal.market.conditionId.toLowerCase() ||
        order.assetId !== proposal.market.tokenId ||
        typeof order.side !== "string" ||
        order.side.toUpperCase() !== proposal.side ||
        parseClobFixed6(
          order.originalSize,
          "LOCAL_LEDGER_ORDER_SIZE_INVALID"
        ) !== proposal.sharesMicros
      ) {
        throw new Error("LOCAL_LEDGER_ORDER_MISMATCH");
      }
      filledSharesMicros = parseClobFixed6(
        order.sizeMatched,
        "LOCAL_LEDGER_MATCHED_SIZE_INVALID"
      );
      if (filledSharesMicros > proposal.sharesMicros) {
        throw new Error("LOCAL_LEDGER_MATCHED_SIZE_INVALID");
      }
    }

    let weightedPriceNumerator = 0n;
    let attributedShares = 0n;
    let updatedAtMs = execution.submittedAtMs;
    if (response.attributedTrades !== undefined) {
      if (!Array.isArray(response.attributedTrades)) {
        throw new Error("LOCAL_LEDGER_TRADES_INVALID");
      }
      for (const rawTrade of response.attributedTrades) {
        const trade = requireLocalRecord(rawTrade);
        if (
          typeof trade.sharesMicros !== "bigint" ||
          trade.sharesMicros <= 0n ||
          typeof trade.priceMicros !== "bigint" ||
          trade.priceMicros <= 0n ||
          trade.priceMicros >= 1_000_000n ||
          typeof trade.lastUpdateMs !== "number" ||
          !Number.isSafeInteger(trade.lastUpdateMs)
        ) {
          throw new Error("LOCAL_LEDGER_TRADES_INVALID");
        }
        attributedShares += trade.sharesMicros;
        weightedPriceNumerator +=
          trade.sharesMicros * trade.priceMicros;
        updatedAtMs = Math.max(updatedAtMs, trade.lastUpdateMs);
      }
      if (attributedShares !== filledSharesMicros) {
        throw new Error("LOCAL_LEDGER_FILL_MISMATCH");
      }
    } else if (filledSharesMicros !== 0n) {
      throw new Error("LOCAL_LEDGER_FILL_EVIDENCE_MISSING");
    }

    let feesMicros = 0n;
    if (response.onchain !== undefined && response.onchain !== null) {
      const onchain = requireLocalRecord(response.onchain);
      if (
        typeof onchain.feeMicros !== "bigint" ||
        onchain.feeMicros < 0n ||
        onchain.feeMicros > proposal.estimatedFeeMicros
      ) {
        throw new Error("LOCAL_LEDGER_FEE_INVALID");
      }
      feesMicros = onchain.feeMicros;
    }
    return {
      filledSharesMicros,
      averageFillPriceMicros:
        attributedShares === 0n
          ? null
          : weightedPriceNumerator / attributedShares,
      feesMicros,
      updatedAtMs
    };
  } catch {
    throw new PublicMcpToolError(
      "LOCAL_LEDGER_INVALID",
      "The locally reconciled order ledger is inconsistent."
    );
  }
}

function requireLocalRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("LOCAL_LEDGER_RECORD_INVALID");
  }
  return value as Record<string, unknown>;
}
