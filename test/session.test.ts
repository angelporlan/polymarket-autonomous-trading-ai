import { describe, expect, it } from "vitest";
import {
  createTradingSession,
  isSessionValid,
  DEFAULT_SESSION_TTL_MS
} from "../src/domain/session.js";
import { PUSD_SCALE } from "../src/domain/types.js";

describe("TradingSession", () => {
  it("creates a valid active session with authorized budget", () => {
    const nowMs = Date.now();
    const session = createTradingSession({
      executionMode: "paper",
      authorizedBudgetMicros: 50n * PUSD_SCALE,
      nowMs
    });

    expect(session.id).toMatch(/^session_\d+_[a-f0-9-]+$/);
    expect(session.executionMode).toBe("paper");
    expect(session.authorizedBudgetMicros).toBe(50n * PUSD_SCALE);
    expect(session.remainingBudgetMicros).toBe(50n * PUSD_SCALE);
    expect(session.status).toBe("ACTIVE");
    expect(session.expiresAtMs).toBe(nowMs + DEFAULT_SESSION_TTL_MS);
  });

  it("rejects invalid budget authorization", () => {
    expect(() =>
      createTradingSession({
        executionMode: "live",
        authorizedBudgetMicros: 0n
      })
    ).toThrow("Authorized trading session budget must be positive.");
  });

  it("validates session remaining budget and expiration", () => {
    const nowMs = Date.now();
    const session = createTradingSession({
      executionMode: "live",
      authorizedBudgetMicros: 20n * PUSD_SCALE,
      nowMs
    });

    const validCheck = isSessionValid(session, 10n * PUSD_SCALE, nowMs);
    expect(validCheck.valid).toBe(true);

    const exceedCheck = isSessionValid(session, 30n * PUSD_SCALE, nowMs);
    expect(exceedCheck.valid).toBe(false);
    expect(exceedCheck.reason).toContain("Insufficient session budget");

    const expiredCheck = isSessionValid(session, 5n * PUSD_SCALE, nowMs + DEFAULT_SESSION_TTL_MS + 1000);
    expect(expiredCheck.valid).toBe(false);
    expect(expiredCheck.reason).toContain("has expired");
  });
});
