import { describe, expect, it } from "vitest";
import { configureShadowEnvironment } from "../src/cli/shadow-start.js";
import { shouldSkipSupervisorCycle } from "../src/runtime.js";

describe("shadow supervisor mode", () => {
  it("forces live off and isolates the shadow ledger", () => {
    const env: NodeJS.ProcessEnv = {
      POLYMARKET_LIVE_ENABLED: "true"
    };

    configureShadowEnvironment(env);

    expect(env.POLYMARKET_LIVE_ENABLED).toBe("false");
    expect(env.POLYMARKET_DB_PATH).toBe("./data/shadow.sqlite");
  });

  it("honors only the explicitly named shadow database override", () => {
    const env: NodeJS.ProcessEnv = {
      POLYMARKET_LIVE_ENABLED: "true",
      POLYMARKET_SHADOW_DB_PATH: "./data/test-shadow.sqlite"
    };

    configureShadowEnvironment(env);

    expect(env.POLYMARKET_LIVE_ENABLED).toBe("false");
    expect(env.POLYMARKET_DB_PATH).toBe("./data/test-shadow.sqlite");
  });

  it("continues public shadow/paper cycles while live is disabled", () => {
    expect(
      shouldSkipSupervisorCycle({
        liveEnabled: false,
        liveActivation: false,
        reconciliationRequired: false,
        emergencyStopped: true
      })
    ).toBe(false);
  });

  it("never skips a required live reconciliation in shadow configuration", () => {
    expect(
      shouldSkipSupervisorCycle({
        liveEnabled: false,
        liveActivation: false,
        reconciliationRequired: true,
        emergencyStopped: true
      })
    ).toBe(false);
  });

  it("keeps a locked live supervisor idle when no reconciliation is pending", () => {
    expect(
      shouldSkipSupervisorCycle({
        liveEnabled: true,
        liveActivation: false,
        reconciliationRequired: false,
        emergencyStopped: true
      })
    ).toBe(true);
  });

  it("keeps a healthy live supervisor running", () => {
    expect(
      shouldSkipSupervisorCycle({
        liveEnabled: true,
        liveActivation: true,
        reconciliationRequired: false,
        emergencyStopped: false
      })
    ).toBe(false);
  });
});
