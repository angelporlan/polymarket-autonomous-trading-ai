import { describe, expect, it } from "vitest";
import {
  PolymarketPublicClient,
  type PublicFetch
} from "../src/polymarket/public-client.js";

const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1_000;
const PROFILE_ADDRESS = `0x${"a".repeat(40)}`;
const OTHER_PROFILE_ADDRESS = `0x${"b".repeat(40)}`;
const CONDITION_ID = `0x${"1".repeat(64)}`;

describe("public trade activity", () => {
  it("uses a closed, ascending TRADE window and returns an exact DTO", async () => {
    const requestedUrls: URL[] = [];
    const sinceMs = NOW_MS - 1_234;
    const expectedStart = Math.floor(sinceMs / 1_000);
    const client = activityClient((url) => {
      requestedUrls.push(url);
      return [
        tradeActivity(1, expectedStart, {
          proxyWallet: PROFILE_ADDRESS.toUpperCase().replace("0X", "0x"),
          transactionHash: `0x${"A".repeat(64)}`,
          conditionId: `0x${"B".repeat(64)}`,
          size: "2.123456",
          price: "0.4",
          usdcSize: "0.8493824"
        })
      ];
    });

    await expect(
      client.getUserActivity(PROFILE_ADDRESS, sinceMs)
    ).resolves.toEqual([
      {
        profileAddress: PROFILE_ADDRESS,
        transactionHash: `0x${"a".repeat(64)}`,
        conditionId: `0x${"b".repeat(64)}`,
        tokenId: "1000001",
        side: "BUY",
        timestampMs: expectedStart * 1_000,
        sizeMicros: 2_123_456n,
        priceMicros: 400_000n,
        notionalMicros: 849_382n
      }
    ]);

    expect(requestedUrls).toHaveLength(1);
    const query = requestedUrls[0]!.searchParams;
    expect(requestedUrls[0]!.pathname).toBe("/activity");
    expect(query.get("user")).toBe(PROFILE_ADDRESS);
    expect(query.get("type")).toBe("TRADE");
    expect(query.get("start")).toBe(String(expectedStart));
    expect(query.get("end")).toBe(String(NOW_SECONDS));
    expect(query.get("sortBy")).toBe("TIMESTAMP");
    expect(query.get("sortDirection")).toBe("ASC");
    expect(query.get("limit")).toBe("500");
    expect(query.get("offset")).toBe("0");
  });

  it("paginates with stable offsets until a short page", async () => {
    const offsets: number[] = [];
    const timestamp = NOW_SECONDS - 5;
    const client = activityClient((url) => {
      const offset = Number(url.searchParams.get("offset"));
      offsets.push(offset);
      return offset === 0
        ? Array.from({ length: 500 }, (_, index) =>
            tradeActivity(index, timestamp)
          )
        : [tradeActivity(500, timestamp + 1)];
    });

    const result = await client.getUserActivity(
      PROFILE_ADDRESS,
      timestamp * 1_000
    );

    expect(offsets).toEqual([0, 500]);
    expect(result).toHaveLength(501);
    expect(result.at(-1)?.transactionHash).toBe(transactionHash(500));
  });

  it("continues beyond the offset cap at a lossless timestamp boundary", async () => {
    const initialStart = NOW_SECONDS - 20;
    const boundary = initialStart + 10;
    const requests: Array<{ start: number; offset: number }> = [];
    const client = activityClient((url) => {
      const start = Number(url.searchParams.get("start"));
      const offset = Number(url.searchParams.get("offset"));
      requests.push({ start, offset });
      if (start === initialStart) {
        return Array.from({ length: 500 }, (_, pageIndex) => {
          const index = offset + pageIndex;
          return tradeActivity(
            index,
            index < 5_000
              ? initialStart + Math.floor(index / 500)
              : boundary
          );
        });
      }
      if (start === boundary && offset === 0) {
        return Array.from({ length: 500 }, (_, index) =>
          tradeActivity(5_000 + index, boundary)
        );
      }
      if (start === boundary && offset === 500) {
        return [tradeActivity(5_500, boundary + 1)];
      }
      throw new Error(`Unexpected activity request start=${start} offset=${offset}.`);
    });

    const result = await client.getUserActivity(
      PROFILE_ADDRESS,
      initialStart * 1_000
    );

    expect(result).toHaveLength(5_501);
    expect(new Set(result.map((row) => row.transactionHash)).size).toBe(5_501);
    expect(requests.at(-2)).toEqual({ start: boundary, offset: 0 });
    expect(requests.at(-1)).toEqual({ start: boundary, offset: 500 });
  });

  it("fails closed when more rows share a second than the offset cap can prove", async () => {
    const start = NOW_SECONDS - 1;
    const client = activityClient((url) => {
      const offset = Number(url.searchParams.get("offset"));
      return Array.from({ length: 500 }, (_, index) =>
        tradeActivity(offset + index, start)
      );
    });

    await expect(
      client.getUserActivity(PROFILE_ADDRESS, start * 1_000)
    ).rejects.toMatchObject({ code: "ACTIVITY_RESPONSE_TRUNCATED" });
  });

  it.each([
    {
      label: "object top level",
      payload: { activity: [] },
      code: "INVALID_ACTIVITY_RESPONSE"
    },
    {
      label: "oversized page",
      payload: Array.from({ length: 501 }, (_, index) =>
        tradeActivity(index, NOW_SECONDS)
      ),
      code: "INVALID_ACTIVITY_RESPONSE"
    },
    {
      label: "repeated page",
      payload: Array.from({ length: 500 }, (_, index) =>
        tradeActivity(index, NOW_SECONDS)
      ),
      code: "ACTIVITY_RESPONSE_TRUNCATED"
    }
  ])("rejects a $label", async ({ payload, code }) => {
    const client = activityClient(() => payload);

    await expect(
      client.getUserActivity(PROFILE_ADDRESS, NOW_MS - 1_000)
    ).rejects.toMatchObject({ code });
  });

  it.each([
    {
      label: "different proxy wallet",
      override: { proxyWallet: OTHER_PROFILE_ADDRESS }
    },
    {
      label: "invalid transaction hash",
      override: { transactionHash: "0x1234" }
    },
    {
      label: "invalid condition ID",
      override: { conditionId: "condition-1" }
    },
    {
      label: "unsafe asset",
      override: { asset: "token with spaces" }
    },
    {
      label: "non-TRADE row",
      override: { type: "REDEEM" }
    },
    {
      label: "invalid side",
      override: { side: "HOLD" }
    },
    {
      label: "string timestamp",
      override: { timestamp: String(NOW_SECONDS) }
    },
    {
      label: "timestamp outside the requested window",
      override: { timestamp: NOW_SECONDS - 10 }
    },
    {
      label: "zero size",
      override: { size: "0" }
    },
    {
      label: "malformed size",
      override: { size: "many" }
    },
    {
      label: "zero price",
      override: { price: "0" }
    },
    {
      label: "price above one",
      override: { price: "1.000001" }
    },
    {
      label: "missing notional",
      override: { usdcSize: undefined }
    },
    {
      label: "zero notional",
      override: { usdcSize: 0 }
    }
  ])("rejects a row with $label", async ({ override }) => {
    const client = activityClient(() => [
      tradeActivity(1, NOW_SECONDS, override)
    ]);

    await expect(
      client.getUserActivity(PROFILE_ADDRESS, NOW_MS - 1_000)
    ).rejects.toMatchObject({ code: "INVALID_ACTIVITY_RESPONSE" });
  });

  it("rejects non-record rows, descending timestamps, and duplicate rows", async () => {
    const nonRecord = activityClient(() => [null]);
    await expect(
      nonRecord.getUserActivity(PROFILE_ADDRESS, NOW_MS - 2_000)
    ).rejects.toMatchObject({ code: "INVALID_ACTIVITY_RESPONSE" });

    const descending = activityClient(() => [
      tradeActivity(1, NOW_SECONDS),
      tradeActivity(2, NOW_SECONDS - 1)
    ]);
    await expect(
      descending.getUserActivity(PROFILE_ADDRESS, NOW_MS - 2_000)
    ).rejects.toMatchObject({ code: "INVALID_ACTIVITY_RESPONSE" });

    const row = tradeActivity(1, NOW_SECONDS);
    const duplicate = activityClient(() => [row, row]);
    await expect(
      duplicate.getUserActivity(PROFILE_ADDRESS, NOW_MS - 2_000)
    ).rejects.toMatchObject({ code: "ACTIVITY_RESPONSE_TRUNCATED" });
  });

  it.each([
    { label: "negative", sinceMs: -1 },
    { label: "fractional", sinceMs: NOW_MS - 0.5 },
    { label: "future", sinceMs: NOW_MS + 1 }
  ])("rejects a $label sinceMs locally", async ({ sinceMs }) => {
    let requests = 0;
    const client = activityClient(() => {
      requests += 1;
      return [];
    });

    await expect(
      client.getUserActivity(PROFILE_ADDRESS, sinceMs)
    ).rejects.toThrow(/sinceMs/u);
    expect(requests).toBe(0);
  });
});

function activityClient(
  payloadFor: (url: URL) => unknown
): PolymarketPublicClient {
  const fetchMock: PublicFetch = async (input) => {
    const url = new URL(input.toString());
    if (url.hostname !== "data.test" || url.pathname !== "/activity") {
      throw new Error(`Unexpected controlled URL ${url.toString()}.`);
    }
    return jsonResponse(payloadFor(url));
  };
  return new PolymarketPublicClient({
    dataHost: "https://data.test",
    fetch: fetchMock,
    now: () => NOW_MS,
    maxAttempts: 1
  });
}

function tradeActivity(
  index: number,
  timestamp: number,
  override: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    proxyWallet: PROFILE_ADDRESS,
    timestamp,
    conditionId: CONDITION_ID,
    type: "TRADE",
    size: "2",
    usdcSize: "0.8",
    transactionHash: transactionHash(index),
    price: "0.4",
    asset: String(1_000_000 + index),
    side: "BUY",
    ...override
  };
}

function transactionHash(index: number): string {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
