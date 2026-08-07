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

  it("still requires minimum edge for ENTRY orders", () => {
    const now = Date.now();
    const intent = intentFixture(now);
    intent.estimatedProbabilityMicros = 440_000n;
    const result = evaluateOrderRisk(intent, riskContextFixture(now));
    expect(result.violations.map((violation) => violation.code)).toContain(
      "EDGE_TOO_SMALL"
    );
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
    intent.intent = "EXIT";
    intent.side = "SELL";
    intent.exitReason = "EDGE_DISAPPEARED";
    intent.estimatedProbabilityMicros = 300_000n;
    const result = evaluateOrderRisk(intent, riskContextFixture(now));
    expect(result.violations.map((violation) => violation.code)).toContain(
      "SELL_EXCEEDS_POSITION"
    );
  });

  it("keeps reduce-only EXIT available during entry risk stops", () => {
    const now = Date.now();
    const intent = intentFixture(now);
    intent.intent = "EXIT";
    intent.side = "SELL";
    intent.exitReason = "STOP_LOSS_TRIGGERED";
    intent.limitPriceMicros = 390_000n;
    intent.market.spreadMicros = 40_000n;
    const result = evaluateOrderRisk(intent, {
      ...riskContextFixture(now),
      heldSharesMicros: intent.sharesMicros,
      dailyPnlMicros: -10n * PUSD_SCALE,
      dailyPnlKnown: false,
      coolingDownUntilMs: now + 86_400_000
    });
    expect(result.violations.map((violation) => violation.code)).not.toEqual(
      expect.arrayContaining(["DAILY_STOP", "DAILY_PNL_UNAVAILABLE", "COOLING_DOWN", "SPREAD_TOO_WIDE"])
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
    expect(proposal.intent).toBe("ENTRY");
    expect(
      verifyProposalHash({ ...proposal, thesis: `${proposal.thesis} changed` })
    ).toBe(false);
    expect(verifyProposalHash({ ...proposal, intent: "EXIT" })).toBe(false);
  });

  it("preserves EXIT intent and allows an exit without entry edge", () => {
    const now = Date.now();
    const intent = intentFixture(now);
    intent.intent = "EXIT";
    intent.side = "SELL";
    intent.exitReason = "STOP_LOSS_TRIGGERED";
    intent.estimatedProbabilityMicros = 500_000n;

    const context = {
      ...riskContextFixture(now),
      heldSharesMicros: intent.sharesMicros
    };
    const proposal = createOrderProposal(intent, context);

    expect(proposal.intent).toBe("EXIT");
    expect(proposal.exitReason).toBe("STOP_LOSS_TRIGGERED");
    expect(proposal.expectedEdgeMicros).toBe(-100_000n);
    expect(verifyProposalHash(proposal)).toBe(true);
  });

  it("rejects incoherent intent and side or a missing exit reason", () => {
    const now = Date.now();
    const entrySell = intentFixture(now);
    entrySell.side = "SELL";
    expect(
      evaluateOrderRisk(entrySell, riskContextFixture(now)).violations.map(
        (violation) => violation.code
      )
    ).toContain("INVALID_ORDER_INTENT");

    const exitWithoutReason = intentFixture(now);
    exitWithoutReason.intent = "EXIT";
    exitWithoutReason.side = "SELL";
    expect(
      evaluateOrderRisk(exitWithoutReason, {
        ...riskContextFixture(now),
        heldSharesMicros: exitWithoutReason.sharesMicros
      }).violations.map((violation) => violation.code)
    ).toContain("INVALID_ORDER_INTENT");
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
