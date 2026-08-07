import { describe, expect, it } from "vitest";
import { createOrderProposal } from "../src/domain/proposals.js";
import type {
  LocalApproval,
  OrderProposal
} from "../src/domain/types.js";
import { TradingDatabase } from "../src/storage/database.js";
import { stringifyWithBigInts } from "../src/storage/codec.js";
import { intentFixture, riskContextFixture } from "./fixtures.js";

describe("TradingDatabase", () => {
  it("persists a proposal and enforces one-shot execution", () => {
    const database = new TradingDatabase(":memory:");
    const now = Date.now();
    const proposal = createOrderProposal(intentFixture(now), riskContextFixture(now));
    database.stageProposal(proposal);

    expect(database.getProposal(proposal.id)?.hash).toBe(proposal.hash);
    expect(
      database.transitionProposal(
        proposal.id,
        "STAGED",
        "AWAITING_LOCAL",
        now + 1
      )?.status
    ).toBe("AWAITING_LOCAL");
    expect(
      database.transitionProposal(
        proposal.id,
        "AWAITING_LOCAL",
        "LOCALLY_APPROVED",
        now + 2
      )?.status
    ).toBe("LOCALLY_APPROVED");

    const approval: LocalApproval = {
      proposalId: proposal.id,
      proposalHash: proposal.hash,
      approvedAtMs: now + 2,
      expiresAtMs: proposal.expiresAtMs,
      nonceHash: "nonce-hash",
      consumedAtMs: null
    };
    database.recordLocalApproval(approval);
    expect(database.claimExecution(proposal.id, proposal.hash, now + 3)).toBe(true);
    expect(database.claimExecution(proposal.id, proposal.hash, now + 4)).toBe(false);
    expect(database.verifyAuditChain()).toBe(true);
    database.close();
  });

  it("stores the emergency stop as sticky state", () => {
    const database = new TradingDatabase(":memory:");
    database.setEmergencyStop(true, "test");
    expect(database.getEmergencyStop()).toMatchObject({
      active: true,
      reason: "test"
    });
    database.close();
  });

  it("promotes the canary only with reconciled confirmed fills after baseline", () => {
    const database = new TradingDatabase(":memory:");
    const now = Date.now();
    database.resetCanaryProgress("ACCOUNT_CHANGED", now);

    const cancelledOrderId = `0x${"c".repeat(64)}`;
    const cancelled = submittedLiveProposal(
      database,
      now + 1,
      cancelledOrderId
    );
    database.updateExecutionStatus(
      cancelled.id,
      "CANCELLED",
      JSON.stringify({
        order: reconciledOrder(
          cancelled,
          cancelledOrderId,
          "CANCELLED",
          "0"
        ),
        trades: []
      }),
      now + 2
    );
    expect(database.countCanaryEligibleExecutions()).toBe(0);

    for (let index = 0; index < 10; index += 1) {
      const proposal = submittedLiveProposal(
        database,
        now + 10 + index,
        `0x${(index + 1).toString(16).padStart(64, "0")}`
      );
      const orderId = `0x${(index + 1)
        .toString(16)
        .padStart(64, "0")}`;
      const transactionHash = `0x${(index + 101)
        .toString(16)
        .padStart(64, "0")}`;
      database.updateExecutionStatus(
        proposal.id,
        "CONFIRMED",
        stringifyWithBigInts({
          order: reconciledOrder(
            proposal,
            orderId,
            "MATCHED",
            proposal.sharesMicros.toString()
          ),
          localOrder: {
            orderHash: orderId,
            metadata: `0x${proposal.hash}`,
            builder: `0x${"00".repeat(32)}`,
            expiration: Math.floor((now + 10 + index) / 1_000) + 960,
            timestampMs: now + 10 + index,
            makerAmountMicros:
              proposal.side === "BUY"
                ? proposal.maxCostMicros
                : proposal.sharesMicros,
            takerAmountMicros:
              proposal.side === "BUY"
                ? proposal.sharesMicros
                : proposal.maxCostMicros
          },
          trades: [
            {
              id: `trade-${index}`,
              status: "CONFIRMED",
              transactionHash
            }
          ],
          attributedTrades: [
            {
              tradeId: `trade-${index}`,
              status: "CONFIRMED",
              role: "TAKER",
              sharesMicros: proposal.sharesMicros,
              priceMicros: proposal.limitPriceMicros,
              transactionHash,
              lastUpdateMs: now + 50 + index
            }
          ],
          onchain: {
            finalized: true,
            filledSharesMicros: proposal.sharesMicros,
            grossCostMicros: proposal.maxCostMicros,
            feeMicros: 0n,
            transactionHashes: [transactionHash],
            blockNumbers: [100n],
            blockHashes: [`0x${"b".repeat(64)}`],
            blockTimestampsMs: [now + 50 + index]
          }
        }),
        now + 100 + index
      );
    }

    expect(database.countCanaryEligibleExecutions()).toBe(10);
    database.setEmergencyStop(true, "CONTROLLED_INCIDENT", now + 500);
    expect(database.countCanaryEligibleExecutions()).toBe(0);
    database.setEmergencyStop(false, "REVIEWED", now + 501);
    database.resetCanaryProgress("INCIDENT_REVIEWED", now + 502);
    expect(database.countCanaryEligibleExecutions()).toBe(0);
    database.close();
  });
});

function submittedLiveProposal(
  database: TradingDatabase,
  nowMs: number,
  orderId: string
): OrderProposal {
  const intent = intentFixture(nowMs);
  intent.executionMode = "live";
  const proposal = createOrderProposal(intent, riskContextFixture(nowMs));
  database.stageProposal(proposal);
  database.transitionProposal(
    proposal.id,
    "STAGED",
    "AWAITING_LOCAL",
    nowMs + 1
  );
  database.transitionProposal(
    proposal.id,
    "AWAITING_LOCAL",
    "LOCALLY_APPROVED",
    nowMs + 2
  );
  database.recordLocalApproval({
    proposalId: proposal.id,
    proposalHash: proposal.hash,
    approvedAtMs: nowMs + 2,
    expiresAtMs: proposal.expiresAtMs,
    nonceHash: `nonce-${orderId}`,
    consumedAtMs: null
  });
  expect(database.claimExecution(proposal.id, proposal.hash, nowMs + 3)).toBe(
    true
  );
  database.markExecutionSubmitted({
    proposalId: proposal.id,
    proposalHash: proposal.hash,
    clobOrderId: orderId,
    status: "SUBMITTED_UNRECONCILED",
    submittedAtMs: nowMs + 4,
    responseJson: "{}"
  });
  return database.getProposal(proposal.id)!;
}

function reconciledOrder(
  proposal: OrderProposal,
  orderId: string,
  status: string,
  sizeMatched: string
): Record<string, string> {
  return {
    id: orderId,
    status,
    originalSize: proposal.sharesMicros.toString(),
    sizeMatched,
    market: proposal.market.conditionId,
    assetId: proposal.market.tokenId,
    side: proposal.side
  };
}
