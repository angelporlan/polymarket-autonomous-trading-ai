import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const PROFILE = `0x${"a".repeat(40)}`;

describe("runtime configuration", () => {
  it("keeps live disabled with a single public Polygon RPC", () => {
    expect(
      loadConfig({
        POLYMARKET_PROFILE_ADDRESS: PROFILE,
        POLYMARKET_LIVE_ENABLED: "false",
        POLYGON_RPC_URL: "https://polygon-rpc.example"
      }).polygonRpcUrls
    ).toEqual(["https://polygon-rpc.example/"]);
  });

  it("requires two distinct credential-free origins for live", () => {
    expect(() =>
      loadConfig({
        POLYMARKET_PROFILE_ADDRESS: PROFILE,
        POLYMARKET_LIVE_ENABLED: "true",
        POLYGON_RPC_URLS: "https://rpc-one.example,https://rpc-one.example"
      })
    ).toThrow();
    expect(
      loadConfig({
        POLYMARKET_PROFILE_ADDRESS: PROFILE,
        POLYMARKET_LIVE_ENABLED: "true",
        POLYGON_RPC_URLS: "https://rpc-one.example,https://rpc-two.example"
      }).polygonRpcUrls
    ).toHaveLength(2);
  });

  it("only enables the explicit paper-gate override when set to true", () => {
    expect(
      loadConfig({
        POLYMARKET_PROFILE_ADDRESS: PROFILE,
        PAPER_GATE_SKIP: "true"
      }).paperGateSkip
    ).toBe(true);
    expect(
      loadConfig({
        POLYMARKET_PROFILE_ADDRESS: PROFILE,
        PAPER_GATE_SKIP: "false"
      }).paperGateSkip
    ).toBe(false);
  });

  it("rejects RPC URLs that could persist credentials", () => {
    for (const url of [
      "https://user:secret@rpc.example",
      "https://rpc.example/key-like-path",
      "https://rpc.example/?key=secret",
      "https://rpc.example/#secret",
      "http://rpc.example"
    ]) {
      expect(() =>
        loadConfig({
          POLYMARKET_PROFILE_ADDRESS: PROFILE,
          POLYGON_RPC_URL: url
        })
      ).toThrow();
    }
  });
});
