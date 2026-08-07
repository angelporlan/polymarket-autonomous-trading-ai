import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import {
  createMcpServer,
  type McpToolDependencies
} from "../src/mcp/server.js";

const proposalId = "00000000-0000-4000-8000-000000000001";
const proposalHash = "a".repeat(64);
const expiresAt = "2026-07-23T12:01:30.000Z";

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
    stageOrder: unexpectedCall,
    createApprovalRequest: unexpectedCall,
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
  it("registers exactly the planned tools with schemas and safety annotations", async () => {
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
        "stage_order",
        "execute_staged_order",
        "cancel_order",
        "emergency_stop"
      ]);

      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.outputSchema?.type).toBe("object");
      }

      const annotations = Object.fromEntries(
        tools.map((tool) => [tool.name, tool.annotations])
      );
      for (const name of [
        "get_account_status",
        "get_portfolio",
        "scan_candidates",
        "get_market_snapshot",
        "get_risk_status",
        "get_order_status"
      ]) {
        expect(annotations[name]).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true
        });
      }
      expect(annotations.stage_order).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      });
      expect(annotations.execute_staged_order).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      });
      expect(annotations.cancel_order).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true
      });
      expect(annotations.emergency_stop).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("execute_staged_order only requests a loopback approval and returns structured content", async () => {
    const createApprovalRequest = vi.fn(
      async (): Promise<
        Awaited<
          ReturnType<McpToolDependencies["createApprovalRequest"]>
        >
      > => ({
        proposalId,
        proposalHash,
        status: "AWAITING_LOCAL_CONFIRMATION",
        approvalUrl: `http://127.0.0.1:8787/approve/${proposalId}`,
        expiresAt,
        message: "Confirm the exact proposal in the local approval panel."
      })
    );
    const { client, server } = await connect(
      createDependencies({ createApprovalRequest })
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
        status: "AWAITING_LOCAL_CONFIRMATION",
        approvalUrl: `http://127.0.0.1:8787/approve/${proposalId}`,
        expiresAt,
        message: "Confirm the exact proposal in the local approval panel."
      });
      expect(createApprovalRequest).toHaveBeenCalledOnce();
      expect(createApprovalRequest).toHaveBeenCalledWith({
        proposalId,
        proposalHash
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects a non-loopback approval URL returned by the runtime", async () => {
    const { client, server } = await connect(
      createDependencies({
        createApprovalRequest: async () => ({
          proposalId,
          proposalHash,
          status: "AWAITING_LOCAL_CONFIRMATION",
          approvalUrl: "https://example.com/approve",
          expiresAt,
          message: "Unsafe URL."
        })
      })
    );

    try {
      const result = await client.callTool({
        name: "execute_staged_order",
        arguments: { proposalId, proposalHash }
      });
      if ("toolResult" in result) {
        throw new Error("Unexpected legacy tool result.");
      }
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
