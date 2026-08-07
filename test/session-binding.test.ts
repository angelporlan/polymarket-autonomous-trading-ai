import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createOrderProposal } from "../src/domain/proposals.js";
import { createTradingSession } from "../src/domain/session.js";
import { PUSD_SCALE } from "../src/domain/types.js";
import { TradingDatabase } from "../src/storage/database.js";
import { intentFixture, riskContextFixture } from "./fixtures.js";

const NOW_MS = Date.parse("2026-07-23T12:00:00.000Z");

describe("autonomous proposal/session binding", () => {
  it("blocks a proposal from session A after A is closed and session B is active, including after restart", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "polymarket-session-binding-"));
    const filename = path.join(directory, "trading.sqlite");
    try {
      const first = new TradingDatabase(filename);
      const sessionA = createTradingSession({
        executionMode: "live",
        authorizedBudgetMicros: 10n * PUSD_SCALE,
        nowMs: NOW_MS
      });
      first.saveTradingSession(sessionA);
      const intent = intentFixture(NOW_MS);
      intent.executionMode = "live";
      intent.sessionId = sessionA.id;
      const proposal = createOrderProposal(intent, riskContextFixture(NOW_MS));
      first.stageProposal(proposal);
      first.close();

      const restarted = new TradingDatabase(filename);
      restarted.closeTradingSession(sessionA.id, "rotate-session", NOW_MS + 1);
      const sessionB = createTradingSession({
        executionMode: "live",
        authorizedBudgetMicros: 10n * PUSD_SCALE,
        nowMs: NOW_MS + 2
      });
      restarted.saveTradingSession(sessionB);

      expect(
        restarted.claimAutonomousExecution(
          proposal.id,
          proposal.hash,
          sessionB.id,
          NOW_MS + 3
        )
      ).toBe(false);
      expect(restarted.getProposal(proposal.id)?.status).toBe("STAGED");
      expect(restarted.getExecution(proposal.id)).toBeNull();
      expect(restarted.getTradingSession(sessionB.id)?.remainingBudgetMicros).toBe(
        sessionB.authorizedBudgetMicros
      );
      expect(restarted.verifyAuditChain()).toBe(true);
      restarted.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reserves maxLoss including fees and blocks when the session budget is insufficient", () => {
    const database = new TradingDatabase(":memory:");
    const session = createTradingSession({
      executionMode: "live",
      authorizedBudgetMicros: 4n * PUSD_SCALE,
      nowMs: NOW_MS
    });
    database.saveTradingSession(session);
    const intent = intentFixture(NOW_MS);
    intent.executionMode = "live";
    intent.sessionId = session.id;
    intent.market = {
      ...intent.market,
      feesEnabled: true,
      feeRateBps: 100
    };
    const proposal = createOrderProposal(intent, riskContextFixture(NOW_MS));
    expect(proposal.maxLossMicros).toBeGreaterThan(4n * PUSD_SCALE);
    database.stageProposal(proposal);

    expect(
      database.claimAutonomousExecution(
        proposal.id,
        proposal.hash,
        session.id,
        NOW_MS + 1
      )
    ).toBe(false);
    expect(database.getProposal(proposal.id)?.status).toBe("STAGED");
    expect(database.getTradingSession(session.id)?.remainingBudgetMicros).toBe(
      session.authorizedBudgetMicros
    );
    expect(database.getExecution(proposal.id)).toBeNull();
    database.close();
  });

  it("allows an EXIT without an active entry session and without consuming entry budget", () => {
    const database = new TradingDatabase(":memory:");
    const intent = intentFixture(NOW_MS);
    intent.executionMode = "live";
    intent.intent = "EXIT";
    intent.sessionId = null;
    intent.side = "SELL";
    intent.exitReason = "EDGE_DISAPPEARED";
    intent.sharesMicros = 1n * PUSD_SCALE;
    intent.limitPriceMicros = 390_000n;
    intent.estimatedProbabilityMicros = 300_000n;
    const proposal = createOrderProposal(intent, {
      ...riskContextFixture(NOW_MS),
      heldSharesMicros: 2n * PUSD_SCALE
    });
    database.stageProposal(proposal, 2n * PUSD_SCALE);

    expect(
      database.claimAutonomousExecution(proposal.id, proposal.hash, null, NOW_MS + 1)
    ).toBe(true);
    expect(database.getProposal(proposal.id)?.status).toBe("EXECUTING");
    expect(database.getExecution(proposal.id)?.status).toBe("CLAIMED");
    database.close();
  });

  it("permits only one atomic claim for the same proposal", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "polymarket-claim-race-"));
    const filename = path.join(directory, "trading.sqlite");
    const first = new TradingDatabase(filename);
    const second = new TradingDatabase(filename);
    try {
      const session = createTradingSession({
        executionMode: "live",
        authorizedBudgetMicros: 10n * PUSD_SCALE,
        nowMs: NOW_MS
      });
      first.saveTradingSession(session);
      const intent = intentFixture(NOW_MS);
      intent.executionMode = "live";
      intent.sessionId = session.id;
      const proposal = createOrderProposal(intent, riskContextFixture(NOW_MS));
      first.stageProposal(proposal);

      expect(
        first.claimAutonomousExecution(
          proposal.id,
          proposal.hash,
          session.id,
          NOW_MS + 1
        )
      ).toBe(true);
      expect(
        second.claimAutonomousExecution(
          proposal.id,
          proposal.hash,
          session.id,
          NOW_MS + 2
        )
      ).toBe(false);
      expect(second.countAuditEvents("AUTONOMOUS_EXECUTION_CLAIMED")).toBe(1);
      expect(second.getExecution(proposal.id)?.status).toBe("CLAIMED");
      expect(second.getTradingSession(session.id)?.remainingBudgetMicros).toBe(
        session.authorizedBudgetMicros - proposal.maxLossMicros
      );
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
