import {
  hashCanonical,
  verifyProposalHash
} from "../domain/proposals.js";
import type {
  MarketSnapshot,
  OrderProposal,
  PaperTrade
} from "../domain/types.js";
import type { TradingDatabase } from "../storage/database.js";
import {
  DEFAULT_PAPER_FILL_MODEL,
  PAPER_FILL_MODEL_VERSION,
  PaperSimulator,
  type PaperFillModel
} from "./simulator.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;
const MAX_BATCH_SIZE = 10_000;

export interface PaperSimulationCase {
  proposal: OrderProposal;
  snapshot: MarketSnapshot;
  model?: PaperFillModel;
}

export interface PaperSimulationReport {
  runId: string;
  modelVersion: typeof PAPER_FILL_MODEL_VERSION;
  firstSnapshotAtMs: number;
  lastSnapshotAtMs: number;
  coveredDurationMs: number;
  simulatedOperations: number;
  filledOperations: number;
  openOperations: number;
  totalRequestedSharesMicros: bigint;
  totalFilledSharesMicros: bigint;
  totalSlippageMicros: bigint;
  gateCoverageMet: boolean;
  trades: Array<{
    proposalId: string;
    tradeId: string;
    status: PaperTrade["status"];
    filledSharesMicros: bigint;
    snapshotHash: string;
    drawBps: number;
    fillProbabilityBps: number;
    slippageMicros: bigint;
  }>;
}

/**
 * Persists a deterministic paper batch. Every frame must carry the exact
 * snapshot embedded in its immutable proposal; this prevents a caller from
 * simulating against one book and reconciling against another.
 */
export class PaperSimulationRunner {
  constructor(
    private readonly database: TradingDatabase,
    private readonly simulator: PaperSimulator = new PaperSimulator()
  ) {}

  run(cases: readonly PaperSimulationCase[]): PaperSimulationReport {
    const frames = [...cases];
    validateCases(frames);
    for (const frame of frames) {
      if (
        this.database.getProposal(frame.proposal.id) !== null ||
        this.database.getPaperTradeByProposal(frame.proposal.id) !== null
      ) {
        throw new Error("Paper simulation cannot duplicate an existing proposal.");
      }
    }

    const runId = hashCanonical(
      frames.map((frame) => ({
        proposalId: frame.proposal.id,
        proposalHash: frame.proposal.hash,
        snapshotHash: hashCanonical(frame.snapshot),
        model: frame.model ?? DEFAULT_PAPER_FILL_MODEL
      }))
    );
    const prepared = frames.map((frame) => {
      const model = frame.model ?? DEFAULT_PAPER_FILL_MODEL;
      const trade = this.simulator.simulate(
        frame.proposal,
        frame.snapshot,
        model,
        hashCanonical({ runId, proposalId: frame.proposal.id }),
        frame.proposal.createdAtMs
      );
      return { frame, trade };
    });

    for (const { frame, trade } of prepared) {
      this.database.stageProposal(frame.proposal);
      this.database.savePaperTrade(trade);
      const simulated = this.database.transitionProposal(
        frame.proposal.id,
        "STAGED",
        "SIMULATED",
        trade.openedAtMs
      );
      if (simulated === null) {
        throw new Error("The paper proposal could not be marked simulated.");
      }
      const evidence = trade.simulation;
      if (evidence === undefined) {
        throw new Error("The paper simulation did not produce evidence.");
      }
      this.database.appendAudit("PAPER_SIMULATION_FRAME", trade.id, {
        runId,
        proposalId: frame.proposal.id,
        proposalHash: frame.proposal.hash,
        modelVersion: evidence.modelVersion,
        snapshotHash: evidence.snapshotHash,
        snapshotCapturedAtMs: evidence.snapshotCapturedAtMs,
        fillProbabilityBps: evidence.fillProbabilityBps,
        drawBps: evidence.drawBps,
        slippageBps: evidence.slippageBps,
        slippageMicros: evidence.slippageMicros
      });
    }

    const firstSnapshotAtMs = frames[0]!.snapshot.capturedAtMs;
    const lastSnapshotAtMs = frames.at(-1)!.snapshot.capturedAtMs;
    const totalRequestedSharesMicros = frames.reduce(
      (total, frame) => total + frame.proposal.sharesMicros,
      0n
    );
    const totalFilledSharesMicros = prepared.reduce(
      (total, entry) => total + entry.trade.filledSharesMicros,
      0n
    );
    const totalSlippageMicros = prepared.reduce(
      (total, entry) => total + (entry.trade.simulation?.slippageMicros ?? 0n),
      0n
    );

    return {
      runId,
      modelVersion: PAPER_FILL_MODEL_VERSION,
      firstSnapshotAtMs,
      lastSnapshotAtMs,
      coveredDurationMs: lastSnapshotAtMs - firstSnapshotAtMs,
      simulatedOperations: prepared.length,
      filledOperations: prepared.filter(
        (entry) => entry.trade.filledSharesMicros > 0n
      ).length,
      openOperations: prepared.filter(
        (entry) => entry.trade.status === "OPEN"
      ).length,
      totalRequestedSharesMicros,
      totalFilledSharesMicros,
      totalSlippageMicros,
      gateCoverageMet:
        prepared.length >= 50 &&
        lastSnapshotAtMs - firstSnapshotAtMs >= THIRTY_DAYS_MS,
      trades: prepared.map(({ frame, trade }) => {
        const evidence = trade.simulation!;
        return {
          proposalId: frame.proposal.id,
          tradeId: trade.id,
          status: trade.status,
          filledSharesMicros: trade.filledSharesMicros,
          snapshotHash: evidence.snapshotHash,
          drawBps: evidence.drawBps,
          fillProbabilityBps: evidence.fillProbabilityBps,
          slippageMicros: evidence.slippageMicros
        };
      })
    };
  }
}

function validateCases(cases: PaperSimulationCase[]): void {
  if (cases.length === 0 || cases.length > MAX_BATCH_SIZE) {
    throw new Error(`Paper simulation batches must contain 1 to ${MAX_BATCH_SIZE} cases.`);
  }
  const proposalIds = new Set<string>();
  let previousCreatedAtMs = 0;
  for (const frame of cases) {
    const proposal = frame.proposal;
    if (
      proposal.executionMode !== "paper" ||
      proposal.status !== "STAGED" ||
      !verifyProposalHash(proposal) ||
      proposalIds.has(proposal.id) ||
      !Number.isSafeInteger(proposal.createdAtMs) ||
      proposal.createdAtMs <= previousCreatedAtMs
    ) {
      throw new Error("Paper simulation cases must contain ordered intact paper proposals.");
    }
    if (
      proposal.market.conditionId !== frame.snapshot.conditionId ||
      proposal.market.tokenId !== frame.snapshot.tokenId ||
      hashCanonical(proposal.market) !== hashCanonical(frame.snapshot) ||
      !Number.isSafeInteger(frame.snapshot.capturedAtMs) ||
      frame.snapshot.capturedAtMs <= 0 ||
      frame.snapshot.capturedAtMs > proposal.createdAtMs ||
      proposal.createdAtMs - frame.snapshot.capturedAtMs > 5_000
    ) {
      throw new Error("Paper simulation snapshot does not match its proposal.");
    }
    if (frame.model !== undefined) {
      validateModel(frame.model);
    }
    proposalIds.add(proposal.id);
    previousCreatedAtMs = proposal.createdAtMs;
  }
}

function validateModel(model: PaperFillModel): void {
  if (
    !Number.isSafeInteger(model.fillProbabilityBps) ||
    model.fillProbabilityBps < 0 ||
    model.fillProbabilityBps > 10_000 ||
    !Number.isSafeInteger(model.slippageBps) ||
    model.slippageBps < 0 ||
    model.slippageBps > 10_000 ||
    typeof model.seed !== "string" ||
    model.seed.length === 0 ||
    model.seed.length > 128
  ) {
    throw new Error("Paper simulation model is invalid.");
  }
}
