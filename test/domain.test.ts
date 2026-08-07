import { describe, expect, it } from "vitest";
import {
  createOrderProposal,
  ProposalRejectedError,
  verifyProposalHash
} from "../src/domain/proposals.js";
import {
  estimateMaximumTakerFeeMicros,
  estimateTakerFeeMicros,
  evaluateOrderRisk
} from "../src/domain/risk-policy.js";
import {
  formatMicros,
  parseDecimalToMicros,
  PUSD_SCALE
} from "../src/domain/types.js";
import { intentFixture, riskContextFixture } from "./fixtures.js";

describe("decimal helpers", () => {
  it("round-trips pUSD micros without floating point", () => {
    expect(parseDecimalToMicros("10.123456")).toBe(10_123_456n);
    expect(formatMicros(10_123_456n)).toBe("10.123456");
    expect(formatMicros(-500_000n)).toBe("-0.5");
  });

  it("rejects excessive decimal precision", () => {
    expect(() => parseDecimalToMicros("0.1234567")).toThrow();
  });
});

describe("risk evaluation", () => {
  it("accepts a compliant canary order", () => {
    const now = Date.now();
    const result = evaluateOrderRisk(intentFixture(now), riskContextFixture(now));
    expect(result.violations).toEqual([]);
    expect(result.maxCostMicros).toBe(4n * PUSD_SCALE);
    expect(result.expectedEdgeMicros).toBe(100_000n);
  });

  it("enforces the canary limit and then the pilot limit", () => {
    const now = Date.now();
    const intent = intentFixture(now);
    intent.sharesMicros = 20n * PUSD_SCALE;

    const canary = evaluateOrderRisk(intent, riskContextFixture(now));
    expect(canary.violations.map((violation) => violation.code)).toContain(
      "ORDER_TOO_LARGE"
    );

    const pilotContext = { ...riskContextFixture(now), liveTradeCount: 10 };
    const pilot = evaluateOrderRisk(intent, pilotContext);
    expect(pilot.violations.map((violation) => violation.code)).not.toContain(
      "ORDER_TOO_LARGE"
    );
  });

  it("stops after the daily loss threshold", () => {
    const now = Date.now();
    const context = {
      ...riskContextFixture(now),
      dailyPnlMicros: -10n * PUSD_SCALE
    };
    const result = evaluateOrderRisk(intentFixture(now), context);
    expect(result.violations.map((violation) => violation.code)).toContain(
      "DAILY_STOP"
    );
  });

  it("prevents selling more than the settled position", () => {
    const now = Date.now();
    const intent = intentFixture(now);
    intent.side = "SELL";
    intent.estimatedProbabilityMicros = 300_000n;
    const result = evaluateOrderRisk(intent, riskContextFixture(now));
    expect(result.violations.map((violation) => violation.code)).toContain(
      "SELL_EXCEEDS_POSITION"
    );
  });

  it("reserves the maximum fee over the executable price interval", () => {
    const shares = 100n * PUSD_SCALE;
    expect(
      estimateMaximumTakerFeeMicros(
        shares,
        900_000n,
        "BUY",
        400,
        1
      )
    ).toBe(1n * PUSD_SCALE);
    expect(
      estimateMaximumTakerFeeMicros(
        shares,
        100_000n,
        "SELL",
        400,
        1
      )
    ).toBe(1n * PUSD_SCALE);
    expect(estimateTakerFeeMicros(shares, 900_000n, 400, 1)).toBe(
      360_000n
    );
  });
});

describe("proposals", () => {
  it("hashes the complete immutable proposal", () => {
    const now = Date.now();
    const proposal = createOrderProposal(intentFixture(now), riskContextFixture(now));
    expect(verifyProposalHash(proposal)).toBe(true);
    expect(
      verifyProposalHash({ ...proposal, thesis: `${proposal.thesis} changed` })
    ).toBe(false);
  });

  it("throws a structured rejection when policy fails", () => {
    const now = Date.now();
    const intent = intentFixture(now);
    intent.market.spreadMicros = 40_000n;
    expect(() =>
      createOrderProposal(intent, riskContextFixture(now))
    ).toThrow(ProposalRejectedError);
  });
});
