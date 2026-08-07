import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
  CallToolResult,
  ToolAnnotations
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod/v4";
import {
  cancelOrderInputSchema,
  cancelOrderOutputSchema,
  emergencyStopInputSchema,
  emergencyStopOutputSchema,
  endTradingSessionInputSchema,
  endTradingSessionOutputSchema,
  executeStagedOrderInputSchema,
  executeStagedOrderOutputSchema,
  getAccountStatusInputSchema,
  getAccountStatusOutputSchema,
  getMarketSnapshotInputSchema,
  getMarketSnapshotOutputSchema,
  getOrderStatusInputSchema,
  getOrderStatusOutputSchema,
  getPortfolioInputSchema,
  getPortfolioOutputSchema,
  getRiskStatusInputSchema,
  getRiskStatusOutputSchema,
  getTradingSessionInputSchema,
  getTradingSessionOutputSchema,
  scanCandidatesInputSchema,
  scanCandidatesOutputSchema,
  stageOrderInputSchema,
  stageOrderOutputSchema,
  activateTradingSessionInputSchema,
  activateTradingSessionOutputSchema,
  prepareTradingSessionInputSchema,
  prepareTradingSessionOutputSchema,
  supervisePositionsInputSchema,
  supervisePositionsOutputSchema,
  type CancelOrderInput,
  type CancelOrderOutput,
  type EmergencyStopInput,
  type EmergencyStopOutput,
  type EndTradingSessionInput,
  type EndTradingSessionOutput,
  type ExecuteStagedOrderInput,
  type ExecuteStagedOrderOutput,
  type GetAccountStatusInput,
  type GetAccountStatusOutput,
  type GetMarketSnapshotInput,
  type GetMarketSnapshotOutput,
  type GetOrderStatusInput,
  type GetOrderStatusOutput,
  type GetPortfolioInput,
  type GetPortfolioOutput,
  type GetRiskStatusInput,
  type GetRiskStatusOutput,
  type GetTradingSessionInput,
  type GetTradingSessionOutput,
  type ScanCandidatesInput,
  type ScanCandidatesOutput,
  type StageOrderInput,
  type StageOrderOutput,
  type ActivateTradingSessionInput,
  type ActivateTradingSessionOutput,
  type PrepareTradingSessionInput,
  type PrepareTradingSessionOutput,
  type SupervisePositionsInput,
  type SupervisePositionsOutput
} from "./schemas.js";

export type Awaitable<T> = T | Promise<T>;

/**
 * JSON-safe boundary implemented by the runtime.
 */
export interface McpToolDependencies {
  getAccountStatus(input: GetAccountStatusInput): Awaitable<GetAccountStatusOutput>;
  getPortfolio(input: GetPortfolioInput): Awaitable<GetPortfolioOutput>;
  scanCandidates(input: ScanCandidatesInput): Awaitable<ScanCandidatesOutput>;
  getMarketSnapshot(
    input: GetMarketSnapshotInput
  ): Awaitable<GetMarketSnapshotOutput>;
  getRiskStatus(input: GetRiskStatusInput): Awaitable<GetRiskStatusOutput>;
  getOrderStatus(input: GetOrderStatusInput): Awaitable<GetOrderStatusOutput>;
  prepareTradingSession(
    input: PrepareTradingSessionInput
  ): Awaitable<PrepareTradingSessionOutput>;
  activateTradingSession(
    input: ActivateTradingSessionInput
  ): Awaitable<ActivateTradingSessionOutput>;
  getTradingSession(
    input: GetTradingSessionInput
  ): Awaitable<GetTradingSessionOutput>;
  endTradingSession(
    input: EndTradingSessionInput
  ): Awaitable<EndTradingSessionOutput>;
  supervisePositions(
    input: SupervisePositionsInput
  ): Awaitable<SupervisePositionsOutput>;
  stageOrder(input: StageOrderInput): Awaitable<StageOrderOutput>;
  executeStagedOrder(
    input: ExecuteStagedOrderInput
  ): Awaitable<ExecuteStagedOrderOutput>;
  cancelOrder(input: CancelOrderInput): Awaitable<CancelOrderOutput>;
  emergencyStop(input: EmergencyStopInput): Awaitable<EmergencyStopOutput>;
  close?(): Awaitable<void>;
}

export class PublicMcpToolError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string
  ) {
    super(publicMessage);
    this.name = "PublicMcpToolError";
  }
}

const READ_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
}) satisfies ToolAnnotations;

const STAGE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
}) satisfies ToolAnnotations;

const APPROVAL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false
}) satisfies ToolAnnotations;

const SESSION_ACTIVATION_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
}) satisfies ToolAnnotations;

const EXTERNAL_SAFETY_ACTION_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true
}) satisfies ToolAnnotations;

export function createMcpServer(deps: McpToolDependencies): McpServer {
  const server = new McpServer(
    {
      name: "codex-polymarket-guarded",
      version: "0.1.0"
    },
    {
      instructions:
        "Inspect account, market state, and trading session budget before staging an order. Staging creates an immutable proposal. execute_staged_order submits the proposal autonomously ONLY when an active authorized session with remaining budget exists and all risk policy and live safety checks pass."
    }
  );

  server.registerTool(
    "get_account_status",
    {
      title: "Get account status",
      description:
        "Return configured wallet identity, operating mode, keychain readiness, emergency-stop state, and paper-gate progress. Never returns secrets.",
      inputSchema: getAccountStatusInputSchema,
      outputSchema: getAccountStatusOutputSchema,
      annotations: READ_ANNOTATIONS
    },
    (input) =>
      invokeStructured(
        getAccountStatusOutputSchema,
        () => deps.getAccountStatus(input)
      )
  );

  server.registerTool(
    "get_portfolio",
    {
      title: "Get portfolio",
      description:
        "Return the configured Polymarket profile's public positions and PnL using decimal strings. Public balance may be unavailable.",
      inputSchema: getPortfolioInputSchema,
      outputSchema: getPortfolioOutputSchema,
      annotations: READ_ANNOTATIONS
    },
    (input) =>
      invokeStructured(getPortfolioOutputSchema, () => deps.getPortfolio(input))
  );

  server.registerTool(
    "scan_candidates",
    {
      title: "Scan candidate markets",
      description:
        "Scan only the allowed politics, economics, and technology categories and return candidate market metadata. This does not estimate edge or stage orders.",
      inputSchema: scanCandidatesInputSchema,
      outputSchema: scanCandidatesOutputSchema,
      annotations: READ_ANNOTATIONS
    },
    (input) =>
      invokeStructured(scanCandidatesOutputSchema, () =>
        deps.scanCandidates(input)
      )
  );

  server.registerTool(
    "get_market_snapshot",
    {
      title: "Get market snapshot",
      description:
        "Return current market rules, resolution source, order book, tick, fees, liquidity, and geoblock status for one market token or condition.",
      inputSchema: getMarketSnapshotInputSchema,
      outputSchema: getMarketSnapshotOutputSchema,
      annotations: READ_ANNOTATIONS
    },
    (input) =>
      invokeStructured(getMarketSnapshotOutputSchema, () =>
        deps.getMarketSnapshot(input)
      )
  );

  server.registerTool(
    "get_risk_status",
    {
      title: "Get risk status",
      description:
        "Return immutable pilot limits, current exposure, daily PnL, paper-gate state, cooldown, and active risk violations.",
      inputSchema: getRiskStatusInputSchema,
      outputSchema: getRiskStatusOutputSchema,
      annotations: READ_ANNOTATIONS
    },
    (input) =>
      invokeStructured(getRiskStatusOutputSchema, () =>
        deps.getRiskStatus(input)
      )
  );

  server.registerTool(
    "get_order_status",
    {
      title: "Get order status",
      description:
        "Return the latest locally validated ledger status, fills, and fees for exactly one proposal or CLOB order identifier.",
      inputSchema: getOrderStatusInputSchema,
      outputSchema: getOrderStatusOutputSchema,
      annotations: READ_ANNOTATIONS
    },
    (input) =>
      invokeStructured(getOrderStatusOutputSchema, () =>
        deps.getOrderStatus(input)
      )
  );

  server.registerTool(
    "prepare_trading_session",
    {
      title: "Prepare trading session",
      description:
        "Calculate current safe session capacity and issue a short-lived one-time challenge for local human authorization. This does not activate a session.",
      inputSchema: prepareTradingSessionInputSchema,
      outputSchema: prepareTradingSessionOutputSchema,
      annotations: READ_ANNOTATIONS
    },
    (input) =>
      invokeStructured(prepareTradingSessionOutputSchema, () =>
        deps.prepareTradingSession(input)
      )
  );

  server.registerTool(
    "activate_trading_session",
    {
      title: "Activate trading session",
      description:
        "Consume exactly one locally recorded human authorization and activate its fixed budget. The agent cannot choose or increase the amount here.",
      inputSchema: activateTradingSessionInputSchema,
      outputSchema: activateTradingSessionOutputSchema,
      annotations: SESSION_ACTIVATION_ANNOTATIONS
    },
    (input) =>
      invokeStructured(activateTradingSessionOutputSchema, () =>
        deps.activateTradingSession(input)
      )
  );

  server.registerTool(
    "get_trading_session",
    {
      title: "Get trading session",
      description:
        "Return the current active session budget, used amount, remaining capacity, status, and expiration for paper or live mode.",
      inputSchema: getTradingSessionInputSchema,
      outputSchema: getTradingSessionOutputSchema,
      annotations: READ_ANNOTATIONS
    },
    (input) =>
      invokeStructured(getTradingSessionOutputSchema, () =>
        deps.getTradingSession(input)
      )
  );

  server.registerTool(
    "end_trading_session",
    {
      title: "End trading session",
      description:
        "Explicitly close and terminate the current active trading session for paper or live mode.",
      inputSchema: endTradingSessionInputSchema,
      outputSchema: endTradingSessionOutputSchema,
      annotations: APPROVAL_ANNOTATIONS
    },
    (input) =>
      invokeStructured(endTradingSessionOutputSchema, () =>
        deps.endTradingSession(input)
      )
  );

  server.registerTool(
    "supervise_positions",
    {
      title: "Supervise positions and execute exit policy",
      description:
        "Evaluate all open portfolio positions against stop-loss (-30%), take-profit (+50%), max hold (14 days), and edge disappearance rules. Auto-executes exit orders for triggered positions.",
      inputSchema: supervisePositionsInputSchema,
      outputSchema: supervisePositionsOutputSchema,
      annotations: APPROVAL_ANNOTATIONS
    },
    (input) =>
      invokeStructured(supervisePositionsOutputSchema, () =>
        deps.supervisePositions(input)
      )
  );

  server.registerTool(
    "stage_order",
    {
      title: "Stage order",
      description:
        "Validate policy and persist an immutable, expiring order proposal. Requires an active authorized trading session budget for live mode.",
      inputSchema: stageOrderInputSchema,
      outputSchema: stageOrderOutputSchema,
      annotations: STAGE_ANNOTATIONS
    },
    (input) =>
      invokeStructured(stageOrderOutputSchema, () => deps.stageOrder(input))
  );

  server.registerTool(
    "execute_staged_order",
    {
      title: "Execute staged order autonomously",
      description:
        "Execute a staged proposal autonomously. Submits the order to Polymarket CLOB if live safety gates, active session budget, and risk policy checks pass.",
      inputSchema: executeStagedOrderInputSchema,
      outputSchema: executeStagedOrderOutputSchema,
      annotations: APPROVAL_ANNOTATIONS
    },
    (input) =>
      invokeStructured(executeStagedOrderOutputSchema, () =>
        deps.executeStagedOrder(input)
      )
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel order",
      description:
        "Request cancellation of exactly one open order resolved from a CLOB order ID or proposal ID. Terminal cancellation still requires reconciliation; repeated calls are safe.",
      inputSchema: cancelOrderInputSchema,
      outputSchema: cancelOrderOutputSchema,
      annotations: EXTERNAL_SAFETY_ACTION_ANNOTATIONS
    },
    (input) =>
      invokeStructured(cancelOrderOutputSchema, () => deps.cancelOrder(input))
  );

  server.registerTool(
    "emergency_stop",
    {
      title: "Emergency stop",
      description:
        "Persistently lock live execution and request cancellation of all known open orders. Requires the exact confirmation phrase CANCEL_ALL_AND_LOCK.",
      inputSchema: emergencyStopInputSchema,
      outputSchema: emergencyStopOutputSchema,
      annotations: EXTERNAL_SAFETY_ACTION_ANNOTATIONS
    },
    (input) =>
      invokeStructured(emergencyStopOutputSchema, () =>
        deps.emergencyStop(input)
      )
  );

  return server;
}

async function invokeStructured<
  Schema extends z.ZodType<Record<string, unknown>>
>(
  schema: Schema,
  operation: () => Awaitable<z.input<Schema>>
): Promise<CallToolResult> {
  try {
    const structuredContent = schema.parse(await operation());
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredContent, null, 2)
        }
      ],
      structuredContent
    };
  } catch (error) {
    const publicError =
      error instanceof PublicMcpToolError
        ? {
            code: error.code,
            message: error.publicMessage
          }
        : {
            code: "INTERNAL_TOOL_ERROR",
            message:
              "The operation failed safely. Inspect the local service logs for details."
          };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(publicError)
        }
      ],
      isError: true
    };
  }
}

interface RuntimeFactoryModule {
  createMcpToolDependencies?: () => Awaitable<McpToolDependencies>;
}

export async function main(): Promise<void> {
  const runtimeModulePath = "../runtime.js";
  const runtimeModule = (await import(runtimeModulePath)) as RuntimeFactoryModule;
  if (typeof runtimeModule.createMcpToolDependencies !== "function") {
    throw new Error(
      "../runtime.js must export createMcpToolDependencies()."
    );
  }

  const deps = await runtimeModule.createMcpToolDependencies();
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  let closing = false;
  let runtimeClosePromise: Promise<void> | null = null;

  const closeRuntime = (): Promise<void> => {
    runtimeClosePromise ??= Promise.resolve(deps.close?.());
    return runtimeClosePromise;
  };

  const close = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    try {
      await server.close();
    } finally {
      await closeRuntime();
    }
  };

  // Protocol.connect preserves pre-installed transport hooks. This makes EOF,
  // transport closure, and parse/I/O errors take the same fail-closed runtime
  // shutdown path as SIGINT/SIGTERM.
  transport.onclose = () => {
    void closeRuntime();
  };
  transport.onerror = () => {
    void close();
  };
  process.stdin.once("end", () => {
    void close();
  });
  process.stdin.once("close", () => {
    void close();
  });

  process.once("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });

  await server.connect(transport);
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
  void main().catch(() => {
    process.stderr.write(
      "[polymarket-mcp] Fatal startup error. Review the local runtime configuration.\n"
    );
    process.exitCode = 1;
  });
}
