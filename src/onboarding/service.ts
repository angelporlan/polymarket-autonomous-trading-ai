import {
  AssetType,
  Chain,
  ClobClient,
  SignatureTypeV2,
  type ApiKeyCreds,
  type ClobClientOptions,
  type OpenOrder
} from "@polymarket/clob-client-v2";
import { bytesToHex, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../config.js";
import {
  zonedDayKey,
  zonedDayStartMs
} from "../application/risk-context.js";
import { hashCanonical, verifyProposalHash } from "../domain/proposals.js";
import {
  DEFAULT_RISK_POLICY,
  RISK_HARD_CEILING_TOTAL_EXPOSURE_PUSD
} from "../domain/risk-policy.js";
import {
  canonicalCorrelationKey,
  type ExecutionRecord,
  type OrderProposal,
  type PortfolioPosition,
  type PortfolioSnapshot
} from "../domain/types.js";
import { PolymarketPublicClient } from "../polymarket/public-client.js";
import {
  normalizeClobOrderStatus,
  parseClobFixed6,
  parseClobPrice
} from "../polymarket/reconciliation.js";
import {
  L2_CREDENTIALS_ACCOUNT,
  SOCIAL_PRIVATE_KEY_ACCOUNT,
  type MacOSKeychain
} from "../security/keychain.js";
import { RestrictedKeychainSigner } from "../security/restricted-signer.js";
import type {
  AccountBindingRecord,
  TradingDatabase
} from "../storage/database.js";

const RELAYER_HOST = "https://relayer-v2.polymarket.com";
const REQUEST_TIMEOUT_MS = 8_000;
const CREDENTIAL_SETUP_TIMEOUT_MS = 90_000;
const MAX_CREDENTIAL_RECORD_BYTES = 16_384;
const DAILY_SESSION_TIME_ZONE = "Europe/Madrid";
export const ADOPT_EXISTING_PORTFOLIO_CONFIRMATION =
  "ADOPT_EXISTING_PORTFOLIO";
const OPEN_EXECUTION_STATUSES = new Set([
  "DELAYED",
  "FILLED",
  "LIVE",
  "MATCHED",
  "OPEN",
  "PARTIAL",
  "PARTIALLY_FILLED",
  "SUBMITTED",
  "UNMATCHED"
]);
const TERMINAL_EXECUTION_STATUSES = new Set([
  "CANCELLED",
  "CANCELED",
  "CLOSED",
  "CONFIRMED",
  "EXPIRED",
  "FAILED",
  "REJECTED"
]);
interface TerminalExecutionEvidence {
  execution: ExecutionRecord;
  proposal: OrderProposal;
}

export interface OnboardingServiceDependencies {
  clobClientFactory?: (options: ClobClientOptions) => ClobClient;
  publicClientFactory?: () => Pick<
    PolymarketPublicClient,
    "getPortfolio" | "getUserActivity"
  >;
}

export interface OnboardingStatus {
  profileAddress: string;
  socialKeyPresent: boolean;
  l2CredentialsPresent: boolean;
  binding: ReturnType<TradingDatabase["getAccountBinding"]>;
  liveEnvironmentEnabled: boolean;
  paperGateSkip: boolean;
  localLiveActivation: boolean;
  emergencyStopped: boolean;
  auditChainValid: boolean;
}

export interface ConfigureAccountResult {
  signerAddress: string;
  funderAddress: string;
  signatureType: 1 | 3;
}

export class OnboardingService {
  constructor(
    private readonly config: AppConfig,
    private readonly database: TradingDatabase,
    private readonly keychain: MacOSKeychain,
    private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly dependencies: OnboardingServiceDependencies = {}
  ) {}

  async status(): Promise<OnboardingStatus> {
    const [social, l2] = await Promise.all([
      this.keychain.status(SOCIAL_PRIVATE_KEY_ACCOUNT),
      this.keychain.status(L2_CREDENTIALS_ACCOUNT)
    ]);
    return {
      profileAddress: this.config.profileAddress,
      socialKeyPresent: social.exists,
      l2CredentialsPresent: l2.exists,
      binding: this.database.getAccountBinding(),
      liveEnvironmentEnabled: this.config.liveEnabled,
      paperGateSkip: this.config.paperGateSkip,
      localLiveActivation: this.database.getLiveActivation().active,
      emergencyStopped: this.database.getEmergencyStop().active,
      auditChainValid: this.database.verifyAuditChain()
    };
  }

  async importSocialKey(): Promise<void> {
    await this.keychain.importSocialPrivateKeyInteractive();
    this.database.appendAudit("SOCIAL_KEY_IMPORTED_TO_KEYCHAIN", null, {
      importedAtMs: Date.now()
    });
  }

  async configureAccount(
    confirmLegacyProxy: boolean
  ): Promise<ConfigureAccountResult> {
    this.assertProfileConfigured();
    const signerAddress = await this.deriveLocalSignerAddress();
    await this.assertPublicProfileLink(this.config.profileAddress, signerAddress);
    const signatureType = await this.detectSignatureType(
      this.config.profileAddress,
      signerAddress,
      confirmLegacyProxy
    );
    const l2Status = await this.keychain.status(L2_CREDENTIALS_ACCOUNT);
    const creds = l2Status.exists
      ? await this.readStoredL2Credentials(
          "Verify existing Polymarket L2 credentials during account setup"
        )
      : await this.deriveAndVerifyCredentials(
          signerAddress,
          this.config.profileAddress,
          signatureType
        );
    if (l2Status.exists) {
      await this.verifyL2Credentials(
        creds,
        signerAddress,
        this.config.profileAddress,
        signatureType
      );
    }

    const verifiedAtMs = Date.now();
    this.database.setAccountBinding({
      signerAddress,
      funderAddress: this.config.profileAddress,
      profileAddress: this.config.profileAddress,
      signatureType,
      verifiedAtMs
    });
    if (!l2Status.exists) {
      const encoded = Buffer.from(JSON.stringify(creds), "utf8");
      try {
        await this.keychain.storeL2Credentials(encoded);
      } finally {
        encoded.fill(0);
      }
    }
    return {
      signerAddress,
      funderAddress: this.config.profileAddress,
      signatureType
    };
  }

  async activateLive(confirmPhrase: string, paperGatePassed: boolean): Promise<void> {
    if (confirmPhrase !== "ACTIVATE_LIVE") {
      throw new Error("Exact ACTIVATE_LIVE confirmation is required.");
    }
    if (!this.config.liveEnabled) {
      throw new Error("POLYMARKET_LIVE_ENABLED is false.");
    }
    if (!paperGatePassed) {
      throw new Error("The paper gate has not passed.");
    }
    if (!this.database.verifyAuditChain()) {
      throw new Error("The audit chain is invalid.");
    }
    if (this.database.getEmergencyStop().active) {
      throw new Error("The emergency stop is active.");
    }
    if (this.database.getCooldown().untilMs > Date.now()) {
      throw new Error("The 24-hour loss cooldown is still active.");
    }
    const binding = this.requireCurrentBinding();
    const creds = await this.readStoredL2Credentials(
      "Confirm local activation of live Polymarket trading"
    );
    const closedOnly = await runBoundedAuthenticatedRequest(
      this.createReadOnlyClient(creds, binding).getClosedOnlyMode(),
      "Authenticated live activation state check failed."
    );
    assertAccountCanOpenOrders(closedOnly);

    const nowMs = Date.now();
    const dayKey = zonedDayKey(nowMs, DAILY_SESSION_TIME_ZONE);
    const existingDailyRisk = this.database.getDailyRiskPnl(dayKey, 0n);
    const publicClient = this.createPublicClient();
    const portfolio = await publicClient.getPortfolio(this.config.profileAddress);
    if (portfolio.totalPnlMicros <= -DEFAULT_RISK_POLICY.dailyStopMicros) {
      throw new Error(
        "The isolated wallet already exceeds the conservative loss threshold."
      );
    }
    if (portfolioExposureMicros(portfolio) > RISK_HARD_CEILING_TOTAL_EXPOSURE_PUSD) {
      throw new Error(
        "The existing portfolio exceeds the fixed total-exposure ceiling."
      );
    }
    const hasOpenPositions = portfolio.positions.some((position) => {
      if (position.sizeMicros < 0n) {
        throw new Error("The portfolio contains an invalid open position.");
      }
      return position.sizeMicros > 0n;
    });
    const adoption = this.database.getLivePortfolioAdoption();
    const adoptedExistingPortfolio = isPortfolioAdoptionCurrent(
      adoption,
      this.config.profileAddress,
      dayKey,
      portfolio
    );
    if (!existingDailyRisk.known) {
      if (hasOpenPositions && !adoptedExistingPortfolio) {
        throw new Error(
          "A new daily risk session requires zero open positions."
        );
      }
      const activity = await publicClient.getUserActivity(
        this.config.profileAddress,
        zonedDayStartMs(nowMs, DAILY_SESSION_TIME_ZONE)
      );
      if (!Array.isArray(activity)) {
        throw new Error("The daily trade-activity response was malformed.");
      }
      if (activity.length !== 0) {
        throw new Error(
          "A new daily risk session requires zero TRADE activity since midnight Europe/Madrid."
        );
      }
      this.database.armDailyRiskSession(
        dayKey,
        portfolio.totalPnlMicros,
        nowMs
      );
    }
    assertOpenPositionsHaveLocalProvenance(
      this.database,
      portfolio.positions,
      adoptedExistingPortfolio
    );
    const dailyRisk = this.database.getDailyRiskPnl(
      dayKey,
      portfolio.totalPnlMicros
    );
    if (
      !dailyRisk.known ||
      dailyRisk.pnlMicros <= -DEFAULT_RISK_POLICY.dailyStopMicros
    ) {
      throw new Error(
        "The preserved daily risk session is unavailable or already stopped."
      );
    }
    this.database.setLiveActivation(true, nowMs);
  }

  async adoptExistingPortfolio(
    confirmPhrase: string,
    paperGatePassed: boolean
  ): Promise<void> {
    if (confirmPhrase !== ADOPT_EXISTING_PORTFOLIO_CONFIRMATION) {
      throw new Error(
        `Exact ${ADOPT_EXISTING_PORTFOLIO_CONFIRMATION} confirmation is required.`
      );
    }
    if (!this.config.liveEnabled) {
      throw new Error("POLYMARKET_LIVE_ENABLED is false.");
    }
    if (!paperGatePassed) {
      throw new Error("The paper gate has not passed.");
    }
    if (!this.database.verifyAuditChain()) {
      throw new Error("The audit chain is invalid.");
    }
    if (this.database.getEmergencyStop().active) {
      throw new Error("The emergency stop is active.");
    }
    if (this.database.getCooldown().untilMs > Date.now()) {
      throw new Error("The 24-hour loss cooldown is still active.");
    }

    const nowMs = Date.now();
    const dayKey = zonedDayKey(nowMs, DAILY_SESSION_TIME_ZONE);
    if (this.database.getDailyRiskPnl(dayKey, 0n).known) {
      throw new Error("The daily risk session is already armed.");
    }
    const portfolio = await this.createPublicClient().getPortfolio(
      this.config.profileAddress
    );
    if (portfolio.positions.some((position) => position.sizeMicros < 0n)) {
      throw new Error("The portfolio contains an invalid open position.");
    }
    const openPositions = portfolio.positions.filter(
      (position) => position.sizeMicros > 0n
    );
    if (openPositions.length === 0) {
      throw new Error("No open positions are available for adoption.");
    }
    if (portfolio.totalPnlMicros <= -DEFAULT_RISK_POLICY.dailyStopMicros) {
      throw new Error(
        "The isolated wallet already exceeds the conservative loss threshold."
      );
    }
    if (portfolioExposureMicros(portfolio) > RISK_HARD_CEILING_TOTAL_EXPOSURE_PUSD) {
      throw new Error(
        "The existing portfolio exceeds the fixed total-exposure ceiling."
      );
    }
    const activity = await this.createPublicClient().getUserActivity(
      this.config.profileAddress,
      zonedDayStartMs(nowMs, DAILY_SESSION_TIME_ZONE)
    );
    if (!Array.isArray(activity)) {
      throw new Error("The daily trade-activity response was malformed.");
    }
    if (activity.length !== 0) {
      throw new Error(
        "Portfolio adoption requires zero TRADE activity since midnight Europe/Madrid."
      );
    }

    const binding = this.requireCurrentBinding();
    const creds = await this.readStoredL2Credentials(
      "Confirm adoption of the existing Polymarket portfolio"
    );
    const closedOnly = await runBoundedAuthenticatedRequest(
      this.createReadOnlyClient(creds, binding).getClosedOnlyMode(),
      "Authenticated portfolio adoption state check failed."
    );
    assertAccountCanOpenOrders(closedOnly);

    this.database.setLivePortfolioAdoption({
      profileAddress: this.config.profileAddress,
      dayKey,
      adoptedAtMs: nowMs,
      portfolioHash: portfolioIdentityHash(portfolio),
      positionKeys: openPositions.map(positionIdentity).sort()
    }, nowMs);
  }

  deactivateLive(): void {
    this.database.setLiveActivation(false);
  }

  async clearEmergencyStop(confirmPhrase: string): Promise<void> {
    if (confirmPhrase !== "CLEAR_EMERGENCY") {
      throw new Error("Exact CLEAR_EMERGENCY confirmation is required.");
    }
    if (!this.database.getEmergencyStop().active) {
      throw new Error("The emergency stop is not active.");
    }
    if (!this.database.verifyAuditChain()) {
      throw new Error("The audit chain is invalid.");
    }
    const binding = this.requireCurrentBinding();
    const terminalExecutions =
      assertNoOutstandingLocalExecutions(this.database);

    const creds = await this.readStoredL2Credentials(
      "Confirm review and reset of the Polymarket emergency lock"
    );
    const client = this.createReadOnlyClient(creds, binding);
    const [openOrders, closedOnly, remoteTerminalOrders] =
      await runBoundedAuthenticatedRequest(
        Promise.all([
          client.getOpenOrders(undefined, false),
          client.getClosedOnlyMode(),
          Promise.all(
            terminalExecutions.map(({ execution }) =>
              client.getOrder(execution.clobOrderId!)
            )
          )
        ]),
        "Authenticated emergency reconciliation failed."
      );
    if (!Array.isArray(openOrders)) {
      throw new Error("Authenticated open-order reconciliation was malformed.");
    }
    if (openOrders.length !== 0) {
      throw new Error(
        "Authenticated reconciliation found remote open orders."
      );
    }
    assertAccountCanOpenOrders(closedOnly);
    for (let index = 0; index < terminalExecutions.length; index += 1) {
      const local = terminalExecutions[index]!;
      const remote = remoteTerminalOrders[index];
      assertRemoteTerminalOrderMatchesProposal(
        remote,
        local.execution.clobOrderId!,
        local.proposal,
        binding.funderAddress
      );
    }

    this.database.beginImmediateTransaction();
    try {
      if (!this.database.verifyAuditChain()) {
        throw new Error("The audit chain changed during reconciliation.");
      }
      this.requireCurrentBinding();
      assertNoOutstandingLocalExecutions(this.database);
      if (!this.database.getEmergencyStop().active) {
        throw new Error("The emergency stop changed during reconciliation.");
      }
      this.database.setLiveActivation(false);
      this.database.resetCanaryProgress("INCIDENT_REVIEWED");
      this.database.setEmergencyStop(false, "MANUAL_LOCAL_REVIEW");
      this.database.commitDatabaseTransaction();
    } catch (error) {
      this.database.rollbackDatabaseTransaction();
      throw error;
    }
  }

  private async deriveLocalSignerAddress(): Promise<string> {
    const privateKey = await this.keychain.readSocialPrivateKey({
      reason: "Verify the exported Polymarket signer address"
    });
    try {
      return getAddress(
        privateKeyToAccount(bytesToHex(privateKey)).address
      ).toLowerCase();
    } finally {
      privateKey.fill(0);
    }
  }

  private async assertPublicProfileLink(
    profileAddress: string,
    signerAddress: string
  ): Promise<void> {
    const [profileRecord, signerRecord] = await Promise.all([
      this.requestRecord(
        `${this.config.gammaHost}/public-profile?address=${encodeURIComponent(
          profileAddress
        )}`
      ),
      this.requestRecord(
        `${this.config.gammaHost}/public-profile?address=${encodeURIComponent(
          signerAddress
        )}`
      )
    ]);
    const profileProxy = readAddress(
      profileRecord.proxyWallet ?? profileRecord.proxy_wallet
    );
    const signerProxy = readAddress(
      signerRecord.proxyWallet ?? signerRecord.proxy_wallet
    );
    const expected = profileAddress.toLowerCase();
    if (profileProxy !== expected || signerProxy !== expected) {
      throw new Error(
        "The public profile does not bind the exported signer to the configured funder."
      );
    }
  }

  private async detectSignatureType(
    funderAddress: string,
    signerAddress: string,
    confirmLegacyProxy: boolean
  ): Promise<1 | 3> {
    const deployed = await this.requestRecord(
      `${RELAYER_HOST}/deployed?address=${encodeURIComponent(
        funderAddress
      )}&type=WALLET`
    );
    if (deployed.deployed === true) {
      if (confirmLegacyProxy) {
        throw new Error(
          "The funder is a deployed deposit wallet; legacy proxy confirmation conflicts."
        );
      }
      return 3;
    }
    if (deployed.deployed !== false || !confirmLegacyProxy) {
      throw new Error(
        "Deposit-wallet detection was negative or indeterminate; explicitly confirm the legacy proxy flow."
      );
    }

    const proxyPayload = await this.requestRecord(
      `${RELAYER_HOST}/relay-payload?address=${encodeURIComponent(
        signerAddress
      )}&type=PROXY`
    );
    const derivedProxy = readAddress(proxyPayload.address);
    if (derivedProxy !== funderAddress.toLowerCase()) {
      throw new Error(
        "The relayer-derived legacy proxy does not match the configured funder."
      );
    }
    return 1;
  }

  private async deriveAndVerifyCredentials(
    signerAddress: string,
    funderAddress: string,
    signatureType: 1 | 3
  ): Promise<ApiKeyCreds> {
    const sdkSignatureType =
      signatureType === 1
        ? SignatureTypeV2.POLY_PROXY
        : SignatureTypeV2.POLY_1271;
    let creds: ApiKeyCreds;
    try {
      const created = await runBoundedAuthenticatedRequest(
        this.createClobAuthClient(
          signerAddress,
          funderAddress,
          sdkSignatureType
        ).createApiKey(),
        "Polymarket credential creation failed.",
        CREDENTIAL_SETUP_TIMEOUT_MS
      );
      assertCredentials(created);
      creds = created;
    } catch {
      creds = await runBoundedAuthenticatedRequest(
        this.createClobAuthClient(
          signerAddress,
          funderAddress,
          sdkSignatureType
        ).deriveApiKey(),
        "Polymarket credential derivation failed.",
        CREDENTIAL_SETUP_TIMEOUT_MS
      );
      assertCredentials(creds);
    }
    assertCredentials(creds);
    const verifiedCredentials: ApiKeyCreds = {
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase
    };

    await this.verifyL2Credentials(
      verifiedCredentials,
      signerAddress,
      funderAddress,
      signatureType
    );
    return verifiedCredentials;
  }

  private async verifyL2Credentials(
    creds: ApiKeyCreds,
    signerAddress: string,
    funderAddress: string,
    signatureType: 1 | 3
  ): Promise<void> {
    const l2 = this.createReadOnlyClient(creds, {
      signerAddress: signerAddress.toLowerCase(),
      funderAddress: funderAddress.toLowerCase(),
      profileAddress: funderAddress.toLowerCase(),
      signatureType,
      verifiedAtMs: 0
    });
    const [, openOrders, closedOnly] =
      await runBoundedAuthenticatedRequest(
        Promise.all([
          l2.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
          l2.getOpenOrders(undefined, false),
          l2.getClosedOnlyMode()
        ]),
        "Authenticated credential verification failed."
      );
    if (!Array.isArray(openOrders)) {
      throw new Error("Authenticated open-order reconciliation was malformed.");
    }
    assertAccountCanOpenOrders(closedOnly);
    assertConfigurationOpenOrdersReconcilable(
      this.database,
      openOrders,
      signerAddress,
      funderAddress,
      signatureType
    );
  }

  private createClobClient(options: ClobClientOptions): ClobClient {
    return this.dependencies.clobClientFactory?.(options) ??
      new ClobClient(options);
  }

  private createClobAuthClient(
    signerAddress: string,
    funderAddress: string,
    signatureType: SignatureTypeV2
  ): ClobClient {
    const restrictedSigner = new RestrictedKeychainSigner({
      keychain: this.keychain,
      permit: {
        purpose: "clob-auth",
        expectedAddress: signerAddress as `0x${string}`,
        expiresAtMs: Date.now() + 90_000
      }
    });
    return this.createClobClient({
      host: this.config.clobHost,
      chain: Chain.POLYGON,
      signer: restrictedSigner,
      signatureType,
      funderAddress,
      useServerTime: true,
      retryOnError: false,
      throwOnError: true
    });
  }

  private createPublicClient(): Pick<
    PolymarketPublicClient,
    "getPortfolio" | "getUserActivity"
  > {
    return this.dependencies.publicClientFactory?.() ??
      new PolymarketPublicClient({
        gammaHost: this.config.gammaHost,
        dataHost: this.config.dataHost,
        clobHost: this.config.clobHost,
        fetch: this.fetchFn
      });
  }

  private createReadOnlyClient(
    creds: ApiKeyCreds,
    binding: AccountBindingRecord
  ): ClobClient {
    const addressOnlySigner = {
      async getAddress() {
        return binding.signerAddress;
      },
      async _signTypedData() {
        throw new Error("Read-only onboarding client cannot sign orders.");
      }
    };
    return this.createClobClient({
      host: this.config.clobHost,
      chain: Chain.POLYGON,
      signer: addressOnlySigner,
      creds,
      signatureType:
        binding.signatureType === 1
          ? SignatureTypeV2.POLY_PROXY
          : SignatureTypeV2.POLY_1271,
      funderAddress: binding.funderAddress,
      useServerTime: true,
      retryOnError: false,
      throwOnError: true
    });
  }

  private async readStoredL2Credentials(reason: string): Promise<ApiKeyCreds> {
    const secret = await this.keychain.readL2Credentials({ reason });
    const encoded = Buffer.from(secret);
    try {
      if (
        encoded.byteLength === 0 ||
        encoded.byteLength > MAX_CREDENTIAL_RECORD_BYTES
      ) {
        throw new Error("The L2 credential record is malformed.");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(encoded.toString("utf8")) as unknown;
      } catch {
        throw new Error("The L2 credential record is malformed.");
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(",") !== "key,passphrase,secret"
      ) {
        throw new Error("The L2 credential record is malformed.");
      }
      const record = parsed as Record<string, unknown>;
      if (
        !isCredentialField(record.key) ||
        !isCredentialField(record.secret) ||
        !isCredentialField(record.passphrase)
      ) {
        throw new Error("The L2 credential record is malformed.");
      }
      return {
        key: record.key,
        secret: record.secret,
        passphrase: record.passphrase
      };
    } finally {
      encoded.fill(0);
      secret.fill(0);
    }
  }

  private requireCurrentBinding(): AccountBindingRecord {
    const binding = this.database.getAccountBinding();
    const profileAddress = this.config.profileAddress.toLowerCase();
    if (
      binding === null ||
      binding.profileAddress !== profileAddress ||
      binding.funderAddress !== profileAddress ||
      readAddress(binding.signerAddress) !== binding.signerAddress ||
      (binding.signatureType !== 1 && binding.signatureType !== 3)
    ) {
      throw new Error(
        "The verified signer, funder, and profile binding is missing or inconsistent."
      );
    }
    return binding;
  }

  private async requestRecord(url: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchFn(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Onboarding endpoint returned HTTP ${response.status}.`);
      }
      const payload = (await response.json()) as unknown;
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Onboarding endpoint returned malformed data.");
      }
      return payload as Record<string, unknown>;
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertProfileConfigured(): void {
    if (
      this.config.profileAddress ===
      "0x0000000000000000000000000000000000000000"
    ) {
      throw new Error("Configure POLYMARKET_PROFILE_ADDRESS first.");
    }
  }
}

function assertAccountCanOpenOrders(value: unknown): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).closed_only !== "boolean"
  ) {
    throw new Error("Authenticated account state was malformed.");
  }
  if ((value as { closed_only: boolean }).closed_only) {
    throw new Error("The Polymarket account is in closed-only mode.");
  }
}

function readAddress(value: unknown): string | null {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/u.test(value)
    ? value.toLowerCase()
    : null;
}

function assertCredentials(
  value: unknown
): asserts value is ApiKeyCreds {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !isCredentialField((value as Record<string, unknown>).key) ||
    !isCredentialField((value as Record<string, unknown>).secret) ||
    !isCredentialField((value as Record<string, unknown>).passphrase)
  ) {
    throw new Error("Polymarket returned incomplete L2 credentials.");
  }
}

function assertConfigurationOpenOrdersReconcilable(
  database: TradingDatabase,
  openOrders: OpenOrder[],
  signerAddress: string,
  funderAddress: string,
  signatureType: 1 | 3
): void {
  if (openOrders.length === 0) {
    return;
  }

  const binding = database.getAccountBinding();
  if (
    binding === null ||
    binding.signerAddress !== signerAddress.toLowerCase() ||
    binding.funderAddress !== funderAddress.toLowerCase() ||
    binding.profileAddress !== funderAddress.toLowerCase() ||
    binding.signatureType !== signatureType
  ) {
    throw new Error(
      "Initial account configuration requires zero remote open orders."
    );
  }

  const seenOrderIds = new Set<string>();
  const executions = database.listExecutions();
  for (const rawOrder of openOrders as unknown[]) {
    const order = requireOpenOrder(rawOrder);
    if (seenOrderIds.has(order.id)) {
      throw new Error("Authenticated open-order reconciliation was ambiguous.");
    }
    seenOrderIds.add(order.id);

    const matches = executions.filter(
      (execution) => execution.clobOrderId === order.id
    );
    if (matches.length !== 1) {
      throw new Error(
        "The account has a remote open order without unique local provenance."
      );
    }
    const execution = matches[0]!;
    const proposal = database.getProposal(execution.proposalId);
    if (
      !OPEN_EXECUTION_STATUSES.has(execution.status.toUpperCase()) ||
      proposal === null ||
      proposal.status !== "SUBMITTED" ||
      proposal.executionMode !== "live" ||
      execution.proposalHash !== proposal.hash ||
      !verifyProposalHash(proposal) ||
      proposal.correlationKey !== canonicalCorrelationKey(proposal.market)
    ) {
      throw new Error(
        "The account has a remote open order with invalid local provenance."
      );
    }
    assertRemoteOpenOrderMatchesProposal(
      order,
      proposal,
      binding.funderAddress
    );
  }
}

function requireOpenOrder(value: unknown): OpenOrder {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Authenticated open-order reconciliation was malformed.");
  }
  const order = value as Partial<OpenOrder>;
  if (
    !isBoundedIdentifier(order.id) ||
    !isBoundedIdentifier(order.market) ||
    !isBoundedIdentifier(order.asset_id) ||
      typeof order.status !== "string" ||
      normalizeClobOrderStatus(order.status) !== "LIVE" ||
    readAddress(order.maker_address) === null ||
    typeof order.side !== "string" ||
    typeof order.outcome !== "string" ||
    typeof order.original_size !== "string" ||
    typeof order.size_matched !== "string" ||
    typeof order.price !== "string" ||
    order.order_type !== "GTD"
  ) {
    throw new Error("Authenticated open-order reconciliation was malformed.");
  }
  const originalSize = parseClobFixed6(
    order.original_size,
    "ONBOARDING_ORDER_SIZE_INVALID"
  );
  const matchedSize = parseClobFixed6(
    order.size_matched,
    "ONBOARDING_ORDER_MATCHED_INVALID"
  );
  const price = parseClobPrice(
    order.price,
    "ONBOARDING_ORDER_PRICE_INVALID"
  );
  if (
    originalSize <= 0n ||
    matchedSize < 0n ||
    matchedSize > originalSize ||
    price <= 0n ||
    price >= 1_000_000n
  ) {
    throw new Error("Authenticated open-order reconciliation was malformed.");
  }
  return order as OpenOrder;
}

function assertRemoteOpenOrderMatchesProposal(
  order: OpenOrder,
  proposal: OrderProposal,
  funderAddress: string
): void {
  if (
    order.market.toLowerCase() !== proposal.market.conditionId.toLowerCase() ||
    order.asset_id !== proposal.market.tokenId ||
    order.side.toUpperCase() !== proposal.side ||
    order.outcome.trim().toLowerCase() !==
      proposal.market.outcome.trim().toLowerCase() ||
    readAddress(order.maker_address) !== funderAddress.toLowerCase() ||
    parseClobFixed6(
      order.original_size,
      "ONBOARDING_ORDER_SIZE_INVALID"
    ) !== proposal.sharesMicros ||
    parseClobPrice(
      order.price,
      "ONBOARDING_ORDER_PRICE_INVALID"
    ) !== proposal.limitPriceMicros
  ) {
    throw new Error(
      "The remote open order does not match its local immutable proposal."
    );
  }
}

function assertRemoteTerminalOrderMatchesProposal(
  value: unknown,
  expectedOrderId: string,
  proposal: OrderProposal,
  funderAddress: string
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Authenticated terminal-order reconciliation was malformed.");
  }
  const order = value as Partial<OpenOrder>;
  if (
    order.id !== expectedOrderId ||
    !isBoundedIdentifier(order.market) ||
    !isBoundedIdentifier(order.asset_id) ||
    typeof order.status !== "string" ||
    readAddress(order.maker_address) === null ||
    typeof order.side !== "string" ||
    typeof order.outcome !== "string" ||
    typeof order.original_size !== "string" ||
    typeof order.size_matched !== "string" ||
    typeof order.price !== "string" ||
    order.order_type !== "GTD"
  ) {
    throw new Error("Authenticated terminal-order reconciliation was malformed.");
  }

  const originalSize = parseClobFixed6(
    order.original_size,
    "ONBOARDING_ORDER_SIZE_INVALID"
  );
  const matchedSize = parseClobFixed6(
    order.size_matched,
    "ONBOARDING_ORDER_MATCHED_INVALID"
  );
  const price = parseClobPrice(
    order.price,
    "ONBOARDING_ORDER_PRICE_INVALID"
  );
  const status = normalizeClobOrderStatus(order.status);
  if (
    originalSize !== proposal.sharesMicros ||
    matchedSize < 0n ||
    matchedSize > originalSize ||
    price !== proposal.limitPriceMicros ||
    status === "LIVE" ||
    ((status === "FILLED" || status === "MATCHED") &&
      matchedSize !== originalSize) ||
    order.market.toLowerCase() !== proposal.market.conditionId.toLowerCase() ||
    order.asset_id !== proposal.market.tokenId ||
    order.side.toUpperCase() !== proposal.side ||
    order.outcome.trim().toLowerCase() !==
      proposal.market.outcome.trim().toLowerCase() ||
    readAddress(order.maker_address) !== funderAddress.toLowerCase()
  ) {
    throw new Error(
      "The remote terminal order does not match its local immutable proposal."
    );
  }
}

function assertOpenPositionsHaveLocalProvenance(
  database: TradingDatabase,
  positions: PortfolioPosition[],
  adoptedExistingPortfolio = false
): void {
  const executions = database.listExecutions();
  for (const position of positions) {
    if (position.sizeMicros < 0n) {
      throw new Error("The portfolio contains an invalid open position.");
    }
    if (position.sizeMicros === 0n) {
      continue;
    }
    if (adoptedExistingPortfolio) {
      continue;
    }
    const correlationKeys = new Set<string>();
    for (const execution of executions) {
      if (
        execution.clobOrderId === null ||
        execution.clobOrderId.trim().length === 0
      ) {
        continue;
      }
      const proposal = database.getProposal(execution.proposalId);
      if (
        proposal === null ||
        proposal.status !== "SUBMITTED" ||
        proposal.executionMode !== "live" ||
        !isRecognizedSubmittedExecutionStatus(execution.status) ||
        !Number.isSafeInteger(execution.submittedAtMs) ||
        execution.submittedAtMs <= 0 ||
        execution.proposalHash !== proposal.hash ||
        !verifyProposalHash(proposal) ||
        proposal.correlationKey !== canonicalCorrelationKey(proposal.market) ||
        proposal.market.tokenId !== position.tokenId ||
        proposal.market.conditionId.toLowerCase() !==
          position.conditionId.toLowerCase()
      ) {
        continue;
      }
      correlationKeys.add(proposal.correlationKey);
    }
    if (correlationKeys.size !== 1) {
      throw new Error(
        "The isolated wallet has an open position without unique local provenance."
      );
    }
  }
}

function positionIdentity(
  position: Pick<PortfolioPosition, "conditionId" | "tokenId">
): string {
  return `${position.conditionId.toLowerCase()}:${position.tokenId}`;
}

function portfolioIdentityHash(portfolio: PortfolioSnapshot): string {
  return hashCanonical({
    profileAddress: portfolio.profileAddress.toLowerCase(),
    positions: portfolio.positions
      .filter((position) => position.sizeMicros > 0n)
      .map((position) => ({
        conditionId: position.conditionId.toLowerCase(),
        tokenId: position.tokenId,
        outcome: position.outcome,
        sizeMicros: position.sizeMicros,
        averagePriceMicros: position.averagePriceMicros
      }))
      .sort((left, right) =>
        `${left.conditionId}:${left.tokenId}`.localeCompare(
          `${right.conditionId}:${right.tokenId}`
        )
      )
  });
}

function portfolioExposureMicros(portfolio: PortfolioSnapshot): bigint {
  return portfolio.positions.reduce((total, position) => {
    const costBasis =
      (position.sizeMicros * position.averagePriceMicros + 999_999n) /
      1_000_000n;
    const exposure =
      costBasis > position.currentValueMicros
        ? costBasis
        : position.currentValueMicros;
    return total + exposure;
  }, 0n);
}

function isPortfolioAdoptionCurrent(
  adoption: ReturnType<TradingDatabase["getLivePortfolioAdoption"]>,
  profileAddress: string,
  dayKey: string,
  portfolio: PortfolioSnapshot
): boolean {
  if (
    adoption === null ||
    adoption.profileAddress !== profileAddress ||
    adoption.dayKey !== dayKey ||
    adoption.portfolioHash !== portfolioIdentityHash(portfolio)
  ) {
    return false;
  }
  const currentKeys = portfolio.positions
    .filter((position) => position.sizeMicros > 0n)
    .map(positionIdentity)
    .sort();
  return (
    currentKeys.length === adoption.positionKeys.length &&
    currentKeys.every((key, index) => key === adoption.positionKeys[index])
  );
}

function assertNoOutstandingLocalExecutions(
  database: TradingDatabase
): TerminalExecutionEvidence[] {
  const reconciled: TerminalExecutionEvidence[] = [];
  for (const execution of database.listExecutions()) {
    const status = execution.status.trim().toUpperCase();
    if (!TERMINAL_EXECUTION_STATUSES.has(status)) {
      throw new Error(
        "A local execution remains non-terminal or ambiguous."
      );
    }
    const proposal = database.getProposal(execution.proposalId);
    if (
      proposal === null ||
      proposal.status !== "SUBMITTED" ||
      proposal.executionMode !== "live" ||
      execution.clobOrderId === null ||
      !isBoundedIdentifier(execution.clobOrderId) ||
      !Number.isSafeInteger(execution.submittedAtMs) ||
      execution.submittedAtMs <= 0 ||
      execution.proposalHash !== proposal.hash ||
      !verifyProposalHash(proposal) ||
      proposal.correlationKey !== canonicalCorrelationKey(proposal.market)
    ) {
      throw new Error("A terminal execution has invalid local provenance.");
    }
    reconciled.push({ execution, proposal });
  }
  return reconciled;
}

function isRecognizedSubmittedExecutionStatus(status: string): boolean {
  const normalized = status.trim().toUpperCase();
  return (
    OPEN_EXECUTION_STATUSES.has(normalized) ||
    TERMINAL_EXECUTION_STATUSES.has(normalized)
  );
}

function isCredentialField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

async function runBoundedAuthenticatedRequest<T>(
  operation: Promise<T>,
  failureMessage: string,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(failureMessage)),
          timeoutMs
        );
      })
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${failureMessage} [${detail}]`);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
