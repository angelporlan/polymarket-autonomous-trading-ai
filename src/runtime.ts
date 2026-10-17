import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AccountBindingPort,
  MarketReference,
  PaperGatePort
} from "./application/ports.js";
import {
  DatabaseRiskContext,
  zonedDayKey,
  zonedDayStartMs
} from "./application/risk-context.js";
import { TradingService } from "./application/trading-service.js";
import { DashboardHttpServer } from "./approval/server.js";
import { loadConfig, type AppConfig } from "./config.js";
import { hashCanonical, hashMarketSnapshot, ProposalRejectedError } from "./domain/proposals.js";
import {
  DEFAULT_RISK_POLICY,
  RISK_HARD_DAILY_STOP_PUSD,
  RISK_POLICY_VERSION
} from "./domain/risk-policy.js";
import {
  AGENT_POLICY_INCREASE_COOLDOWN_MS,
  AGENT_POLICY_SAME_MARKET_LOSS_COOLDOWN_MS,
  applyAgentPolicyPatch,
  isRiskIncrease,
  type AgentPolicyPatch
} from "./domain/agent-policy.js";
import {
  formatMicros,
  parseDecimalToMicros,
  type CandidateMarket,
  type MarketSnapshot,
  type OrderProposal,
  type PaperTrade,
  type PortfolioSnapshot,
  type ResearchBundle,
  type AgentRun,
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
  PrepareMarketEvidenceInput,
  PrepareMarketEvidenceOutput,
  PrepareAgentEvidenceInput,
  PrepareAgentEvidenceOutput,
  PrepareAgentCycleInput,
  PrepareAgentCycleOutput,
  SupervisePositionsInput,
  SupervisePositionsOutput,
  ImportLegacyPositionInput,
  ImportLegacyPositionOutput,
  StartAgentRunInput,
  StartAgentRunOutput,
  HeartbeatAgentRunInput,
  HeartbeatAgentRunOutput,
  GetAgentRunInput,
  GetAgentRunOutput,
  StopAgentRunInput,
  StopAgentRunOutput,
  GetAgentPolicyInput,
  GetAgentPolicyOutput,
  AdjustAgentPolicyInput,
  AdjustAgentPolicyOutput
} from "./mcp/schemas.js";
import { GuardedLiveTradingAdapter } from "./polymarket/live-adapter.js";
import {
  PolymarketMarketChannelMonitor
} from "./polymarket/market-channel-monitor.js";
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
import {
  isPortfolioAdoptionCurrent
} from "./onboarding/service.js";
import type {
  SupervisorCycleResult,
  SupervisorHeartbeat,
  SupervisorMode
} from "./supervisor/types.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const SERVER_VERSION = "0.1.0";
export const BUILD_ID = "agent-market-ws-v1";
const AGENT_CYCLE_TTL_MS = 5_000;

/**
 * Shadow/paper observation remains useful while live is deliberately locked.
 * A live reconciliation, however, must never be bypassed just because the
 * process was started in shadow mode.
 */
export function shouldSkipSupervisorCycle(input: {
  liveEnabled: boolean;
  liveActivation: boolean;
  reconciliationRequired: boolean;
  emergencyStopped: boolean;
}): boolean {
  if (input.reconciliationRequired) return false;
  if (!input.liveEnabled) return false;
  return !input.liveActivation || input.emergencyStopped;
}
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

interface AgentCycleSnapshotRecord {
  agentRunId: string;
  cycleId: string;
  candidateSnapshotId: string;
  snapshot: MarketSnapshot;
  expiresAtMs: number;
}

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
  private readonly runtimeInstanceId = `runtime_${randomUUID()}`;
  private readonly controllerId = this.runtimeInstanceId;
  private marketChannel: PolymarketMarketChannelMonitor | null = null;
  private marketChannelGeneration = 0;
  private marketChannelTokens: string[] = [];
  private readonly agentCycleSnapshots = new Map<
    string,
    AgentCycleSnapshotRecord
  >();
  private ownsAgentRun = false;
  private agentLeaseTimer: NodeJS.Timeout | null = null;
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
      database: this.database,
      paperGateSkip: this.config.paperGateSkip,
      paperGateSkipSource: this.config.paperGateSkipSource,
      serverVersion: SERVER_VERSION,
      buildId: BUILD_ID,
      marketChannelStatus: () => this.marketChannelStatus()
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
      paperGateSkipSource: this.config.paperGateSkipSource,
      liveTrading: this.liveTrading,
      getAgentMarketSnapshot: (reference: MarketReference) =>
        this.getAgentMarketSnapshot(reference),
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
    const marketChannel = this.marketChannelStatus();
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
        serverVersion: SERVER_VERSION,
        buildId: BUILD_ID,
        runtimeInstanceId: this.runtimeInstanceId,
        portfolioAdoptionStatus: "NOT_REQUIRED",
        marketChannel,
        paperGate,
        capturedAt: new Date().toISOString()
      };
    }

    const account = await this.service.getAccountStatus();
    const keychainState = await this.keychainState();
    const portfolioAdoptionStatus = await this.getPortfolioAdoptionStatus();
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
      serverVersion: SERVER_VERSION,
      buildId: BUILD_ID,
      runtimeInstanceId: this.runtimeInstanceId,
      portfolioAdoptionStatus,
      marketChannel,
      paperGate,
      capturedAt: new Date().toISOString()
    };
  }

  async getPortfolio(): Promise<GetPortfolioOutput> {
    this.requireProfile();
    const portfolio = await this.service.getPortfolio();
    const dayKey = zonedDayKey(Date.now(), "Europe/Madrid");
    const adoption = this.database.getLivePortfolioAdoption();
    const grandfathered = isPortfolioAdoptionCurrent(
      adoption,
      this.config.profileAddress,
      dayKey,
      portfolio
    )
      ? this.database.getGrandfatheredPositionKeys(dayKey)
      : new Set<string>();
    return portfolioOutput(portfolio, grandfathered);
  }

  async verifyAutonomousStartPreflight(): Promise<void> {
    this.requireProfile();
    const portfolio = await this.publicClient.getPortfolio(
      this.config.profileAddress
    );
    if (
      portfolio.positions.some((position) => position.sizeMicros > 0n) &&
      !isPortfolioAdoptionCurrent(
        this.database.getLivePortfolioAdoption(),
        this.config.profileAddress,
        zonedDayKey(Date.now(), "Europe/Madrid"),
        portfolio
      )
    ) {
      throw new PublicMcpToolError(
        "PORTFOLIO_ADOPTION_REQUIRED",
        "The existing portfolio is missing a current daily adoption."
      );
    }
    if (this.liveTrading === null) {
      throw new PublicMcpToolError(
        "LIVE_ADAPTER_NOT_CONFIGURED",
        "Authenticated read-only order checks are unavailable."
      );
    }
    const sinceMs = zonedDayStartMs(Date.now(), "Europe/Madrid");
    const [openOrders, activity] = await Promise.all([
      this.liveTrading.getOpenOrders(),
      this.publicClient.getUserActivity(this.config.profileAddress, sinceMs)
    ]);
    if (openOrders.length > 0) {
      throw new PublicMcpToolError(
        "OPEN_ORDERS_PRESENT",
        "Autonomous start requires zero remotely open orders."
      );
    }
    if (activity.length > 0) {
      throw new PublicMcpToolError(
        "SAME_DAY_ACTIVITY_PRESENT",
        "Autonomous start cannot establish a new baseline after remote activity since Madrid midnight."
      );
    }
  }

  async scanCandidates(
    input: ScanCandidatesInput
  ): Promise<ScanCandidatesOutput> {
    const candidates = await this.publicClient.scanCandidates(input.categories);
    const minimum = parseDecimalToMicros(input.minLiquidityPusd ?? "0");
    const agentRunActive = this.database.getAgentRun()?.status === "ACTIVE";
    const effectiveLimit = agentRunActive ? Math.min(input.limit, 10) : input.limit;
    return {
      candidates: candidates
        .filter(
          (candidate) =>
            candidate.liquidityMicros >= minimum &&
            candidate.tokenIds.length > 0
        )
        .slice(0, effectiveLimit)
        .map(candidateOutput),
      capturedAt: new Date().toISOString()
    };
  }

  async prepareAgentCycle(
    input: PrepareAgentCycleInput
  ): Promise<PrepareAgentCycleOutput> {
    this.requireProfile();
    const cycleId = `cycle_${randomUUID()}`;
    this.touchAgentRun(input.agentRunId, "ANALYZING", cycleId);
    await this.requireCurrentAgentPortfolioAdoption(input.agentRunId);
    const minimum = parseDecimalToMicros(input.minLiquidityPusd ?? "0");
    const markets = (await this.publicClient.scanCandidates(input.categories))
      .filter(
        (candidate) =>
          candidate.active &&
          candidate.acceptingOrders &&
          candidate.liquidityMicros >= minimum
      );
    const seenTokens = new Set<string>();
    const candidates = markets
      .flatMap((candidate) =>
        candidate.tokenIds.map((tokenId) => ({ candidate, tokenId }))
      )
      .filter(({ tokenId }) => {
        if (seenTokens.has(tokenId)) return false;
        seenTokens.add(tokenId);
        return true;
      })
      .slice(0, Math.min(input.limit, 10));
    if (candidates.length === 0) {
      this.touchAgentRun(input.agentRunId, "HEARTBEAT", cycleId);
      const nowMs = Date.now();
      return {
        cycleId,
        agentRunId: input.agentRunId,
        channelGeneration: this.marketChannelGeneration || 1,
        candidates: [],
        preparedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + AGENT_CYCLE_TTL_MS).toISOString()
      };
    }

    const geo = await this.publicClient.checkGeoblock();
    if (geo.blocked || Date.now() - geo.checkedAtMs > 5_000) {
      await this.failActiveAgentRun("GEOBLOCK_BLOCKED_OR_STALE");
      throw new PublicMcpToolError(
        "GEOBLOCK_BLOCKED_OR_STALE",
        "The fresh geoblock check did not allow trading."
      );
    }

    const tokenIds = candidates.map((candidate) => candidate.tokenId);
    const monitor = await this.ensureMarketChannel(tokenIds);
    this.touchAgentRun(input.agentRunId, "ANALYZING", cycleId);
    const books = await Promise.all(
      tokenIds.map((tokenId) => monitor.getFreshBook(tokenId))
    );
    const prepared = await Promise.all(
      candidates.map(async ({ candidate, tokenId }, index) => {
        const book = books[index] ?? null;
        if (book === null) {
          return {
            conditionId: candidate.conditionId,
            tokenId,
            question: candidate.question,
            category: candidate.category,
            status: "SKIPPED_BOOK_UNAVAILABLE" as const,
            candidateSnapshotId: null,
            snapshot: null,
            reasonCode: "SKIPPED_BOOK_UNAVAILABLE"
          };
        }
        try {
          const snapshot = await this.publicClient.getMarketSnapshot({
            conditionId: candidate.conditionId,
            tokenId,
            category: candidate.category,
            realtimeBook: book
          });
          if (Date.now() - snapshot.capturedAtMs > AGENT_CYCLE_TTL_MS) {
            return {
              conditionId: candidate.conditionId,
              tokenId,
              question: candidate.question,
              category: candidate.category,
              status: "SKIPPED_BOOK_UNAVAILABLE" as const,
              candidateSnapshotId: null,
              snapshot: null,
              reasonCode: "SKIPPED_BOOK_UNAVAILABLE"
            };
          }
          this.database.saveMarketSnapshot(snapshot);
          const candidateSnapshotId = `snapshot_${hashCanonical({
            agentRunId: input.agentRunId,
            cycleId,
            channelGeneration: snapshot.channelGeneration,
            capturedAtMs: snapshot.capturedAtMs,
            snapshotHash: hashMarketSnapshot(snapshot)
          }).slice(0, 40)}`;
          this.agentCycleSnapshots.set(candidateSnapshotId, {
            agentRunId: input.agentRunId,
            cycleId,
            candidateSnapshotId,
            snapshot,
            expiresAtMs: snapshot.capturedAtMs + AGENT_CYCLE_TTL_MS
          });
          return {
            conditionId: snapshot.conditionId,
            tokenId,
            question: snapshot.question,
            category: snapshot.category,
            status: "READY" as const,
            candidateSnapshotId,
            snapshot: marketSnapshotOutput(snapshot, "allowed", false),
            reasonCode: null
          };
        } catch (error) {
          const disposition = classifyAgentCycleMarketError(error);
          if (disposition === "FAIL_RUN") {
            await this.failActiveAgentRun(safeRuntimeErrorCode(error));
            throw error;
          }
          if (disposition === "SKIP_BOOK") {
            return {
              conditionId: candidate.conditionId,
              tokenId,
              question: candidate.question,
              category: candidate.category,
              status: "SKIPPED_BOOK_UNAVAILABLE" as const,
              candidateSnapshotId: null,
              snapshot: null,
              reasonCode: "SKIPPED_BOOK_UNAVAILABLE"
            };
          }
          return {
            conditionId: candidate.conditionId,
            tokenId,
            question: candidate.question,
            category: candidate.category,
            status: "SKIPPED_MARKET_CHANGED" as const,
            candidateSnapshotId: null,
            snapshot: null,
            reasonCode: safeRuntimeErrorCode(error)
          };
        }
      })
    );
    this.pruneAgentCycleSnapshots(Date.now());
    this.touchAgentRun(input.agentRunId, "HEARTBEAT", cycleId);
    const nowMs = Date.now();
    return {
      cycleId,
      agentRunId: input.agentRunId,
      channelGeneration: monitor.status().generation,
      candidates: prepared,
      preparedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + AGENT_CYCLE_TTL_MS).toISOString()
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
    const agentPolicy = this.database.getAgentPolicy();
    const coolingDownUntilMs =
      typeof status.coolingDownUntilMs === "number"
        ? status.coolingDownUntilMs
        : null;
    const paused =
      status.emergencyStopped ||
      !status.dailyPnlKnown ||
      !status.liveActivation.active ||
      !status.paperGate.passed ||
      (this.config.paperGateSkip && this.config.paperGateSkipSource !== "dotenv") ||
      !this.config.liveEnabled ||
      (coolingDownUntilMs !== null && coolingDownUntilMs > Date.now());
    const pilotEligible =
      status.liveTradeCount >= agentPolicy.risk.canaryTradeCount &&
      status.dailyPnlKnown &&
      status.dailyPnlMicros > 0n &&
      (status.drawdownMicros ?? RISK_HARD_DAILY_STOP_PUSD) <= 5_000_000n &&
      !status.emergencyStopped;
    const canary = !pilotEligible;
    const activeViolations: Array<{ code: string; message: string }> = [];
    if (status.emergencyStopped) {
      activeViolations.push({
        code: "EMERGENCY_STOPPED",
        message: "The persistent emergency stop is active."
      });
    }
    if (status.dailyPnlMicros <= -agentPolicy.risk.dailyStopMicros) {
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
    if (this.config.paperGateSkip && this.config.paperGateSkipSource !== "dotenv") {
      activeViolations.push({
        code: "PAPER_GATE_SKIP_NOT_DOTENV",
        message: "The paper-gate bypass is ignored unless configured in the local .env file."
      });
    }
    if (coolingDownUntilMs !== null && coolingDownUntilMs > Date.now()) {
      activeViolations.push({
        code: "COOLING_DOWN",
        message: "The 24-hour cooldown is active."
      });
    }
    if (
      status.liveTradeCount >= agentPolicy.risk.canaryTradeCount &&
      !pilotEligible
    ) {
      activeViolations.push({
        code: "PILOT_PROMOTION_PENDING",
        message:
          "Pilot promotion still requires positive net PnL, drawdown at most 5 pUSD and zero active incidents."
      });
    }
    return {
      phase: paused ? "PAUSED" : canary ? "CANARY" : "PILOT",
      policyVersion: agentPolicy.version,
      emergencyStopped: status.emergencyStopped,
      coolingDownUntil:
        coolingDownUntilMs === null
          ? null
          : new Date(coolingDownUntilMs).toISOString(),
      limits: {
        allocatedCapitalPusd: formatMicros(agentPolicy.risk.capitalMicros),
        maxOrderPusd: formatMicros(
          canary
            ? agentPolicy.risk.canaryMaxOrderMicros
            : agentPolicy.risk.pilotMaxOrderMicros
        ),
        maxMarketOrCorrelationPusd: formatMicros(
          agentPolicy.risk.maxMarketOrCorrelationMicros
        ),
        maxTotalExposurePusd: formatMicros(
          canary
            ? agentPolicy.risk.canaryMaxOpenExposureMicros
            : agentPolicy.risk.pilotMaxOpenExposureMicros
        ),
        maxOpenMarkets: agentPolicy.risk.maxOpenMarkets,
        dailyStopPusd: formatMicros(agentPolicy.risk.dailyStopMicros),
        canaryTradesRequired: agentPolicy.risk.canaryTradeCount
      },
      totalOpenExposurePusd: formatMicros(status.totalOpenExposureMicros),
      dailyPnlPusd: formatMicros(status.dailyPnlMicros),
      openMarketCount: status.openMarketCount,
      liveTradeCount: status.liveTradeCount,
      activeViolations,
      agentPolicy: {
        version: agentPolicy.version,
        decisionIntervalSeconds: agentPolicy.decisionIntervalMs / 1_000
      },
      serverVersion: SERVER_VERSION,
      buildId: BUILD_ID,
      portfolioAdoptionStatus: await this.getPortfolioAdoptionStatus(),
      marketChannel: this.marketChannelStatus(),
      supervisorMode: this.getSupervisorMode(),
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

  async prepareMarketEvidence(
    input: PrepareMarketEvidenceInput
  ): Promise<PrepareMarketEvidenceOutput> {
    this.requireProfile();
    if (
      input.executionMode === "live" &&
      (input.cycleId === undefined || input.candidateSnapshotId === undefined)
    ) {
      throw new PublicMcpToolError(
        "AGENT_CYCLE_BINDING_REQUIRED",
        "Live market evidence must bind a candidate returned by prepare_agent_cycle."
      );
    }
    this.touchAgentRun(
      input.agentRunId,
      "ANALYZING",
      input.cycleId ?? undefined
    );
    const boundSnapshot = this.requireAgentCycleSnapshot({
      agentRunId: input.agentRunId,
      conditionId: input.conditionId,
      tokenId: input.tokenId,
      ...(input.cycleId === undefined ? {} : { cycleId: input.cycleId }),
      ...(input.candidateSnapshotId === undefined
        ? {}
        : { candidateSnapshotId: input.candidateSnapshotId })
    });
    const snapshot = await (input.executionMode === "live"
      ? this.getAgentMarketSnapshot({
          conditionId: input.conditionId,
          tokenId: input.tokenId
        })
      : this.publicClient.getMarketSnapshot({
          conditionId: input.conditionId,
          tokenId: input.tokenId
        }));
    if (
      boundSnapshot !== null &&
      (boundSnapshot.snapshot.channelGeneration !== snapshot.channelGeneration ||
        hashMarketSnapshot(boundSnapshot.snapshot) !== hashMarketSnapshot(snapshot))
    ) {
      throw new PublicMcpToolError(
        "AGENT_CANDIDATE_CHANGED",
        "The candidate changed after its decision-cycle snapshot; prepare a new cycle."
      );
    }
    const nowMs = Date.now();
    this.database.saveMarketSnapshot(snapshot);
    if (nowMs - snapshot.capturedAtMs > 5_000) {
      throw new PublicMcpToolError(
        "SNAPSHOT_STALE",
        "The market snapshot is older than the five-second decision window."
      );
    }
    const orderBookPayload = {
      tokenId: snapshot.tokenId,
      conditionId: snapshot.conditionId,
      bestBidMicros: snapshot.bestBidMicros,
      bestAskMicros: snapshot.bestAskMicros,
      bids: snapshot.bids,
      asks: snapshot.asks,
      spreadMicros: snapshot.spreadMicros,
      capturedAtMs: snapshot.capturedAtMs
    };
    const marketMetadataPayload = {
      conditionId: snapshot.conditionId,
      eventId: snapshot.eventId,
      question: snapshot.question,
      rules: snapshot.rules,
      resolutionSource: snapshot.resolutionSource,
      category: snapshot.category,
      endTimeMs: snapshot.endTimeMs,
      active: snapshot.active,
      closed: snapshot.closed,
      acceptingOrders: snapshot.acceptingOrders,
      negRisk: snapshot.negRisk,
      tickSizeMicros: snapshot.tickSizeMicros,
      minOrderSizeMicros: snapshot.minOrderSizeMicros,
      capturedAtMs: snapshot.capturedAtMs
    };
    const marketSources = [
      {
        origin: "CLOB" as const,
        capturedAtMs: snapshot.capturedAtMs,
        snapshotHash: hashMarketSnapshot(snapshot),
        payloadHash: hashCanonical({ origin: "CLOB", payload: orderBookPayload })
      },
      {
        origin: "GAMMA" as const,
        capturedAtMs: snapshot.capturedAtMs,
        snapshotHash: hashMarketSnapshot(snapshot),
        payloadHash: hashCanonical({ origin: "GAMMA", payload: marketMetadataPayload })
      }
    ];
    const bundleWithoutHash = {
      id: `market_${hashCanonical({ input, snapshot, marketSources }).slice(0, 32)}`,
      marketConditionId: snapshot.conditionId,
      tokenId: snapshot.tokenId,
      estimatedProbabilityMicros: parseDecimalToMicros(input.estimatedProbability),
      eventVolatilityClass: input.eventVolatilityClass,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + 120_000,
      sources: [],
      rationale: input.rationale,
      counterRationale: input.counterRationale,
      evidenceKind: "MARKET_DATA" as const,
      marketSources,
      modelVersion: input.modelVersion,
      analysisHash: hashCanonical({
        agentRunId: input.agentRunId,
        modelVersion: input.modelVersion,
        rationale: input.rationale,
        counterRationale: input.counterRationale,
        snapshot,
        marketSources
      })
    };
    const bundle: ResearchBundle = {
      ...bundleWithoutHash,
      contentHash: hashCanonical(bundleWithoutHash)
    };
    this.database.saveResearchBundle(bundle);
    this.database.appendAudit("AGENT_ANALYSIS", input.agentRunId, {
      marketConditionId: bundle.marketConditionId,
      tokenId: bundle.tokenId,
      modelVersion: input.modelVersion,
      analysisHash: bundle.analysisHash,
      contentHash: bundle.contentHash,
      estimatedProbabilityMicros: bundle.estimatedProbabilityMicros,
      marketSourceOrigins: marketSources.map((source) => source.origin)
    });
    this.touchAgentRun(
      input.agentRunId,
      "HEARTBEAT",
      input.cycleId ?? undefined
    );
    return marketEvidenceOutput(bundle);
  }

  async prepareAgentEvidence(
    input: PrepareAgentEvidenceInput
  ): Promise<PrepareAgentEvidenceOutput> {
    if (
      input.executionMode === "live" &&
      (input.cycleId === undefined || input.candidateSnapshotId === undefined)
    ) {
      throw new PublicMcpToolError(
        "AGENT_CYCLE_BINDING_REQUIRED",
        "Live agent evidence must bind a candidate returned by prepare_agent_cycle."
      );
    }
    this.touchAgentRun(input.agentRunId, "ANALYZING", input.cycleId);
    const marketEvidence = await this.prepareMarketEvidence({
      agentRunId: input.agentRunId,
      conditionId: input.conditionId,
      tokenId: input.tokenId,
      estimatedProbability: input.estimatedProbability,
      eventVolatilityClass: input.eventVolatilityClass,
      modelVersion: input.modelVersion,
      rationale: input.rationale,
      counterRationale: input.counterRationale,
      executionMode: input.executionMode,
      ...(input.cycleId === undefined ? {} : { cycleId: input.cycleId }),
      ...(input.candidateSnapshotId === undefined
        ? {}
        : { candidateSnapshotId: input.candidateSnapshotId })
    });
    const marketBundle = this.database.getResearchBundle(marketEvidence.researchBundleId);
    if (marketBundle === null || marketBundle.marketSources === undefined) {
      throw new PublicMcpToolError("RESEARCH_BUNDLE_INVALID", "The market evidence bundle could not be reloaded.");
    }
    const marketSources = marketBundle.marketSources;
    const external = await this.researchVerifier.verify({
      marketConditionId: input.conditionId,
      tokenId: input.tokenId,
      estimatedProbabilityMicros: parseDecimalToMicros(input.estimatedProbability),
      eventVolatilityClass: input.eventVolatilityClass,
      requestedUrls: input.sourceUrls,
      sourceEvidence: input.sourceEvidence.map((evidence) => ({
        requestedUrl: evidence.requestedUrl,
        supportedClaims: evidence.supportedClaims,
        contradictedClaims: evidence.contradictedClaims,
        quotedFacts: evidence.quotedFacts,
        probabilityImpactMicros: parseDecimalToMicros(evidence.probabilityImpact.replace(/^-/, "")) *
          (evidence.probabilityImpact.startsWith("-") ? -1n : 1n)
      })),
      rationale: input.rationale,
      counterRationale: input.counterRationale
    });
    const nowMs = Date.now();
    const bundleWithoutHash = {
      id: `agent_${hashCanonical({ input, marketEvidence, external }).slice(0, 32)}`,
      marketConditionId: external.marketConditionId,
      tokenId: external.tokenId,
      estimatedProbabilityMicros: external.estimatedProbabilityMicros,
      eventVolatilityClass: external.eventVolatilityClass,
      createdAtMs: nowMs,
      expiresAtMs: Math.min(marketBundle.expiresAtMs, external.expiresAtMs, nowMs + 120_000),
      sources: external.sources,
      rationale: external.rationale,
      counterRationale: external.counterRationale,
      evidenceKind: "HYBRID" as const,
      marketSources,
      modelVersion: input.modelVersion,
      analysisHash: hashCanonical({
        agentRunId: input.agentRunId,
        modelVersion: input.modelVersion,
        marketEvidenceHash: marketBundle.contentHash,
        externalEvidenceHash: external.contentHash,
        rationale: input.rationale,
        counterRationale: input.counterRationale
      }),
      ...(input.executionMode === "live"
        ? {
            agentRunId: input.agentRunId,
            agentCycleId: input.cycleId!,
            candidateSnapshotId: input.candidateSnapshotId!
          }
        : {})
    };
    const bundle: ResearchBundle = {
      ...bundleWithoutHash,
      contentHash: hashCanonical(bundleWithoutHash)
    };
    this.database.saveResearchBundle(bundle);
    this.database.appendAudit("AGENT_ANALYSIS", input.agentRunId, {
      marketConditionId: bundle.marketConditionId,
      tokenId: bundle.tokenId,
      modelVersion: bundle.modelVersion,
      analysisHash: bundle.analysisHash,
      contentHash: bundle.contentHash,
      evidenceKind: bundle.evidenceKind,
      externalSourceDomains: bundle.sources.map((source) => source.registrableDomain),
      marketSourceOrigins: marketSources.map((source) => source.origin)
    });
    this.touchAgentRun(input.agentRunId, "HEARTBEAT", input.cycleId);
    return agentEvidenceOutput(bundle);
  }

  async getAgentPolicy(_input: GetAgentPolicyInput): Promise<GetAgentPolicyOutput> {
    return { policy: agentPolicyOutput(this.database.getAgentPolicy()), capturedAt: new Date().toISOString() };
  }

  async adjustAgentPolicy(input: AdjustAgentPolicyInput): Promise<AdjustAgentPolicyOutput> {
    this.touchAgentRun(input.agentRunId, "ANALYZING");
    const current = this.database.getAgentPolicy();
    const risk = await this.service.getRiskStatus();
    const next = applyAgentPolicyPatch(
      current,
      input as AgentPolicyPatch,
      (value) => parseDecimalToMicros(value),
      (value) => parseDecimalToMicros(value),
      Date.now(),
      risk.liveTradeCount
    );
    const increased = isRiskIncrease(current, next.risk, next.decisionIntervalMs);
    if (increased) {
      if (risk.liveTradeCount - current.reconciledTradeCountAtIncrease < 10) {
        throw new PublicMcpToolError("AGENT_POLICY_INCREASE_TOO_EARLY", "Ten new reconciled trades are required before increasing risk.");
      }
      if (current.lastIncreaseAtMs !== null && Date.now() - current.lastIncreaseAtMs < AGENT_POLICY_INCREASE_COOLDOWN_MS) {
        throw new PublicMcpToolError("AGENT_POLICY_INCREASE_COOLDOWN", "Risk increases require six hours between changes.");
      }
      if (
        risk.dailyPnlMicros <= 0n ||
        (risk.drawdownMicros ?? RISK_HARD_DAILY_STOP_PUSD) > 2_000_000n ||
        risk.emergencyStopped ||
        !risk.dailyPnlKnown
      ) {
        throw new PublicMcpToolError("AGENT_POLICY_INCREASE_PERFORMANCE_GATE", "Risk increases require known positive PnL, drawdown at most 2 pUSD and no active incident.");
      }
      for (const [before, after] of [
        [current.risk.canaryMaxOrderMicros, next.risk.canaryMaxOrderMicros],
        [current.risk.pilotMaxOrderMicros, next.risk.pilotMaxOrderMicros],
        [current.risk.canaryMaxOpenExposureMicros, next.risk.canaryMaxOpenExposureMicros],
        [current.risk.pilotMaxOpenExposureMicros, next.risk.pilotMaxOpenExposureMicros],
        [current.risk.maxMarketOrCorrelationMicros, next.risk.maxMarketOrCorrelationMicros]
      ] as Array<[bigint, bigint]>) {
        if (after > before && after > before + (before * 25n) / 100n) {
          throw new PublicMcpToolError("AGENT_POLICY_INCREASE_LIMIT", "Each risk increase is capped at 25 percent.");
        }
      }
      if (
        next.risk.maxOpenMarkets > current.risk.maxOpenMarkets &&
        next.risk.maxOpenMarkets > Math.floor(current.risk.maxOpenMarkets * 1.25)
      ) {
        throw new PublicMcpToolError("AGENT_POLICY_INCREASE_LIMIT", "Each risk increase is capped at 25 percent.");
      }
      if (
        next.risk.maxSpreadMicros > current.risk.maxSpreadMicros &&
        next.risk.maxSpreadMicros > current.risk.maxSpreadMicros + (current.risk.maxSpreadMicros * 25n) / 100n
      ) {
        throw new PublicMcpToolError("AGENT_POLICY_INCREASE_LIMIT", "Each risk increase is capped at 25 percent.");
      }
      if (
        next.risk.minEdgeMicros < current.risk.minEdgeMicros &&
        next.risk.minEdgeMicros < (current.risk.minEdgeMicros * 75n + 99n) / 100n
      ) {
        throw new PublicMcpToolError("AGENT_POLICY_INCREASE_LIMIT", "Each risk increase is capped at 25 percent.");
      }
      if (
        next.risk.depthMultiplier < current.risk.depthMultiplier &&
        next.risk.depthMultiplier < (current.risk.depthMultiplier * 75n + 99n) / 100n
      ) {
        throw new PublicMcpToolError("AGENT_POLICY_INCREASE_LIMIT", "Each risk increase is capped at 25 percent.");
      }
      if (
        next.decisionIntervalMs < current.decisionIntervalMs &&
        next.decisionIntervalMs < Math.ceil(current.decisionIntervalMs * 0.75)
      ) {
        throw new PublicMcpToolError("AGENT_POLICY_INCREASE_LIMIT", "Each risk increase is capped at 25 percent.");
      }
      if (current.lastLossAtMs !== null && Date.now() - current.lastLossAtMs < AGENT_POLICY_SAME_MARKET_LOSS_COOLDOWN_MS) {
        throw new PublicMcpToolError("AGENT_POLICY_SAME_MARKET_LOSS_COOLDOWN", "Risk increases are blocked for 24 hours after a same-market loss.");
      }
    }
    this.database.setAgentPolicy(next, Date.now());
    this.database.appendAudit("AGENT_POLICY_REASON", input.agentRunId, {
      rationale: input.rationale,
      riskIncrease: increased,
      liveTradeCount: risk.liveTradeCount,
      policyVersion: next.version
    });
    this.touchAgentRun(input.agentRunId, "HEARTBEAT");
    return { policy: agentPolicyOutput(next), capturedAt: new Date().toISOString() };
  }

  async startAgentRun(input: StartAgentRunInput): Promise<StartAgentRunOutput> {
    this.requireProfile();
    const account = await this.service.getAccountStatus();
    if (!this.config.liveEnabled || account.mode !== "live_ready") {
      throw new PublicMcpToolError(
        "LIVE_LOCKED",
        "An agent run requires an already authorized live session with every live gate open."
      );
    }
    if (this.database.getActiveTradingSession("live") === null) {
      throw new PublicMcpToolError("SESSION_INACTIVE", "Authorize a live trading session before starting the agent run.");
    }
    if (this.database.getEmergencyStop().active) {
      throw new PublicMcpToolError("EMERGENCY_STOPPED", "The persistent emergency lock is active.");
    }
    const adoptionStatus = await this.getPortfolioAdoptionStatus();
    if (adoptionStatus === "REQUIRED" || adoptionStatus === "CHANGED") {
      throw new PublicMcpToolError(
        "PORTFOLIO_ADOPTION_REQUIRED",
        "The reconciled portfolio must be adopted locally before an agent lease can start."
      );
    }
    if (adoptionStatus === "UNKNOWN") {
      throw new PublicMcpToolError(
        "PORTFOLIO_ADOPTION_UNAVAILABLE",
        "The current portfolio could not be verified for agent ownership."
      );
    }
    const run = this.database.startAgentRun({
      host: input.host,
      model: input.model,
      runtimeInstanceId: this.runtimeInstanceId
    });
    // A lease never inherits transport liveness or ephemeral snapshots from a
    // previous owner. The next prepared cycle must establish a fresh channel
    // generation before it can produce an executable snapshot.
    this.resetAgentMarketChannel();
    this.ownsAgentRun = true;
    this.scheduleAgentLeaseExpiry(run);
    if (
      this.config.paperGateSkip &&
      this.config.paperGateSkipSource === "dotenv"
    ) {
      this.database.appendAudit("PAPER_GATE_OVERRIDE_ACTIVE", run.agentRunId, {
        source: "dotenv",
        createdAtMs: Date.now()
      });
    }
    return agentRunOutput(run);
  }

  async heartbeatAgentRun(input: HeartbeatAgentRunInput): Promise<HeartbeatAgentRunOutput> {
    return agentRunOutput(
      this.touchAgentRun(input.agentRunId, "HEARTBEAT")
    );
  }

  async getAgentRun(_input: GetAgentRunInput): Promise<GetAgentRunOutput> {
    const run = this.database.getAgentRun();
    return {
      agentRun: run === null ? null : agentRunOutput(run),
      checkedAt: new Date().toISOString()
    };
  }

  async stopAgentRun(input: StopAgentRunInput): Promise<StopAgentRunOutput> {
    const run = this.database.stopAgentRun(input.agentRunId, input.reason, Date.now(), this.runtimeInstanceId);
    this.resetAgentMarketChannel();
    this.database.setLiveActivation(false);
    this.ownsAgentRun = false;
    this.clearAgentLeaseTimer();
    const emergency = await this.emergencyStop({
      confirmation: "CANCEL_ALL_AND_LOCK",
      reason: `AGENT_RUN_STOPPED:${input.reason}`
    });
    return { agentRun: agentRunOutput(run), emergencyStop: emergency };
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

  async authorizeTradingSession(
    pendingSessionId: string
  ): Promise<{ pendingSessionId: string; authorizedAmountPusd: string }> {
    this.requireProfile();
    if (this.keychain === null) {
      throw new Error("KEYCHAIN_UNAVAILABLE");
    }
    const pending = this.database.getPendingTradingSession(pendingSessionId);
    if (!pending) {
      throw new Error("Pending trading session is missing or expired.");
    }
    const attestation = await this.keychain.authorizeTradingSession({
      pendingSessionId: pending.id,
      executionMode: pending.executionMode,
      maximumAuthorizableMicros: pending.maximumAuthorizableMicros,
      expiresAtMs: pending.expiresAtMs
    });
    this.database.recordSessionAuthorization(attestation);
    return {
      pendingSessionId: pending.id,
      authorizedAmountPusd: formatMicros(attestation.amountMicros)
    };
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

  /**
   * Returns the current unexpired pending authorization for the requested
   * mode. The autonomous launcher uses this to resume an interrupted native
   * prompt without preparing a second budget or changing its limits.
   */
  async getPendingTradingSession(input: {
    executionMode: "live" | "paper";
  }): Promise<{ pendingSessionId: string; authorized: boolean } | null> {
    this.requireProfile();
    const pending = this.database.getPendingTradingSessionForMode(
      input.executionMode,
      Date.now()
    );
    if (pending === null) {
      return null;
    }
    const authorization = this.database.getSessionAuthorization(pending.id);
    return {
      pendingSessionId: pending.id,
      authorized:
        authorization !== null && authorization.consumedAtMs === null
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
    const agentRun = this.database.getAgentRun();
    const liveActivationBeforeLeaseCheck =
      this.database.getLiveActivation().active;
    if (
      expiredAgentRunRequiresRelock(
        agentRun,
        liveActivationBeforeLeaseCheck,
        this.database.getEmergencyStop()
      )
    ) {
      this.database.setLiveActivation(false);
      try {
        await this.service.emergencyStop("AGENT_RUN_EXPIRED");
      } catch {
        // The lease-expiry lock is already persistent; reconciliation retries below.
      }
    }
    const liveActivation = this.database.getLiveActivation().active;
    const reconciliationRequired = this.hasUnreconciledLiveExecution();
    const emergencyStopped = this.database.getEmergencyStop().active;
    if (
      shouldSkipSupervisorCycle({
        liveEnabled: this.config.liveEnabled,
        liveActivation,
        reconciliationRequired,
        emergencyStopped
      })
    ) {
      return emptySupervisorCycleResult();
    }
    const reconciliationActive =
      liveActivation || reconciliationRequired
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

  getSupervisorMode(includeHeartbeat = true): SupervisorMode {
    if (
      includeHeartbeat &&
      this.database.getSupervisorHeartbeat()?.status === "DEGRADED"
    ) {
      return "DEGRADED";
    }
    if (this.database.getEmergencyStop().active) {
      return this.hasUnreconciledLiveExecution()
        ? "LOCKED_RECONCILING"
        : "IDLE";
    }
    const agentRun = this.database.getAgentRun();
    if (agentRun?.status === "ACTIVE") return "AGENT_ACTIVE";
    if (this.database.getLiveActivation().active) return "ARMED";
    return "IDLE";
  }

  async failSafeSupervisor(): Promise<void> {
    const reason = "SUPERVISOR_CYCLE_FAILED";
    const alreadyLocked = this.database.getEmergencyStop().active;
    const shouldCancel =
      this.config.liveEnabled &&
      this.liveTrading !== null &&
      (this.database.getLiveActivation().active ||
        this.hasUnreconciledLiveExecution());
    this.database.setEmergencyStop(true, reason);
    this.database.setLiveActivation(false);
    if (!alreadyLocked && shouldCancel) {
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
    if (input.decisionOwner === "agent" && input.agentRunId !== undefined) {
      this.touchAgentRun(input.agentRunId, "STAGING");
      if (input.executionMode === "live") {
        await this.requireCurrentAgentPortfolioAdoption(input.agentRunId);
      }
    }
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
      ...(input.decisionOwner === undefined ? {} : { decisionOwner: input.decisionOwner }),
      ...(input.agentRunId === undefined ? {} : { agentRunId: input.agentRunId }),
      ...(input.modelVersion === undefined ? {} : { modelVersion: input.modelVersion }),
      ...(input.analysisHash === undefined ? {} : { analysisHash: input.analysisHash }),
      ...(input.researchBundleId === undefined
        ? {}
        : { researchBundleId: input.researchBundleId }),
      ...(input.exitReason === undefined
        ? {}
        : { exitReason: input.exitReason })
    });
    if (input.decisionOwner === "agent" && input.agentRunId !== undefined) {
      this.touchAgentRun(input.agentRunId, "HEARTBEAT");
    }
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
    const agentRunId = proposal.agentRunId;
    if (proposal.decisionOwner === "agent" && agentRunId != null) {
      this.touchAgentRun(agentRunId, "EXECUTING");
    }
    const result = await this.service.executeStagedProposal(
      input.proposalId,
      input.proposalHash
    );
    if (proposal.decisionOwner === "agent" && agentRunId != null) {
      this.touchAgentRun(agentRunId, "HEARTBEAT");
    }
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

  async close(options: { preserveLiveActivation?: boolean } = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    let cancellationAttempted = false;
    const activeAgentRun = this.database.getAgentRun();
    const closeDecision = runtimeCloseSafetyDecision(
      activeAgentRun,
      this.runtimeInstanceId,
      this.hasUnreconciledLiveExecution()
    );
    const ownsActiveAgentRun = closeDecision.ownsActiveAgentRun;
    if (ownsActiveAgentRun && activeAgentRun !== null) {
      this.database.stopAgentRun(
        activeAgentRun.agentRunId,
        "CONVERSATION_CLOSED",
        Date.now(),
        this.runtimeInstanceId
      );
      this.database.setEmergencyStop(true, "CONVERSATION_CLOSED");
      this.database.setLiveActivation(false);
      this.ownsAgentRun = false;
      if (this.config.liveEnabled) {
        try {
          await this.service.emergencyStop("CONVERSATION_CLOSED");
          cancellationAttempted = true;
        } catch {
          cancellationAttempted = true;
          // The persistent lock remains even if best-effort cancellation fails.
        }
      }
    }
    // Stop future gates and signing synchronously. The dashboard is then
    // drained so an already accepted callback cannot claim an execution after
    // the final ledger check.
    void options;
    this.clearAgentLeaseTimer();
    this.resetAgentMarketChannel();
    this.liveTrading?.beginShutdown();
    await this.dashboardServer.stop();

    if (
      closeDecision.failClosedForUnreconciledExecution &&
      !cancellationAttempted &&
      !ownsActiveAgentRun
    ) {
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

  private async getAgentMarketSnapshot(
    reference: MarketReference
  ): Promise<MarketSnapshot> {
    const currentTokens = this.marketChannelTokens.includes(reference.tokenId)
      ? this.marketChannelTokens
      : [reference.tokenId];
    const monitor = await this.ensureMarketChannel(currentTokens);
    const book = await monitor.getFreshBook(reference.tokenId);
    if (book === null) {
      throw new SafeExternalServiceError(
        "No fresh executable book was available for this market.",
        {
          code: "CLOB_BOOK_UNAVAILABLE",
          service: "clob",
          retryable: false
        }
      );
    }
    return this.publicClient.getMarketSnapshot({
      ...reference,
      realtimeBook: book
    });
  }

  private async ensureMarketChannel(
    tokenIds: string[]
  ): Promise<PolymarketMarketChannelMonitor> {
    const status = this.marketChannel?.status().state;
    if (
      this.marketChannel === null ||
      status === "failed" ||
      status === "stopped"
    ) {
      this.marketChannel?.stop();
      this.marketChannelGeneration += 1;
      this.marketChannel = new PolymarketMarketChannelMonitor({
        generation: this.marketChannelGeneration,
        onFailure: (error) => this.failActiveAgentRun(error.code)
      });
      this.marketChannelTokens = [];
    }
    await this.marketChannel.subscribe(tokenIds);
    this.marketChannelTokens = [...tokenIds];
    return this.marketChannel;
  }

  private touchAgentRun(
    agentRunId: string,
    phase: AgentRun["phase"],
    currentCycleId?: string
  ): AgentRun {
    const nowMs = Date.now();
    const currentRun = this.database.getAgentRun(nowMs);
    const owner =
      currentRun?.runtimeInstanceId ?? currentRun?.controllerId;
    if (
      currentRun?.agentRunId === agentRunId &&
      currentRun.status === "ACTIVE" &&
      owner === this.runtimeInstanceId &&
      this.database.getActiveTradingSession("live", nowMs) === null
    ) {
      this.database.stopAgentRun(
        agentRunId,
        "SESSION_EXPIRED",
        nowMs,
        this.runtimeInstanceId
      );
      this.database.setEmergencyStop(true, "SESSION_EXPIRED", nowMs);
      this.database.setLiveActivation(false, nowMs);
      this.ownsAgentRun = false;
      this.clearAgentLeaseTimer();
      void this.service
        .emergencyStop("SESSION_EXPIRED")
        .catch(() => undefined);
      throw new PublicMcpToolError(
        "SESSION_EXPIRED",
        "The authorized live session expired; the agent run was stopped and locked."
      );
    }
    try {
      const run = this.database.touchAgentRun({
        agentRunId,
        runtimeInstanceId: this.runtimeInstanceId,
        phase,
        ...(currentCycleId === undefined ? {} : { currentCycleId }),
        nowMs
      });
      this.scheduleAgentLeaseExpiry(run);
      return run;
    } catch {
      throw new PublicMcpToolError(
        "AGENT_RUN_NOT_ACTIVE",
        "The agent lease is missing, expired, or belongs to another runtime instance."
      );
    }
  }

  private requireAgentCycleSnapshot(input: {
    agentRunId: string;
    conditionId: string;
    tokenId: string;
    cycleId?: string;
    candidateSnapshotId?: string;
  }): AgentCycleSnapshotRecord | null {
    if (input.cycleId === undefined && input.candidateSnapshotId === undefined) {
      return null;
    }
    if (input.cycleId === undefined || input.candidateSnapshotId === undefined) {
      throw new PublicMcpToolError(
        "AGENT_CYCLE_BINDING_INVALID",
        "The decision-cycle binding is incomplete."
      );
    }
    const record = this.agentCycleSnapshots.get(input.candidateSnapshotId);
    if (
      record === undefined ||
      record.agentRunId !== input.agentRunId ||
      record.cycleId !== input.cycleId ||
      record.snapshot.conditionId.toLowerCase() !== input.conditionId.toLowerCase() ||
      record.snapshot.tokenId !== input.tokenId ||
      record.expiresAtMs <= Date.now()
    ) {
      throw new PublicMcpToolError(
        "AGENT_CANDIDATE_SNAPSHOT_INVALID",
        "The bound candidate snapshot is missing, stale, or belongs to another cycle."
      );
    }
    return record;
  }

  private pruneAgentCycleSnapshots(nowMs: number): void {
    for (const [id, record] of this.agentCycleSnapshots) {
      if (record.expiresAtMs <= nowMs) this.agentCycleSnapshots.delete(id);
    }
  }

  private async failActiveAgentRun(reason: string): Promise<void> {
    const run = this.database.getAgentRun();
    const owner = run?.runtimeInstanceId ?? run?.controllerId;
    if (
      run?.status !== "ACTIVE" ||
      owner !== this.runtimeInstanceId
    ) {
      return;
    }
    try {
      this.database.stopAgentRun(
        run.agentRunId,
        reason,
        Date.now(),
        this.runtimeInstanceId
      );
    } catch {
      // The persistent lock below remains authoritative.
    }
    this.database.setEmergencyStop(true, reason);
    this.database.setLiveActivation(false);
    this.resetAgentMarketChannel();
    this.ownsAgentRun = false;
    this.clearAgentLeaseTimer();
    try {
      await this.service.emergencyStop(reason);
    } catch {
      // Cancellation is best effort; reconciliation remains mandatory.
    }
  }

  private scheduleAgentLeaseExpiry(run: AgentRun): void {
    const owner = run.runtimeInstanceId ?? run.controllerId;
    if (
      run.status !== "ACTIVE" ||
      owner !== this.runtimeInstanceId ||
      this.closed
    ) {
      return;
    }
    this.clearAgentLeaseTimer();
    const delayMs = Math.max(1, run.leaseExpiresAtMs - Date.now() + 1);
    this.agentLeaseTimer = setTimeout(() => {
      this.agentLeaseTimer = null;
      void this.handleAgentLeaseExpiry(run.agentRunId);
    }, delayMs);
    this.agentLeaseTimer.unref();
  }

  private clearAgentLeaseTimer(): void {
    if (this.agentLeaseTimer === null) return;
    clearTimeout(this.agentLeaseTimer);
    this.agentLeaseTimer = null;
  }

  private async handleAgentLeaseExpiry(agentRunId: string): Promise<void> {
    if (this.closed) return;
    const run = this.database.getAgentRun(Date.now());
    const owner = run?.runtimeInstanceId ?? run?.controllerId;
    if (
      run?.agentRunId !== agentRunId ||
      run.status === "ACTIVE" ||
      owner !== this.runtimeInstanceId
    ) {
      return;
    }
    this.database.setLiveActivation(false);
    this.resetAgentMarketChannel();
    this.ownsAgentRun = false;
    try {
      await this.service.emergencyStop("AGENT_RUN_EXPIRED");
    } catch {
      // The persistent expiry lock remains authoritative; reconciliation will retry.
    }
  }

  private resetAgentMarketChannel(): void {
    this.marketChannel?.stop();
    this.marketChannel = null;
    this.marketChannelTokens = [];
    this.agentCycleSnapshots.clear();
  }

  private marketChannelStatus(): GetAccountStatusOutput["marketChannel"] {
    const status = this.marketChannel?.status();
    return status === undefined
      ? {
          state: "idle",
          generation: this.marketChannelGeneration,
          subscribedTokenCount: 0,
          freshBookCount: 0
        }
      : {
          state: status.state,
          generation: status.generation,
          subscribedTokenCount: status.subscribedTokenCount,
          freshBookCount: status.freshBookCount
        };
  }

  private async getPortfolioAdoptionStatus(): Promise<
    GetAccountStatusOutput["portfolioAdoptionStatus"]
  > {
    try {
      const portfolio = await this.publicClient.getPortfolio(
        this.config.profileAddress
      );
      if (!portfolio.positions.some((position) => position.sizeMicros > 0n)) {
        return "NOT_REQUIRED";
      }
      const adoption = this.database.getLivePortfolioAdoption();
      if (
        isPortfolioAdoptionCurrent(
          adoption,
          this.config.profileAddress,
          zonedDayKey(Date.now(), "Europe/Madrid"),
          portfolio
        )
      ) {
        return "CURRENT";
      }
      return adoption === null ? "REQUIRED" : "CHANGED";
    } catch {
      return "UNKNOWN";
    }
  }

  private async requireCurrentAgentPortfolioAdoption(
    agentRunId: string
  ): Promise<void> {
    const portfolio = await this.publicClient.getPortfolio(
      this.config.profileAddress
    );
    if (!portfolio.positions.some((position) => position.sizeMicros > 0n)) {
      return;
    }
    if (
      isPortfolioAdoptionCurrent(
        this.database.getLivePortfolioAdoption(),
        this.config.profileAddress,
        zonedDayKey(Date.now(), "Europe/Madrid"),
        portfolio
      )
    ) {
      return;
    }
    await this.failActiveAgentRun("PORTFOLIO_ADOPTION_CHANGED");
    throw new PublicMcpToolError(
      "PORTFOLIO_ADOPTION_CHANGED",
      `The reconciled portfolio no longer matches its daily adoption. Stop and review locally before running \`npm run onboard -- adopt-existing-portfolio --confirm ADOPT_EXISTING_PORTFOLIO\`.`
    );
  }

  private async paperGateOutput(): Promise<
    GetAccountStatusOutput["paperGate"]
  > {
    const overrideActive = this.config.paperGateSkip && this.config.paperGateSkipSource === "dotenv";
    const [metrics, result] = await Promise.all([
      this.paperGate.metrics(),
      this.paperGate.result(overrideActive)
    ]);
    return {
      passed: result.passed,
      skipped: result.skipped === true || overrideActive,
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
      skipSource: this.config.paperGateSkipSource,
      reasons: this.config.paperGateSkip && !overrideActive
        ? [...result.reasons, "PAPER_GATE_SKIP_NOT_DOTENV"]
        : result.reasons
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
    prepareMarketEvidence: (input) =>
      guarded(() => runtime.prepareMarketEvidence(input)),
    prepareAgentEvidence: (input) =>
      guarded(() => runtime.prepareAgentEvidence(input)),
    prepareAgentCycle: (input) =>
      guarded(() => runtime.prepareAgentCycle(input)),
    getAgentPolicy: (input) => guarded(() => runtime.getAgentPolicy(input)),
    adjustAgentPolicy: (input) => guarded(() => runtime.adjustAgentPolicy(input)),
    startAgentRun: (input) => guarded(() => runtime.startAgentRun(input)),
    heartbeatAgentRun: (input) => guarded(() => runtime.heartbeatAgentRun(input)),
    getAgentRun: (input) => guarded(() => runtime.getAgentRun(input)),
    stopAgentRun: (input) => guarded(() => runtime.stopAgentRun(input)),
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

function portfolioOutput(
  portfolio: PortfolioSnapshot,
  grandfatheredKeys: ReadonlySet<string> = new Set()
): GetPortfolioOutput {
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
      endTime: new Date(position.endTimeMs).toISOString(),
      managementPolicy: grandfatheredKeys.has(
        `${position.conditionId.toLowerCase()}:${position.tokenId}`
      )
        ? "GRANDFATHERED_REDUCE_ONLY"
        : "AGENT_MANAGED"
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
    capturedAt: new Date(market.capturedAtMs).toISOString(),
    ...(market.sourceTimestampMs === undefined
      ? {}
      : { sourceTimestamp: new Date(market.sourceTimestampMs).toISOString() }),
    ...(market.receivedAtMs === undefined
      ? {}
      : { receivedAt: new Date(market.receivedAtMs).toISOString() }),
    ...(market.channelGeneration === undefined
      ? {}
      : { channelGeneration: market.channelGeneration }),
    ...(market.bookHash === undefined ? {} : { bookHash: market.bookHash }),
    ...(market.marketDataSource === undefined
      ? {}
      : { marketDataSource: market.marketDataSource })
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
    ...(proposal.decisionOwner === undefined ? {} : { decisionOwner: proposal.decisionOwner }),
    ...(proposal.agentRunId === undefined ? {} : { agentRunId: proposal.agentRunId }),
    ...(proposal.modelVersion === undefined ? {} : { modelVersion: proposal.modelVersion }),
    ...(proposal.analysisHash === undefined ? {} : { analysisHash: proposal.analysisHash }),
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

function marketEvidenceOutput(bundle: ResearchBundle): PrepareMarketEvidenceOutput {
  if (bundle.evidenceKind !== "MARKET_DATA" || bundle.marketSources === undefined || bundle.analysisHash === undefined || bundle.modelVersion === undefined) {
    throw new Error("MARKET_EVIDENCE_OUTPUT_INVALID");
  }
  return {
    researchBundleId: bundle.id,
    conditionId: bundle.marketConditionId,
    tokenId: bundle.tokenId,
    estimatedProbability: formatMicros(bundle.estimatedProbabilityMicros),
    eventVolatilityClass: bundle.eventVolatilityClass,
    evidenceKind: "MARKET_DATA",
    modelVersion: bundle.modelVersion,
    createdAt: new Date(bundle.createdAtMs).toISOString(),
    expiresAt: new Date(bundle.expiresAtMs).toISOString(),
    marketSources: bundle.marketSources.map((source) => ({
      origin: source.origin,
      capturedAt: new Date(source.capturedAtMs).toISOString(),
      snapshotHash: source.snapshotHash,
      payloadHash: source.payloadHash
    })),
    rationale: bundle.rationale,
    counterRationale: bundle.counterRationale,
    contentHash: bundle.contentHash,
    analysisHash: bundle.analysisHash
  };
}

function agentEvidenceOutput(bundle: ResearchBundle): PrepareAgentEvidenceOutput {
  if (bundle.evidenceKind !== "HYBRID" || bundle.marketSources === undefined || bundle.analysisHash === undefined || bundle.modelVersion === undefined) {
    throw new Error("AGENT_EVIDENCE_OUTPUT_INVALID");
  }
  return {
    researchBundleId: bundle.id,
    conditionId: bundle.marketConditionId,
    tokenId: bundle.tokenId,
    estimatedProbability: formatMicros(bundle.estimatedProbabilityMicros),
    eventVolatilityClass: bundle.eventVolatilityClass,
    evidenceKind: "HYBRID",
    modelVersion: bundle.modelVersion,
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
      contentType: source.contentType as "text/html" | "text/plain" | "application/xhtml+xml",
      excerptHash: source.excerptHash,
      responseBodyHash: source.responseBodyHash,
      supportedClaims: source.supportedClaims,
      contradictedClaims: source.contradictedClaims,
      quotedFactHashes: source.quotedFactHashes,
      probabilityImpact: formatMicros(source.probabilityImpactMicros)
    })),
    marketSources: bundle.marketSources.map((source) => ({
      origin: source.origin,
      capturedAt: new Date(source.capturedAtMs).toISOString(),
      snapshotHash: source.snapshotHash,
      payloadHash: source.payloadHash
    })),
    rationale: bundle.rationale,
    counterRationale: bundle.counterRationale,
    contentHash: bundle.contentHash,
    analysisHash: bundle.analysisHash
  };
}

function agentPolicyOutput(policy: ReturnType<TradingDatabase["getAgentPolicy"]>) {
  return {
    version: policy.version,
    canaryMaxOrderPusd: formatMicros(policy.risk.canaryMaxOrderMicros),
    pilotMaxOrderPusd: formatMicros(policy.risk.pilotMaxOrderMicros),
    canaryMaxOpenExposurePusd: formatMicros(policy.risk.canaryMaxOpenExposureMicros),
    pilotMaxOpenExposurePusd: formatMicros(policy.risk.pilotMaxOpenExposureMicros),
    maxMarketOrCorrelationPusd: formatMicros(policy.risk.maxMarketOrCorrelationMicros),
    maxOpenMarkets: policy.risk.maxOpenMarkets,
    minEdge: formatMicros(policy.risk.minEdgeMicros),
    maxSpread: formatMicros(policy.risk.maxSpreadMicros),
    depthMultiplier: Number(policy.risk.depthMultiplier),
    decisionIntervalSeconds: policy.decisionIntervalMs / 1_000,
    lastIncreaseAt: policy.lastIncreaseAtMs === null ? null : new Date(policy.lastIncreaseAtMs).toISOString(),
    reconciledTradeCountAtIncrease: policy.reconciledTradeCountAtIncrease,
    lastLossMarketConditionId: policy.lastLossMarketConditionId,
    lastLossAt: policy.lastLossAtMs === null ? null : new Date(policy.lastLossAtMs).toISOString()
  };
}

function agentRunOutput(run: AgentRun) {
  const phase = run.phase ?? (run.status === "ACTIVE" ? "HEARTBEAT" : "STOPPING");
  return {
    agentRunId: run.agentRunId,
    host: run.host,
    model: run.model,
    status: run.status,
    startedAt: new Date(run.startedAtMs).toISOString(),
    lastHeartbeatAt: new Date(run.lastHeartbeatAtMs).toISOString(),
    leaseExpiresAt: new Date(run.leaseExpiresAtMs).toISOString(),
    stoppedAt: run.stoppedAtMs === null ? null : new Date(run.stoppedAtMs).toISOString(),
    stopReason: run.stopReason,
    policyVersion: run.policyVersion ?? RISK_POLICY_VERSION,
    phase,
    nextCycleAt: run.nextCycleAtMs === null || run.nextCycleAtMs === undefined
      ? null
      : new Date(run.nextCycleAtMs).toISOString(),
    currentCycleId: run.currentCycleId ?? null,
    ...(run.runtimeInstanceId === undefined && run.controllerId === undefined
      ? {}
      : { runtimeInstanceId: run.runtimeInstanceId ?? run.controllerId! }),
    ...(run.lastToolActivityAtMs === undefined
      ? {}
      : {
          lastToolActivityAt: new Date(
            run.lastToolActivityAtMs
          ).toISOString()
        }),
    ...(run.controllerId === undefined ? {} : { controllerId: run.controllerId })
  };
}

function emptySupervisorCycleResult(): SupervisorCycleResult {
  return {
    evaluatedPositionsCount: 0,
    actions: [],
    evaluatedAt: new Date().toISOString(),
    reconciliationActive: false,
    priorityReevaluation: false,
    entryEvaluatedCandidatesCount: 0,
    entryStagedCount: 0,
    entryExecutedCount: 0,
    entrySkippedCount: 0
  };
}

export function runtimeCloseSafetyDecision(
  run: AgentRun | null,
  runtimeInstanceId: string,
  hasUnreconciledExecution: boolean
): {
  ownsActiveAgentRun: boolean;
  failClosedForUnreconciledExecution: boolean;
} {
  const owner = run?.runtimeInstanceId ?? run?.controllerId;
  const ownsActiveAgentRun =
    run?.status === "ACTIVE" && owner === runtimeInstanceId;
  const anotherRuntimeOwnsActiveRun =
    run?.status === "ACTIVE" && !ownsActiveAgentRun;
  return {
    ownsActiveAgentRun,
    failClosedForUnreconciledExecution:
      hasUnreconciledExecution && !anotherRuntimeOwnsActiveRun
  };
}

export function expiredAgentRunRequiresRelock(
  run: AgentRun | null,
  liveActivationActive: boolean,
  emergencyStop: {
    active: boolean;
    reason: string;
    updatedAtMs: number;
  }
): boolean {
  if (
    !liveActivationActive ||
    run?.status !== "EXPIRED" ||
    run.stopReason !== "AGENT_LEASE_EXPIRED"
  ) {
    return false;
  }
  const expiredAtMs = run.stoppedAtMs ?? run.leaseExpiresAtMs;
  const manuallyReviewedAfterExpiry =
    !emergencyStop.active &&
    emergencyStop.reason === "MANUAL_LOCAL_REVIEW" &&
    emergencyStop.updatedAtMs >= expiredAtMs;
  return !manuallyReviewedAfterExpiry;
}

function safeRuntimeErrorCode(error: unknown): string {
  const candidate =
    error instanceof SafeExternalServiceError
      ? error.code
      : error instanceof Error
        ? error.message.split(/[:\s]/u, 1)[0] ?? ""
        : "";
  return /^[A-Z][A-Z0-9_]{2,80}$/u.test(candidate)
    ? candidate
    : "MARKET_CHANNEL_FAILURE";
}

function isGlobalMarketChannelContradiction(error: unknown): boolean {
  const code = safeRuntimeErrorCode(error);
  return (
    code.startsWith("MARKET_CHANNEL_") ||
    code === "CLOB_BOOK_CROSSCHECK_MISMATCH" ||
    code === "CLOB_BOOK_TICK_MISMATCH" ||
    code === "CLOB_MARKET_CHANNEL_BOOK_INVALID"
  );
}

export function classifyAgentCycleMarketError(
  error: unknown
): "FAIL_RUN" | "SKIP_BOOK" | "SKIP_MARKET" {
  const code = safeRuntimeErrorCode(error);
  if (code === "CLOB_MARKET_CHANNEL_BOOK_STALE") {
    return "SKIP_BOOK";
  }
  return isGlobalMarketChannelContradiction(error)
    ? "FAIL_RUN"
    : "SKIP_MARKET";
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
