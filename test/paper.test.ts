import { describe, expect, it } from "vitest";
import { createOrderProposal } from "../src/domain/proposals.js";
import { PUSD_SCALE } from "../src/domain/types.js";
import {
  evaluatePaperGate,
  PaperSimulator
} from "../src/paper/simulator.js";
import { intentFixture, riskContextFixture } from "./fixtures.js";

describe("paper simulator", () => {
  it("models only visible marketable liquidity", () => {
    const now = Date.now();
    const proposal = createOrderProposal(intentFixture(now), riskContextFixture(now));
    const trade = new PaperSimulator().tryImmediateFill(proposal, proposal.market);
    expect(trade.status).toBe("FILLED");
    expect(trade.filledSharesMicros).toBe(8n * PUSD_SCALE);
    expect(trade.averageFillPriceMicros).toBe(400_000n);
  });

  it("keeps a resting order open rather than granting a perfect fill", () => {
    const now = Date.now();
    const intent = intentFixture(now);
    intent.limitPriceMicros = 390_000n;
    intent.estimatedProbabilityMicros = 500_000n;
    const proposal = createOrderProposal(intent, riskContextFixture(now));
    const trade = new PaperSimulator().tryImmediateFill(proposal, proposal.market);
    expect(trade.status).toBe("OPEN");
    expect(trade.filledSharesMicros).toBe(0n);
  });
});

describe("paper gate", () => {
  it("passes only after duration, sample, profit and controls", () => {
    const now = Date.now();
    const result = evaluatePaperGate(
      {
        firstTradeAtMs: now - 31 * 24 * 60 * 60_000,
        totalTrades: 50,
        closedTrades: 25,
        netPnlMicros: 1n * PUSD_SCALE,
        maxDrawdownMicros: 9n * PUSD_SCALE,
        riskViolations: 0,
        reconciliationErrors: 0
      },
      now
    );
    expect(result).toEqual({ passed: true, reasons: [] });
  });

  it("marks the explicit override while preserving the unmet-gate reasons", () => {
    const result = evaluatePaperGate(
      {
        firstTradeAtMs: null,
        totalTrades: 0,
        closedTrades: 0,
        netPnlMicros: 0n,
        maxDrawdownMicros: 0n,
        riskViolations: 0,
        reconciliationErrors: 0
      },
      Date.now(),
      true
    );
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reasons[0]).toBe("PAPER_GATE_SKIPPED");
    expect(result.reasons).toContain("Fewer than 50 paper trades have been recorded.");
  });

  it("does not let the override hide paper risk or reconciliation failures", () => {
    const result = evaluatePaperGate(
      {
        firstTradeAtMs: null,
        totalTrades: 0,
        closedTrades: 0,
        netPnlMicros: 0n,
        maxDrawdownMicros: 0n,
        riskViolations: 1,
        reconciliationErrors: 1
      },
      Date.now(),
      true
    );
    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reasons).toContain("Risk violations were recorded during paper trading.");
    expect(result.reasons).toContain("Paper ledger reconciliation errors remain.");
  });
});
