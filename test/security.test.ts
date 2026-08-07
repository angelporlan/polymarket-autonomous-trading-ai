import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { ClobClientOptions } from "@polymarket/clob-client-v2";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashCanonical } from "../src/domain/proposals.js";
import { RISK_POLICY_VERSION } from "../src/domain/risk-policy.js";
import type { OrderProposal } from "../src/domain/types.js";
import { createTradingSession } from "../src/domain/session.js";
import {
  KEYCHAIN_SERVICE,
  MacOSKeychain,
  type KeychainPort
} from "../src/security/keychain.js";
import {
  LocalApprovalCoordinator,
  LocalApprovalError
} from "../src/security/local-approval.js";
import {
  RestrictedKeychainSigner,
  RestrictedSigningError,
  type TypedDataDomain,
  type TypedDataTypes,
  type TypedDataValue
} from "../src/security/restricted-signer.js";
import { TradingDatabase } from "../src/storage/database.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

describe("RestrictedKeychainSigner", () => {
  const privateKey = randomBytes(32);
  const account = privateKeyToAccount(
    `0x${Buffer.from(privateKey).toString("hex")}`
  );
  const nowMs = 1_800_000_000_000;
  const domain: TypedDataDomain = {
    name: "ClobAuthDomain",
    version: "1",
    chainId: 137
  };
  const types: TypedDataTypes = {
    ClobAuth: [
      { name: "address", type: "address" },
      { name: "timestamp", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "message", type: "string" }
    ]
  };
  const value: TypedDataValue = {
    address: account.address,
    timestamp: Math.floor(nowMs / 1_000).toString(),
    nonce: 0,
    message: "This message attests that I control the given wallet"
  };

  afterAll(() => {
    privateKey.fill(0);
  });

  it("signs only the permitted CLOB payload and wipes the supplied key bytes", async () => {
    const supplied = Uint8Array.from(privateKey);
    let reads = 0;
    const port: KeychainPort = {
      async readSocialPrivateKey() {
        reads += 1;
        return supplied;
      }
    };
    const signer = new RestrictedKeychainSigner({
      keychain: port,
      permit: {
        purpose: "clob-auth",
        expectedAddress: getAddress(account.address),
        expiresAtMs: nowMs + 1_000
      },
      now: () => nowMs
    });
    const clobCompatibleSigner: NonNullable<ClobClientOptions["signer"]> = signer;

    const signature = await signer._signTypedData(domain, types, value);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await signer.getAddress()).toBe(getAddress(account.address));
    expect(clobCompatibleSigner).toBe(signer);
    expect(reads).toBe(1);
    expect([...supplied]).toEqual(new Array(32).fill(0));

    await expect(signer._signTypedData(domain, types, value)).rejects.toMatchObject({
      code: "PERMIT_ALREADY_CONSUMED"
    });
  });

  it("rejects altered typed data before opening Keychain", async () => {
    let reads = 0;
    const port: KeychainPort = {
      async readSocialPrivateKey() {
        reads += 1;
        return Uint8Array.from(privateKey);
      }
    };
    const signer = new RestrictedKeychainSigner({
      keychain: port,
      permit: {
        purpose: "clob-auth",
        expectedAddress: getAddress(account.address),
        expiresAtMs: nowMs + 1_000
      },
      now: () => nowMs
    });

    await expect(
      signer._signTypedData(
        { ...domain, chainId: 1 },
        types,
        value
      )
    ).rejects.toBeInstanceOf(RestrictedSigningError);
    expect(reads).toBe(0);
  });

  it("fails closed when the Keychain address does not match", async () => {
    const wrongKey = randomBytes(32);
    const port: KeychainPort = {
      async readSocialPrivateKey() {
        return wrongKey;
      }
    };
    const signer = new RestrictedKeychainSigner({
      keychain: port,
      permit: {
        purpose: "clob-auth",
        expectedAddress: getAddress(account.address),
        expiresAtMs: nowMs + 1_000
      },
      now: () => nowMs
    });

    await expect(
      signer._signTypedData(domain, types, value)
    ).rejects.toMatchObject({ code: "SIGNER_ADDRESS_MISMATCH" });
    expect([...wrongKey]).toEqual(new Array(32).fill(0));
  });

  it("times out final preflight and wipes the key before a late callback resolves", async () => {
    const supplied = Uint8Array.from(privateKey);
    let resolvePreflight!: () => void;
    const blockedPreflight = new Promise<void>((resolve) => {
      resolvePreflight = resolve;
    });
    const signer = new RestrictedKeychainSigner({
      keychain: {
        async readSocialPrivateKey() {
          return supplied;
        }
      },
      permit: {
        purpose: "clob-auth",
        expectedAddress: getAddress(account.address),
        expiresAtMs: nowMs + 10_000
      },
      now: () => nowMs,
      beforeSign: () => blockedPreflight,
      beforeSignTimeoutMs: 5
    });

    await expect(
      signer._signTypedData(domain, types, value)
    ).rejects.toMatchObject({ code: "FINAL_PREFLIGHT_TIMEOUT" });
    expect([...supplied]).toEqual(new Array(32).fill(0));
    resolvePreflight();
  });

  it("signs an exact allowlisted order and rejects an amount increase before Keychain", async () => {
    const maker = getAddress("0x1111111111111111111111111111111111111111");
    const exchange = getAddress("0x2222222222222222222222222222222222222222");
    const orderDomain: TypedDataDomain = {
      name: "Polymarket CTF Exchange",
      version: "2",
      chainId: 137,
      verifyingContract: exchange
    };
    const orderTypes: TypedDataTypes = {
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
    };
    const orderValue: TypedDataValue = {
      salt: 1,
      maker,
      signer: account.address,
      tokenId: "123",
      makerAmount: "400000",
      takerAmount: "1000000",
      side: 0,
      signatureType: 1,
      timestamp: nowMs.toString(),
      metadata: `0x${"00".repeat(32)}`,
      builder: `0x${"00".repeat(32)}`
    };
    let reads = 0;
    const port: KeychainPort = {
      async readSocialPrivateKey() {
        reads += 1;
        return Uint8Array.from(privateKey);
      }
    };
    const makeSigner = () =>
      new RestrictedKeychainSigner({
        keychain: port,
        permit: {
          purpose: "order",
          proposalId: "proposal",
          proposalHash: "ab".repeat(32),
          expectedAddress: getAddress(account.address),
          expiresAtMs: nowMs + 1_000,
          maker,
          orderSigner: getAddress(account.address),
          tokenId: 123n,
          side: 0,
          signatureType: 1,
          maxMakerAmount: 400_000n,
          maxTakerAmount: 1_000_000n,
          allowedVerifyingContracts: [exchange],
          allowedDomainVersions: ["2"]
        },
        now: () => nowMs
      });

    await expect(
      makeSigner()._signTypedData(orderDomain, orderTypes, orderValue)
    ).resolves.toMatch(/^0x[0-9a-f]{130}$/);
    expect(reads).toBe(1);

    await expect(
      makeSigner()._signTypedData(orderDomain, orderTypes, {
        ...orderValue,
        makerAmount: "400001"
      })
    ).rejects.toMatchObject({ code: "ORDER_MESSAGE_MISMATCH" });
    expect(reads).toBe(1);
  });
});

describe("LocalApprovalCoordinator", () => {
  it("persists only hashed challenge material after exact double confirmation", () => {
    const now = { value: 2_000_000_000_000 };
    const database = new TradingDatabase(":memory:");
    try {
      const session = createTradingSession({
        executionMode: "live",
        authorizedBudgetMicros: 1_000_000n,
        nowMs: now.value
      });
      database.saveTradingSession(session);
      const proposal = makeProposal(now.value, session.id);
      database.stageProposal(proposal);
      const coordinator = new LocalApprovalCoordinator({
        database,
        now: () => now.value
      });

      const challenge = coordinator.begin(proposal.id, proposal.hash);
      expect(challenge.csrfToken).not.toBe(challenge.nonce);
      expect(challenge.requiredHashSuffix).toBe(proposal.hash.slice(-6));
      expect(database.getProposal(proposal.id)?.status).toBe("AWAITING_LOCAL");

      const approved = coordinator.approve({
        proposalId: proposal.id,
        proposalHash: proposal.hash,
        csrfToken: challenge.csrfToken,
        nonce: challenge.nonce,
        hashSuffix: challenge.requiredHashSuffix
      });
      expect(approved.status).toBe("LOCALLY_APPROVED");

      const persisted = database.getLocalApproval(proposal.id);
      expect(persisted?.nonceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(persisted?.nonceHash).not.toContain(challenge.nonce);
      expect(persisted?.consumedAtMs).toBeNull();

      expect(() =>
        coordinator.approve({
          proposalId: proposal.id,
          proposalHash: proposal.hash,
          csrfToken: challenge.csrfToken,
          nonce: challenge.nonce,
          hashSuffix: challenge.requiredHashSuffix
        })
      ).toThrowError(LocalApprovalError);

      now.value += 1;
      expect(database.claimExecution(proposal.id, proposal.hash, now.value)).toBe(true);
      expect(database.claimExecution(proposal.id, proposal.hash, now.value)).toBe(false);
      expect(database.getLocalApproval(proposal.id)?.consumedAtMs).toBe(now.value);
    } finally {
      database.close();
    }
  });

  it("rejects wrong CSRF, nonce, hash, suffix, and expired challenges", () => {
    const now = { value: 2_100_000_000_000 };
    const database = new TradingDatabase(":memory:");
    try {
      const proposal = makeProposal(now.value);
      database.stageProposal(proposal);
      const coordinator = new LocalApprovalCoordinator({
        database,
        now: () => now.value,
        approvalTtlMs: 1_000
      });
      const challenge = coordinator.begin(proposal.id, proposal.hash);
      const base = {
        proposalId: proposal.id,
        proposalHash: proposal.hash,
        csrfToken: challenge.csrfToken,
        nonce: challenge.nonce,
        hashSuffix: challenge.requiredHashSuffix
      };

      expect(() =>
        coordinator.approve({ ...base, csrfToken: "x".repeat(43) })
      ).toThrowError(/CHALLENGE_MISMATCH/);
      expect(() =>
        coordinator.approve({ ...base, nonce: "y".repeat(43) })
      ).toThrowError(/CHALLENGE_MISMATCH/);
      expect(() =>
        coordinator.approve({ ...base, hashSuffix: "000000" })
      ).toThrowError(/HASH_MISMATCH/);
      expect(() =>
        coordinator.approve({
          ...base,
          proposalHash: "0".repeat(64)
        })
      ).toThrowError(/HASH_MISMATCH/);

      now.value += 1_001;
      expect(() => coordinator.approve(base)).toThrowError(/APPROVAL_EXPIRED/);
      expect(database.getProposal(proposal.id)?.status).toBe("EXPIRED");
      expect(database.getLocalApproval(proposal.id)).toBeNull();
    } finally {
      database.close();
    }
  });

  it("expires an interrupted local approval on database restart", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "poly-security-"));
    cleanupPaths.push(directory);
    const filename = path.join(directory, "trading.sqlite");
    const nowMs = Date.now();

    const first = new TradingDatabase(filename);
    const session = createTradingSession({
      executionMode: "live",
      authorizedBudgetMicros: 1_000_000n,
      nowMs: nowMs
    });
    first.saveTradingSession(session);
    const proposal = makeProposal(nowMs, session.id);
    first.stageProposal(proposal);
    const coordinator = new LocalApprovalCoordinator({ database: first });
    coordinator.begin(proposal.id, proposal.hash);
    first.close();

    const restarted = new TradingDatabase(filename);
    try {
      expect(restarted.getProposal(proposal.id)?.status).toBe("EXPIRED");
      expect(restarted.getLocalApproval(proposal.id)).toBeNull();
    } finally {
      restarted.close();
    }
  });

  it("preserves a submitted execution across restart without permitting replay", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "poly-restart-"));
    cleanupPaths.push(directory);
    const filename = path.join(directory, "trading.sqlite");
    const nowMs = Date.now();
    const orderId = `0x${"f".repeat(64)}`;

    const first = new TradingDatabase(filename);
    const session = createTradingSession({
      executionMode: "live",
      authorizedBudgetMicros: 1_000_000n,
      nowMs
    });
    first.saveTradingSession(session);
    const proposal = makeProposal(nowMs, session.id);
    first.stageProposal(proposal);
    first.transitionProposal(
      proposal.id,
      "STAGED",
      "AWAITING_LOCAL",
      nowMs + 1
    );
    first.transitionProposal(
      proposal.id,
      "AWAITING_LOCAL",
      "LOCALLY_APPROVED",
      nowMs + 2
    );
    first.recordLocalApproval({
      proposalId: proposal.id,
      proposalHash: proposal.hash,
      approvedAtMs: nowMs + 2,
      expiresAtMs: proposal.expiresAtMs,
      nonceHash: "restart-fixture-nonce",
      consumedAtMs: null
    });
    expect(first.claimExecution(proposal.id, proposal.hash, nowMs + 3)).toBe(
      true
    );
    first.markExecutionSubmitted({
      proposalId: proposal.id,
      proposalHash: proposal.hash,
      clobOrderId: orderId,
      status: "SUBMITTED_UNRECONCILED",
      submittedAtMs: nowMs + 4,
      responseJson: "{}"
    });
    first.close();

    const restarted = new TradingDatabase(filename);
    try {
      expect(restarted.getProposal(proposal.id)?.status).toBe("SUBMITTED");
      expect(restarted.getExecution(proposal.id)).toMatchObject({
        clobOrderId: orderId,
        status: "SUBMITTED_UNRECONCILED"
      });
      expect(
        restarted.claimExecution(proposal.id, proposal.hash, nowMs + 5)
      ).toBe(false);
      expect(
        restarted.updateExecutionStatus(
          proposal.id,
          "CANCELLED",
          JSON.stringify({ reviewedAfterRestart: true }),
          nowMs + 6
        )
      ).toBe(true);
    } finally {
      restarted.close();
    }

    const verified = new TradingDatabase(filename);
    try {
      expect(verified.getExecution(proposal.id)?.status).toBe("CANCELLED");
      expect(verified.verifyAuditChain()).toBe(true);
    } finally {
      verified.close();
    }
  });
});

describe.runIf(process.platform === "darwin")("MacOSKeychain process boundary", () => {
  it("sends a secret only through stdin, with no helper args or inherited secret env", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "poly-helper-"));
    cleanupPaths.push(directory);
    const helper = path.join(directory, "fake-helper");
    const report = path.join(directory, "report.json");
    const secret = randomBytes(32);
    const secretHash = createHash("sha256").update(secret).digest("hex");

    writeFileSync(
      helper,
      `#!${process.execPath}
const fs = require("node:fs");
const crypto = require("node:crypto");
const chunks = [];
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks);
  const headerLength = input.readUInt32BE(0);
  const payload = input.subarray(4 + headerLength);
  const digest = value => crypto.createHash("sha256").update(value).digest("hex");
  fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({
    argv: process.argv.slice(2),
    envValueHashes: Object.values(process.env).map(value => digest(value)),
    payloadHash: digest(payload)
  }));
  const header = Buffer.from(JSON.stringify({
    version: 1, ok: true, code: "OK", payloadLength: 0, exists: true
  }));
  const out = Buffer.alloc(4 + header.length);
  out.writeUInt32BE(header.length, 0);
  header.copy(out, 4);
  process.stdout.write(out);
});
`
    );
    chmodSync(helper, 0o700);

    const keychain = new MacOSKeychain({ helperPath: helper, timeoutMs: 5_000 });
    const bytes = Buffer.from(secret);
    await keychain.storeL2Credentials(bytes);
    bytes.fill(0);
    secret.fill(0);

    const captured = JSON.parse(readFileSync(report, "utf8")) as {
      argv: string[];
      envValueHashes: string[];
      payloadHash: string;
    };
    expect(captured.argv).toEqual([]);
    expect(captured.envValueHashes).not.toContain(secretHash);
    expect(captured.payloadHash).toBe(secretHash);
    expect(KEYCHAIN_SERVICE).toBe("codex-polymarket-guarded");
  });
});

function makeProposal(nowMs: number, sessionId = "session-security-test"): OrderProposal {
  const withoutHash: Omit<OrderProposal, "hash"> = {
    id: "proposal-security-test",
    status: "STAGED",
    createdAtMs: nowMs,
    expiresAtMs: nowMs + 90_000,
    intent: "ENTRY",
    sessionId,
    researchBundleId: null,
    executionMode: "live",
    market: {
      conditionId: "condition",
      tokenId: "123",
      eventId: "event",
      question: "Will the security test pass?",
      slug: "security-test",
      outcome: "Yes",
      category: "technology",
      rules: "The test passes only when all assertions complete successfully.",
      resolutionSource: "Test runner",
      endTimeMs: nowMs + 48 * 60 * 60_000,
      active: true,
      closed: false,
      acceptingOrders: true,
      negRisk: false,
      tickSizeMicros: 10_000n,
      minOrderSizeMicros: 1_000_000n,
      feesEnabled: false,
      feeRateBps: 0,
      bestBidMicros: 400_000n,
      bestAskMicros: 410_000n,
      spreadMicros: 10_000n,
      depthPusdMicrosAtLimit: 25_000_000n,
      bids: [],
      asks: [],
      capturedAtMs: nowMs
    },
    side: "BUY",
    sharesMicros: 1_000_000n,
    limitPriceMicros: 400_000n,
    maxCostMicros: 400_000n,
    maxLossMicros: 400_000n,
    estimatedFeeMicros: 0n,
    estimatedProbabilityMicros: 500_000n,
    expectedEdgeMicros: 100_000n,
    postTradeMarketExposureMicros: 400_000n,
    postTradeTotalExposureMicros: 400_000n,
    thesis: "Test thesis",
    counterThesis: "Test counter-thesis",
    sources: [],
    correlationKey: "security-test",
    policyVersion: RISK_POLICY_VERSION
  };
  const { status: _status, ...immutableHashMaterial } = withoutHash;
  return {
    ...withoutHash,
    hash: hashCanonical(immutableHashMaterial)
  };
}
