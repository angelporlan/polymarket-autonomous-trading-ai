import {
  ClobClient,
  type ApiKeyCreds,
  type ClobClientOptions,
  type OpenOrder
} from "@polymarket/clob-client-v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zonedDayKey } from "../src/application/risk-context.js";
import type { AppConfig } from "../src/config.js";
import { createOrderProposal } from "../src/domain/proposals.js";
import { createTradingSession } from "../src/domain/session.js";
import type {
  OrderProposal,
  PortfolioPosition,
  PortfolioSnapshot,
  UserTradeActivity
} from "../src/domain/types.js";
import {
  ADOPT_EXISTING_PORTFOLIO_CONFIRMATION,
  OnboardingService,
  type OnboardingServiceDependencies
} from "../src/onboarding/service.js";
import {
  L2_CREDENTIALS_ACCOUNT,
  SOCIAL_PRIVATE_KEY_ACCOUNT,
  type MacOSKeychain
} from "../src/security/keychain.js";
import { TradingDatabase } from "../src/storage/database.js";
import { intentFixture, riskContextFixture } from "./fixtures.js";

const PROFILE_ADDRESS = `0x${"1".repeat(40)}`;
const SIGNER_ADDRESS = `0x${"2".repeat(40)}`;
const FIXTURE_ORDER_ID = `0x${"3".repeat(64)}`;
const FIXTURE_CREDENTIALS: ApiKeyCreds = {
  key: "fixture-key-not-valid",
  secret: "fixture-secret-not-valid",
  passphrase: "fixture-passphrase-not-valid"
};

const databases: TradingDatabase[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe("OnboardingService authenticated reconciliation", () => {
  it("reuses and verifies an existing protected L2 item without trying to overwrite it", async () => {
    const database = createDatabase();
    const storeL2Credentials = vi.fn(async () => undefined);
    const service = createService(
      database,
      {
        clobClientFactory: createReadOnlyFactory([])
      },
      portfolioFixture([]),
      async () => credentialBytes(),
      {
        async status(account) {
          return { exists: account === L2_CREDENTIALS_ACCOUNT };
        },
        storeL2Credentials
      }
    );
    stubAccountDiscovery(service);

    await service.configureAccount(false);

    expect(storeL2Credentials).not.toHaveBeenCalled();
    expect(database.getAccountBinding()).toMatchObject({
      signerAddress: SIGNER_ADDRESS,
      funderAddress: PROFILE_ADDRESS,
      profileAddress: PROFILE_ADDRESS,
      signatureType: 3
    });
  });

  it("rejects an authenticated account that is in closed-only mode", async () => {
    const database = createDatabase();
    const service = createService(database, {
      clobClientFactory: createReadOnlyFactory(
        [],
        [],
        terminalOrderFixture(),
        true
      )
    });
    stubAccountDiscovery(service);

    await expect(service.configureAccount(false)).rejects.toThrow(
      /closed-only mode/i
    );

    expect(database.getAccountBinding()).toBeNull();
    expect(database.getLiveActivation().active).toBe(false);
  });

  it("persists the verified binding before a first L2 Keychain write", async () => {
    const database = createDatabase();
    const storeL2Credentials = vi.fn(async () => {
      expect(database.getAccountBinding()).toMatchObject({
        signerAddress: SIGNER_ADDRESS,
        funderAddress: PROFILE_ADDRESS,
        signatureType: 3
      });
      throw new Error("Fixture Keychain write failure.");
    });
    const service = createService(
      database,
      {},
      portfolioFixture([]),
      async () => credentialBytes(),
      {
        async status() {
          return { exists: false };
        },
        storeL2Credentials
      }
    );
    const discovery = stubAccountDiscovery(service);
    vi.spyOn(
      discovery,
      "deriveAndVerifyCredentials"
    ).mockResolvedValue(FIXTURE_CREDENTIALS);

    await expect(service.configureAccount(false)).rejects.toThrow(
      /fixture keychain write failure/i
    );

    expect(storeL2Credentials).toHaveBeenCalledOnce();
    expect(database.getAccountBinding()).not.toBeNull();
    expect(database.getLiveActivation().active).toBe(false);
  });

  it("requires a fully paginated empty remote order set for initial configuration", async () => {
    const database = createDatabase();
    const paginationArguments: boolean[] = [];
    const factory = createCredentialFactory(
      [openOrderFixture()],
      paginationArguments
    );
    const service = createService(database, {
      clobClientFactory: factory
    });

    await expect(
      deriveAndVerify(service, SIGNER_ADDRESS, PROFILE_ADDRESS, 3)
    ).rejects.toThrow(/initial account configuration requires zero/i);
    expect(paginationArguments).toEqual([false]);
  });

  it("allows a reconfiguration only when every remote order has valid non-terminal local provenance", async () => {
    const database = createDatabase();
    setBinding(database);
    const proposal = seedSubmittedExecution(database, "LIVE");
    const paginationArguments: boolean[] = [];
    const factory = createCredentialFactory(
      [openOrderFixture(proposal)],
      paginationArguments
    );
    const service = createService(database, {
      clobClientFactory: factory
    });

    await expect(
      deriveAndVerify(service, SIGNER_ADDRESS, PROFILE_ADDRESS, 3)
    ).resolves.toEqual(FIXTURE_CREDENTIALS);
    expect(paginationArguments).toEqual([false]);
  });

  it("uses a fresh one-shot signer when an empty create response requires derivation", async () => {
    const database = createDatabase();
    const authSigners: unknown[] = [];
    let authAttempt = 0;
    const factory = (options: ClobClientOptions): ClobClient => {
      if (options.creds === undefined) {
        authSigners.push(options.signer);
        authAttempt += 1;
        if (authAttempt === 1) {
          return {
            async createApiKey() {
              return {
                key: "",
                secret: "fixture-empty-create",
                passphrase: "fixture-empty-create"
              };
            }
          } as unknown as ClobClient;
        }
        return {
          async deriveApiKey() {
            return FIXTURE_CREDENTIALS;
          }
        } as unknown as ClobClient;
      }
      return readOnlyClient([], []);
    };
    const service = createService(database, {
      clobClientFactory: factory
    });

    await expect(
      deriveAndVerify(service, SIGNER_ADDRESS, PROFILE_ADDRESS, 3)
    ).resolves.toEqual(FIXTURE_CREDENTIALS);
    expect(authSigners).toHaveLength(2);
    expect(authSigners[0]).not.toBe(authSigners[1]);
  });

  it("blocks untracked, terminal, or contract-mismatched remote open orders", async () => {
    const untrackedDatabase = createDatabase();
    setBinding(untrackedDatabase);
    await expect(
      deriveAndVerify(
        createService(untrackedDatabase, {
          clobClientFactory: createCredentialFactory([openOrderFixture()])
        }),
        SIGNER_ADDRESS,
        PROFILE_ADDRESS,
        3
      )
    ).rejects.toThrow(/without unique local provenance/i);

    const terminalDatabase = createDatabase();
    setBinding(terminalDatabase);
    const terminalProposal = seedSubmittedExecution(
      terminalDatabase,
      "CONFIRMED"
    );
    await expect(
      deriveAndVerify(
        createService(terminalDatabase, {
          clobClientFactory: createCredentialFactory([
            openOrderFixture(terminalProposal)
          ])
        }),
        SIGNER_ADDRESS,
        PROFILE_ADDRESS,
        3
      )
    ).rejects.toThrow(/invalid local provenance/i);

    const mismatchedDatabase = createDatabase();
    setBinding(mismatchedDatabase);
    const mismatchedProposal = seedSubmittedExecution(
      mismatchedDatabase,
      "LIVE"
    );
    await expect(
      deriveAndVerify(
        createService(mismatchedDatabase, {
          clobClientFactory: createCredentialFactory([
            {
              ...openOrderFixture(mismatchedProposal),
              asset_id: "different-token"
            }
          ])
        }),
        SIGNER_ADDRESS,
        PROFILE_ADDRESS,
        3
      )
    ).rejects.toThrow(/immutable proposal/i);
  });
});

describe("OnboardingService live activation provenance", () => {
  it("blocks an open portfolio position without a hash-valid submitted live execution", async () => {
    const database = createDatabase();
    setBinding(database);
    armToday(database);
    const service = createService(
      database,
      {},
      portfolioFixture([positionFixture()])
    );

    await expect(
      service.activateLive("ACTIVATE_LIVE", true)
    ).rejects.toThrow(/without unique local provenance/i);
    expect(database.getLiveActivation().active).toBe(false);
  });

  it("allows a portfolio position attributed to a canonical submitted live proposal", async () => {
    const database = createDatabase();
    setBinding(database);
    const proposal = seedSubmittedExecution(database, "CONFIRMED");
    const portfolio = portfolioFixture([
      positionFixture(
        proposal.market.tokenId,
        proposal.market.conditionId
      )
    ]);
    const baselineMicros = 5_000n;
    armToday(database, baselineMicros);
    const getUserActivity = vi.fn(
      async (_profileAddress: string, _sinceMs: number) => [
        tradeActivityFixture()
      ]
    );
    const service = createService(
      database,
      {
        publicClientFactory: () => ({
          async getPortfolio() {
            return portfolio;
          },
          getUserActivity
        })
      }
    );

    await service.activateLive("ACTIVATE_LIVE", true);

    expect(database.getLiveActivation().active).toBe(true);
    expect(getUserActivity).not.toHaveBeenCalled();
    expect(
      database.getDailyRiskPnl(
        zonedDayKey(Date.now(), "Europe/Madrid"),
        portfolio.totalPnlMicros
      ).pnlMicros
    ).toBe(portfolio.totalPnlMicros - baselineMicros);
    expect(database.countAuditEvents("DAILY_RISK_SESSION_ARMED")).toBe(1);
    expect(database.countAuditEvents("DAILY_RISK_SESSION_REUSED")).toBe(0);
  });

  it("blocks every open position before arming a new daily risk session", async () => {
    const database = createDatabase();
    setBinding(database);
    const proposal = seedSubmittedExecution(database, "CONFIRMED");
    const service = createService(
      database,
      {},
      portfolioFixture([
        positionFixture(
          proposal.market.tokenId,
          proposal.market.conditionId
        )
      ])
    );

    await expect(
      service.activateLive("ACTIVATE_LIVE", true)
    ).rejects.toThrow(/new daily risk session requires zero open positions/i);

    expect(database.getLiveActivation().active).toBe(false);
    expect(database.countAuditEvents("DAILY_RISK_SESSION_ARMED")).toBe(0);
  });

  it("adopts an existing portfolio only after a clean day and then arms risk", async () => {
    const database = createDatabase();
    setBinding(database);
    const portfolio = portfolioFixture([positionFixture()]);
    const service = createService(database, {}, portfolio);

    await service.adoptExistingPortfolio(
      ADOPT_EXISTING_PORTFOLIO_CONFIRMATION,
      true
    );

    expect(database.getLivePortfolioAdoption()).toMatchObject({
      profileAddress: PROFILE_ADDRESS,
      dayKey: zonedDayKey(Date.now(), "Europe/Madrid"),
      positionKeys: [
        `${portfolio.positions[0]!.conditionId.toLowerCase()}:${portfolio.positions[0]!.tokenId}`
      ]
    });
    expect(database.getLiveActivation().active).toBe(false);

    await service.activateLive("ACTIVATE_LIVE", true);

    expect(database.getLiveActivation().active).toBe(true);
    expect(database.countAuditEvents("LIVE_PORTFOLIO_ADOPTED")).toBe(1);
    expect(database.countAuditEvents("DAILY_RISK_SESSION_ARMED")).toBe(1);
  });

  it("does not adopt a portfolio after same-day trade activity", async () => {
    const database = createDatabase();
    setBinding(database);
    const service = createService(
      database,
      {
        publicClientFactory: () => ({
          async getPortfolio() {
            return portfolioFixture([positionFixture()]);
          },
          async getUserActivity() {
            return [tradeActivityFixture()];
          }
        })
      },
      portfolioFixture([positionFixture()])
    );

    await expect(
      service.adoptExistingPortfolio(
        ADOPT_EXISTING_PORTFOLIO_CONFIRMATION,
        true
      )
    ).rejects.toThrow(/zero TRADE activity since midnight Europe\/Madrid/i);
    expect(database.getLivePortfolioAdoption()).toBeNull();
  });

  it("blocks a new daily risk session when TRADE activity exists since Madrid midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
    const database = createDatabase();
    setBinding(database);
    const getUserActivity = vi.fn(
      async (_profileAddress: string, _sinceMs: number) => [
        tradeActivityFixture(Date.now())
      ]
    );
    const service = createService(database, {
      publicClientFactory: () => ({
        async getPortfolio() {
          return portfolioFixture([]);
        },
        getUserActivity
      })
    });

    await expect(
      service.activateLive("ACTIVATE_LIVE", true)
    ).rejects.toThrow(/zero TRADE activity since midnight Europe\/Madrid/i);

    const sinceMs = getUserActivity.mock.calls[0]?.[1];
    expect(sinceMs).toBeTypeOf("number");
    expect(zonedDayKey(sinceMs!, "Europe/Madrid")).toBe(
      zonedDayKey(Date.now(), "Europe/Madrid")
    );
    expect(zonedDayKey(sinceMs! - 1, "Europe/Madrid")).not.toBe(
      zonedDayKey(Date.now(), "Europe/Madrid")
    );
    expect(database.getLiveActivation().active).toBe(false);
    expect(database.countAuditEvents("DAILY_RISK_SESSION_ARMED")).toBe(0);
  });

  it("arms a new daily risk session only after an empty portfolio and activity history", async () => {
    const database = createDatabase();
    setBinding(database);
    const service = createService(database);

    await service.activateLive("ACTIVATE_LIVE", true);

    expect(database.getLiveActivation().active).toBe(true);
    expect(database.countAuditEvents("DAILY_RISK_SESSION_ARMED")).toBe(1);
  });

  it("blocks live activation while the authenticated account is closed-only", async () => {
    const database = createDatabase();
    setBinding(database);
    const getPortfolio = vi.fn(async () => portfolioFixture([]));
    const service = createService(database, {
      clobClientFactory: createReadOnlyFactory(
        [],
        [],
        terminalOrderFixture(),
        true
      ),
      publicClientFactory: () => ({
        getPortfolio,
        async getUserActivity() {
          return [];
        }
      })
    });

    await expect(
      service.activateLive("ACTIVATE_LIVE", true)
    ).rejects.toThrow(/closed-only mode/i);

    expect(getPortfolio).not.toHaveBeenCalled();
    expect(database.getLiveActivation().active).toBe(false);
  });
});

describe("OnboardingService emergency lock review", () => {
  it("keeps the lock when authenticated reconciliation finds a remote open order", async () => {
    const database = createDatabase();
    setBinding(database);
    database.setEmergencyStop(true, "TEST_INCIDENT");
    const service = createService(database, {
      clobClientFactory: createReadOnlyFactory([openOrderFixture()])
    });

    await expect(
      service.clearEmergencyStop("CLEAR_EMERGENCY")
    ).rejects.toThrow(/remote open orders/i);
    expect(database.getEmergencyStop().active).toBe(true);
  });

  it("keeps the lock without reading credentials when a local execution is non-terminal", async () => {
    const database = createDatabase();
    setBinding(database);
    seedSubmittedExecution(database, "LIVE");
    database.setEmergencyStop(true, "TEST_INCIDENT");
    const readL2Credentials = vi.fn(async () => credentialBytes());
    const service = createService(
      database,
      {
        clobClientFactory: createReadOnlyFactory([])
      },
      portfolioFixture([]),
      readL2Credentials
    );

    await expect(
      service.clearEmergencyStop("CLEAR_EMERGENCY")
    ).rejects.toThrow(/non-terminal or ambiguous/i);
    expect(readL2Credentials).not.toHaveBeenCalled();
    expect(database.getEmergencyStop().active).toBe(true);
  });

  it("keeps the lock when a locally terminal status is still remote-live", async () => {
    const database = createDatabase();
    setBinding(database);
    const proposal = seedSubmittedExecution(database, "CONFIRMED");
    database.setEmergencyStop(true, "TEST_INCIDENT");
    const service = createService(database, {
      clobClientFactory: createReadOnlyFactory(
        [],
        [],
        openOrderFixture(proposal)
      )
    });

    await expect(
      service.clearEmergencyStop("CLEAR_EMERGENCY")
    ).rejects.toThrow(/does not match its local immutable proposal/i);
    expect(database.getEmergencyStop().active).toBe(true);
  });

  it("keeps the lock while the authenticated account is closed-only", async () => {
    const database = createDatabase();
    setBinding(database);
    database.setEmergencyStop(true, "TEST_INCIDENT");
    const service = createService(database, {
      clobClientFactory: createReadOnlyFactory(
        [],
        [],
        terminalOrderFixture(),
        true
      )
    });

    await expect(
      service.clearEmergencyStop("CLEAR_EMERGENCY")
    ).rejects.toThrow(/closed-only mode/i);

    expect(database.getEmergencyStop().active).toBe(true);
  });

  it("keeps the lock when the audit chain is invalid", async () => {
    const database = createDatabase();
    setBinding(database);
    database.setEmergencyStop(true, "TEST_INCIDENT");
    database.db
      .prepare("UPDATE audit_events SET event_hash = ? WHERE id = 1")
      .run("tampered-audit-hash");
    const readL2Credentials = vi.fn(async () => credentialBytes());
    const service = createService(
      database,
      {
        clobClientFactory: createReadOnlyFactory([])
      },
      portfolioFixture([]),
      readL2Credentials
    );

    await expect(
      service.clearEmergencyStop("CLEAR_EMERGENCY")
    ).rejects.toThrow(/audit chain is invalid/i);
    expect(readL2Credentials).not.toHaveBeenCalled();
    expect(database.getEmergencyStop().active).toBe(true);
  });

  it("clears only after strict reconciliation, resets canary, and leaves live disabled", async () => {
    const database = createDatabase();
    setBinding(database);
    const proposal = seedSubmittedExecution(database, "CONFIRMED");
    database.setLiveActivation(true);
    database.setEmergencyStop(true, "TEST_INCIDENT");
    const resetsBefore = database.countAuditEvents("CANARY_PROGRESS_RESET");
    const paginationArguments: boolean[] = [];
    const service = createService(database, {
      clobClientFactory: createReadOnlyFactory(
        [],
        paginationArguments,
        terminalOrderFixture(proposal)
      )
    });

    await service.clearEmergencyStop("CLEAR_EMERGENCY");

    expect(paginationArguments).toEqual([false]);
    expect(database.getEmergencyStop()).toMatchObject({
      active: false,
      reason: "MANUAL_LOCAL_REVIEW"
    });
    expect(database.getLiveActivation().active).toBe(false);
    expect(database.countAuditEvents("CANARY_PROGRESS_RESET")).toBe(
      resetsBefore + 1
    );
    expect(database.getExecution(proposal.id)?.status).toBe("CONFIRMED");
    expect(database.verifyAuditChain()).toBe(true);
  });
});

function createDatabase(): TradingDatabase {
  const database = new TradingDatabase(":memory:");
  databases.push(database);
  return database;
}

function createService(
  database: TradingDatabase,
  dependencies: OnboardingServiceDependencies = {},
  portfolio: PortfolioSnapshot = portfolioFixture([]),
  readL2Credentials: () => Promise<Uint8Array> = async () =>
    credentialBytes(),
  keychainOverrides: Partial<MacOSKeychain> = {}
): OnboardingService {
  const keychain = {
    async status(_account: typeof L2_CREDENTIALS_ACCOUNT | typeof SOCIAL_PRIVATE_KEY_ACCOUNT) {
      return { exists: true };
    },
    async importSocialPrivateKeyInteractive() {
      return undefined;
    },
    async storeL2Credentials() {
      return undefined;
    },
    readL2Credentials,
    async readSocialPrivateKey() {
      throw new Error("The fixture never exposes a private key.");
    },
    ...keychainOverrides
  } as unknown as MacOSKeychain;
  const noNetworkFetch = vi.fn(async () => {
    throw new Error("Unexpected network request.");
  }) as unknown as typeof fetch;
  return new OnboardingService(
    configFixture(),
    database,
    keychain,
    noNetworkFetch,
    {
      clobClientFactory: createReadOnlyFactory([]),
      publicClientFactory: () => ({
        async getPortfolio() {
          return portfolio;
        },
        async getUserActivity() {
          return [];
        }
      }),
      ...dependencies
    }
  );
}

function stubAccountDiscovery(service: OnboardingService): {
  deriveLocalSignerAddress(): Promise<string>;
  assertPublicProfileLink(
    profileAddress: string,
    signerAddress: string
  ): Promise<void>;
  detectSignatureType(
    funderAddress: string,
    signerAddress: string,
    confirmLegacyProxy: boolean
  ): Promise<1 | 3>;
  deriveAndVerifyCredentials(
    signerAddress: string,
    funderAddress: string,
    signatureType: 1 | 3
  ): Promise<ApiKeyCreds>;
} {
  const internals = service as unknown as {
    deriveLocalSignerAddress(): Promise<string>;
    assertPublicProfileLink(
      profileAddress: string,
      signerAddress: string
    ): Promise<void>;
    detectSignatureType(
      funderAddress: string,
      signerAddress: string,
      confirmLegacyProxy: boolean
    ): Promise<1 | 3>;
    deriveAndVerifyCredentials(
      signerAddress: string,
      funderAddress: string,
      signatureType: 1 | 3
    ): Promise<ApiKeyCreds>;
  };
  vi.spyOn(internals, "deriveLocalSignerAddress").mockResolvedValue(
    SIGNER_ADDRESS
  );
  vi.spyOn(internals, "assertPublicProfileLink").mockResolvedValue();
  vi.spyOn(internals, "detectSignatureType").mockResolvedValue(3);
  return internals;
}

function configFixture(): AppConfig {
  return {
    profileAddress: PROFILE_ADDRESS,
    databasePath: ":memory:",
    approvalHost: "127.0.0.1",
    approvalPort: 8787,
    liveEnabled: true,
    paperGateSkip: false,
    keychainService: "codex-polymarket-guarded",
    clobHost: "https://clob.polymarket.com",
    gammaHost: "https://gamma-api.polymarket.com",
    dataHost: "https://data-api.polymarket.com",
    polygonRpcUrls: [
      "https://polygon-rpc-one.test",
      "https://polygon-rpc-two.test"
    ],
    chainId: 137
  };
}

function setBinding(database: TradingDatabase): void {
  database.setAccountBinding({
    signerAddress: SIGNER_ADDRESS,
    funderAddress: PROFILE_ADDRESS,
    profileAddress: PROFILE_ADDRESS,
    signatureType: 3,
    verifiedAtMs: Date.now()
  });
}

function armToday(
  database: TradingDatabase,
  baselineMicros = 0n
): void {
  const nowMs = Date.now();
  database.armDailyRiskSession(
    zonedDayKey(nowMs, "Europe/Madrid"),
    baselineMicros,
    nowMs
  );
}

function seedSubmittedExecution(
  database: TradingDatabase,
  executionStatus: string
): OrderProposal {
  const nowMs = Date.now();
  const intent = intentFixture(nowMs);
  intent.executionMode = "live";
  const session = createTradingSession({
    executionMode: "live",
    authorizedBudgetMicros: 10n * 1_000_000n,
    nowMs
  });
  database.saveTradingSession(session);
  intent.sessionId = session.id;
  const proposal = createOrderProposal(intent, riskContextFixture(nowMs));
  database.stageProposal(proposal);
  if (!database.claimAutonomousExecution(proposal.id, proposal.hash, session.id, nowMs + 1)) {
    throw new Error("Could not seed the fixture execution.");
  }
  database.markExecutionSubmitted({
    proposalId: proposal.id,
    proposalHash: proposal.hash,
    clobOrderId: FIXTURE_ORDER_ID,
    status: "SUBMITTED_UNRECONCILED",
    submittedAtMs: nowMs + 4,
    responseJson: "{}"
  });
  if (executionStatus !== "SUBMITTED_UNRECONCILED") {
    database.updateExecutionStatus(
      proposal.id,
      executionStatus,
      "{}",
      nowMs + 5
    );
  }
  const submitted = database.getProposal(proposal.id);
  if (submitted === null) {
    throw new Error("Could not read the fixture proposal.");
  }
  return submitted;
}

function createCredentialFactory(
  openOrders: OpenOrder[],
  paginationArguments: boolean[] = [],
  closedOnly = false
): (options: ClobClientOptions) => ClobClient {
  return (options) => {
    if (options.creds === undefined) {
      return {
        async createApiKey() {
          return FIXTURE_CREDENTIALS;
        }
      } as unknown as ClobClient;
    }
    return readOnlyClient(
      openOrders,
      paginationArguments,
      terminalOrderFixture(),
      closedOnly
    );
  };
}

function createReadOnlyFactory(
  openOrders: OpenOrder[],
  paginationArguments: boolean[] = [],
  terminalOrder: OpenOrder = terminalOrderFixture(),
  closedOnly = false
): (options: ClobClientOptions) => ClobClient {
  return () =>
    readOnlyClient(
      openOrders,
      paginationArguments,
      terminalOrder,
      closedOnly
    );
}

function readOnlyClient(
  openOrders: OpenOrder[],
  paginationArguments: boolean[],
  terminalOrder: OpenOrder = terminalOrderFixture(),
  closedOnly = false
): ClobClient {
  return {
    async getBalanceAllowance() {
      return { balance: "0", allowances: {} };
    },
    async getOpenOrders(
      _params: unknown,
      onlyFirstPage?: boolean
    ) {
      paginationArguments.push(onlyFirstPage ?? true);
      return openOrders;
    },
    async getClosedOnlyMode() {
      return { closed_only: closedOnly };
    },
    async getOrder() {
      return terminalOrder;
    }
  } as unknown as ClobClient;
}

function openOrderFixture(
  proposal?: OrderProposal
): OpenOrder {
  const market = proposal?.market ?? intentFixture().market;
  return {
    id: FIXTURE_ORDER_ID,
    status: "LIVE",
    owner: SIGNER_ADDRESS,
    maker_address: PROFILE_ADDRESS,
    market: market.conditionId,
    asset_id: market.tokenId,
    side: proposal?.side ?? "BUY",
    original_size: proposal
      ? proposal.sharesMicros.toString()
      : "10000000",
    size_matched: "0",
    price: proposal
      ? microsToDecimal(proposal.limitPriceMicros)
      : "0.4",
    associate_trades: [],
    outcome: market.outcome,
    created_at: Math.floor(Date.now() / 1_000),
    expiration: String(Math.floor(Date.now() / 1_000) + 900),
    order_type: "GTD"
  };
}

function terminalOrderFixture(
  proposal?: OrderProposal
): OpenOrder {
  const order = openOrderFixture(proposal);
  return {
    ...order,
    status: "MATCHED",
    size_matched: order.original_size
  };
}

function positionFixture(
  tokenId = intentFixture().market.tokenId,
  conditionId = intentFixture().market.conditionId
): PortfolioPosition {
  return {
    tokenId,
    conditionId,
    question: "Fixture market",
    outcome: "Yes",
    sizeMicros: 1_000_000n,
    averagePriceMicros: 400_000n,
    currentPriceMicros: 410_000n,
    currentValueMicros: 410_000n,
    cashPnlMicros: 10_000n,
    realizedPnlMicros: 0n,
    endTimeMs: Date.now() + 2 * 24 * 60 * 60_000
  };
}

function portfolioFixture(
  positions: PortfolioPosition[]
): PortfolioSnapshot {
  return {
    profileAddress: PROFILE_ADDRESS,
    pUsdBalanceMicros: null,
    totalPositionValueMicros: positions.reduce(
      (total, position) => total + position.currentValueMicros,
      0n
    ),
    totalPnlMicros: positions.reduce(
      (total, position) =>
        total + position.cashPnlMicros + position.realizedPnlMicros,
      0n
    ),
    positions,
    capturedAtMs: Date.now(),
    source: "public"
  };
}

function tradeActivityFixture(
  timestampMs = Date.now()
): UserTradeActivity {
  const market = intentFixture(timestampMs).market;
  return {
    profileAddress: PROFILE_ADDRESS,
    transactionHash: `0x${"a".repeat(64)}`,
    conditionId: market.conditionId,
    tokenId: market.tokenId,
    side: "BUY",
    timestampMs,
    sizeMicros: 1_000_000n,
    priceMicros: 400_000n,
    notionalMicros: 400_000n
  };
}

function credentialBytes(): Uint8Array {
  return Buffer.from(JSON.stringify(FIXTURE_CREDENTIALS), "utf8");
}

async function deriveAndVerify(
  service: OnboardingService,
  signerAddress: string,
  funderAddress: string,
  signatureType: 1 | 3
): Promise<ApiKeyCreds> {
  return (
    service as unknown as {
      deriveAndVerifyCredentials(
        signer: string,
        funder: string,
        type: 1 | 3
      ): Promise<ApiKeyCreds>;
    }
  ).deriveAndVerifyCredentials(signerAddress, funderAddress, signatureType);
}

function microsToDecimal(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/u, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}
