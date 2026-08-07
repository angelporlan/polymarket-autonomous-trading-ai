import { describe, expect, it } from "vitest";
import { createOrderProposal } from "../src/domain/proposals.js";
import { PUSD_SCALE } from "../src/domain/types.js";
import { TradingDatabase } from "../src/storage/database.js";
import {
  PaperSimulationRunner,
  type PaperSimulationCase
} from "../src/paper/simulation-runner.js";
import {
  PaperSimulator,
  simulatePaperFill
} from "../src/paper/simulator.js";
import {
  intentFixture,
  riskContextFixture
} from "./fixtures.js";

const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60_000;
const BASE_MS = 1_800_000_000_000 - THIRTY_ONE_DAYS_MS;

describe("reproducible paper simulation", () => {
  it("models probability and slippage deterministically", () => {
    const intent = intentFixture(BASE_MS);
    intent.limitPriceMicros = 410_000n;
    const proposal = createOrderProposal(
      intent,
      riskContextFixture(BASE_MS)
    );

    const noFill = simulatePaperFill(proposal, proposal.market, {
      fillProbabilityBps: 0,
      slippageBps: 25,
      seed: "fixture-model"
    });
    expect(noFill.filledSharesMicros).toBe(0n);
    expect(noFill.averageFillPriceMicros).toBeNull();
    expect(noFill.evidence.drawBps).toBeGreaterThanOrEqual(0);
    expect(noFill.evidence.drawBps).toBeLessThan(10_000);

    const filled = simulatePaperFill(proposal, proposal.market, {
      fillProbabilityBps: 10_000,
      slippageBps: 25,
      seed: "fixture-model"
    });
    expect(filled.filledSharesMicros).toBe(10n * PUSD_SCALE);
    expect(filled.averageFillPriceMicros).toBe(403_005n);
    expect(filled.evidence.slippageMicros).toBe(1_005n);
    expect(simulatePaperFill(proposal, proposal.market, {
      fillProbabilityBps: 10_000,
      slippageBps: 25,
      seed: "fixture-model"
    })).toEqual(filled);
  });

  it("runs 50 ordered snapshots over more than 30 days and audits every frame", () => {
    const cases = createCases();
    const firstDatabase = new TradingDatabase(":memory:");
    const firstReport = new PaperSimulationRunner(
      firstDatabase,
      new PaperSimulator(() => BASE_MS)
    ).run(cases);

    expect(firstReport.simulatedOperations).toBe(50);
    expect(firstReport.filledOperations).toBe(50);
    expect(firstReport.openOperations).toBe(0);
    expect(firstReport.coveredDurationMs).toBe(THIRTY_ONE_DAYS_MS);
    expect(firstReport.gateCoverageMet).toBe(true);
    expect(firstReport.totalSlippageMicros).toBe(50n * 1_005n);
    expect(firstDatabase.countAuditEvents("PAPER_SIMULATION_FRAME")).toBe(50);
    expect(firstDatabase.verifyAuditChain()).toBe(true);
    expect(firstDatabase.listPaperTrades()).toHaveLength(50);

    const secondDatabase = new TradingDatabase(":memory:");
    const secondReport = new PaperSimulationRunner(
      secondDatabase,
      new PaperSimulator(() => BASE_MS)
    ).run(cases);
    expect(secondReport.runId).toBe(firstReport.runId);
    expect(secondReport.trades.map((trade) => trade.tradeId)).toEqual(
      firstReport.trades.map((trade) => trade.tradeId)
    );
    expect(() =>
      new PaperSimulationRunner(
        firstDatabase,
        new PaperSimulator(() => BASE_MS)
      ).run(cases)
    ).toThrow(/duplicate/u);
    firstDatabase.close();
    secondDatabase.close();
  });

  it("fails closed when a frame snapshot differs from its proposal", () => {
    const cases = createCases();
    cases[0] = {
      ...cases[0]!,
      snapshot: {
        ...cases[0]!.snapshot,
        capturedAtMs: cases[0]!.snapshot.capturedAtMs + 1
      }
    };
    const database = new TradingDatabase(":memory:");
    expect(() => new PaperSimulationRunner(database).run(cases)).toThrow(
      /snapshot does not match/u
    );
    expect(database.listProposals()).toHaveLength(0);
    database.close();
  });
});

function createCases(): PaperSimulationCase[] {
  const cases: PaperSimulationCase[] = [];
  for (let index = 0; index < 50; index += 1) {
    const createdAtMs =
      BASE_MS + Math.floor((THIRTY_ONE_DAYS_MS * index) / 49);
    const intent = intentFixture(createdAtMs);
    intent.limitPriceMicros = 410_000n;
    intent.market.endTimeMs = createdAtMs + 40 * 24 * 60 * 60_000;
    const proposal = createOrderProposal(
      intent,
      riskContextFixture(createdAtMs)
    );
    cases.push({
      proposal,
      snapshot: proposal.market,
      model: {
        fillProbabilityBps: 10_000,
        slippageBps: 25,
        seed: "fixture-batch"
      }
    });
  }
  return cases;
}
