import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import {
  createMcpServer,
  type McpToolDependencies
} from "../src/mcp/server.js";

const proposalId = "00000000-0000-4000-8000-000000000001";
const proposalHash = "a".repeat(64);

function unexpectedCall(): never {
  throw new Error("Unexpected dependency call.");
}

function createDependencies(
  overrides: Partial<McpToolDependencies> = {}
): McpToolDependencies {
  return {
    getAccountStatus: unexpectedCall,
    getPortfolio: unexpectedCall,
    scanCandidates: unexpectedCall,
    getMarketSnapshot: unexpectedCall,
    getRiskStatus: unexpectedCall,
    getOrderStatus: unexpectedCall,
    startTradingSession: unexpectedCall,
    getSessionStatus: unexpectedCall,
    endTradingSession: unexpectedCall,
    supervisePositions: unexpectedCall,
    stageOrder: unexpectedCall,
    executeStagedOrder: unexpectedCall,
    cancelOrder: unexpectedCall,
    emergencyStop: unexpectedCall,
    ...overrides
  };
}

async function connect(deps: McpToolDependencies) {
  const server = createMcpServer(deps);
  const client = new Client(
    { name: "mcp-contract-test", version: "1.0.0" },
    { capabilities: {} }
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("Polymarket MCP contract", () => {
  it("registers all session, supervisor, and execution tools with schemas and annotations", async () => {
    const { client, server } = await connect(createDependencies());
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "get_account_status",
        "get_portfolio",
        "scan_candidates",
        "get_market_snapshot",
        "get_risk_status",
        "get_order_status",
        "start_trading_session",
        "get_session_status",
        "end_trading_session",
        "supervise_positions",
        "stage_order",
        "execute_staged_order",
        "cancel_order",
        "emergency_stop"
      ]);

      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.outputSchema?.type).toBe("object");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("execute_staged_order executes proposal autonomously subject to session budget and risk checks", async () => {
    const executeStagedOrder = vi.fn(
      async (): Promise<
        Awaited<
          ReturnType<McpToolDependencies["executeStagedOrder"]>
        >
      > => ({
        proposalId,
        proposalHash,
        status: "EXECUTING",
        message: "Proposal submitted autonomously for execution."
      })
    );
    const { client, server } = await connect(
      createDependencies({ executeStagedOrder })
    );

    try {
      const result = await client.callTool({
        name: "execute_staged_order",
        arguments: { proposalId, proposalHash }
      });
      if ("toolResult" in result) {
        throw new Error("Unexpected legacy tool result.");
      }

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        proposalId,
        proposalHash,
        status: "EXECUTING",
        message: "Proposal submitted autonomously for execution."
      });
      expect(executeStagedOrder).toHaveBeenCalledOnce();
      expect(executeStagedOrder).toHaveBeenCalledWith({
        proposalId,
        proposalHash
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
