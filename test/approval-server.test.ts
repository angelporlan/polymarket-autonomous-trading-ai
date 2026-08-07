import { afterEach, describe, expect, it } from "vitest";
import { DashboardHttpServer } from "../src/approval/server.js";
import { TradingDatabase } from "../src/storage/database.js";

const servers: DashboardHttpServer[] = [];
const databases: TradingDatabase[] = [];
let nextPort = 20_000 + (process.pid % 20_000);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const database of databases.splice(0)) {
    database.close();
  }
});

async function createHarness() {
  const database = new TradingDatabase(":memory:");
  databases.push(database);
  const port = nextPort++;
  const server = new DashboardHttpServer({
    host: "127.0.0.1",
    port,
    database
  });
  servers.push(server);
  await server.start();
  return { server, database, port };
}

describe("DashboardHttpServer (Read-Only Monitoring)", () => {
  it("serves HTML dashboard and JSON status API on GET", async () => {
    const harness = await createHarness();
    const url = `http://127.0.0.1:${harness.port}/`;

    const htmlRes = await fetch(url, {
      headers: { host: `127.0.0.1:${harness.port}` }
    });
    expect(htmlRes.status).toBe(200);
    const htmlText = await htmlRes.text();
    expect(htmlText).toContain("Read-Only Monitoring Dashboard");

    const jsonRes = await fetch(`http://127.0.0.1:${harness.port}/api/status`, {
      headers: { host: `127.0.0.1:${harness.port}` }
    });
    expect(jsonRes.status).toBe(200);
    const json = (await jsonRes.json()) as Record<string, unknown>;
    expect(json.status).toBeDefined();
    expect(json.openPositionsCount).toBe(0);
    expect(json.positions).toEqual([]);
    expect(json.researchBundles).toEqual([]);
    expect(json.orders).toEqual([]);
    expect(json.pnl).toMatchObject({
      paper: {
        realizedPusd: "0",
        feesPusd: "0",
        netPusd: "0",
        openTrades: 0
      },
      live: { known: false, source: "remote_reconciliation" }
    });
    expect(json.locks).toBeDefined();
    expect(json.lastReconciliation).toBeNull();
  });

  it("blocks POST requests as Method Not Allowed in read-only mode", async () => {
    const harness = await createHarness();
    const res = await fetch(`http://127.0.0.1:${harness.port}/approve/123`, {
      method: "POST",
      headers: { host: `127.0.0.1:${harness.port}` }
    });
    expect(res.status).toBe(405);
    const text = await res.text();
    expect(text).toContain("METHOD_NOT_ALLOWED");
  });
});
