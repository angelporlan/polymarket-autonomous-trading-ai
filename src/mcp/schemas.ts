import { z } from "zod/v4";

const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
const signedDecimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

export const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Expected an EVM address.");

export const identifierSchema = z.string().trim().min(1).max(512);
export const proposalIdSchema = z.string().uuid();
export const proposalHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 hash.");
export const timestampSchema = z.string().datetime({ offset: true });
export const publicHttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  }, "Expected an HTTP(S) URL.");
export const nonNegativeDecimalSchema = z
  .string()
  .regex(decimalPattern, "Expected a non-negative decimal with at most six places.");
export const signedDecimalSchema = z
  .string()
  .regex(signedDecimalPattern, "Expected a decimal with at most six places.");
export const probabilityDecimalSchema = nonNegativeDecimalSchema.refine(
  (value) => Number(value) <= 1,
  "Probability must be between 0 and 1."
);
export const positiveDecimalSchema = nonNegativeDecimalSchema.refine(
  (value) => {
    const [whole = "0", fraction = ""] = value.split(".");
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0")) > 0n;
  },
  "Value must be greater than zero."
);

export const marketCategorySchema = z.enum([
  "politics",
  "economics",
  "technology"
]);
export const orderSideSchema = z.enum(["BUY", "SELL"]);

export const evidenceSourceSchema = z
  .object({
    url: publicHttpUrlSchema,
    title: z.string().trim().min(1).max(500),
    publishedAt: timestampSchema.nullable(),
    retrievedAt: timestampSchema,
    primary: z.boolean()
  })
  .strict();

export const paperGateSchema = z
  .object({
    passed: z.boolean(),
    skipped: z.boolean(),
    firstTradeAt: timestampSchema.nullable(),
    daysObserved: z.number().nonnegative(),
    totalTrades: z.number().int().nonnegative(),
    closedTrades: z.number().int().nonnegative(),
    netPnlPusd: signedDecimalSchema,
    maxDrawdownPusd: nonNegativeDecimalSchema,
    riskViolations: z.number().int().nonnegative(),
    reconciliationErrors: z.number().int().nonnegative(),
    reasons: z.array(z.string().min(1))
  })
  .strict();

export const priceLevelSchema = z
  .object({
    pricePusd: probabilityDecimalSchema,
    shares: nonNegativeDecimalSchema
  })
  .strict();

export const marketSnapshotSchema = z
  .object({
    conditionId: identifierSchema,
    tokenId: identifierSchema,
    eventId: identifierSchema.nullable(),
    question: z.string().trim().min(1),
    slug: z.string().trim().min(1),
    outcome: z.string().trim().min(1),
    category: marketCategorySchema,
    rules: z.string().trim().min(1),
    resolutionSource: z.string().trim().min(1),
    endTime: timestampSchema,
    active: z.boolean(),
    closed: z.boolean(),
    acceptingOrders: z.boolean(),
    negRisk: z.boolean(),
    tickSizePusd: positiveDecimalSchema,
    minOrderSizeShares: positiveDecimalSchema,
    feesEnabled: z.boolean(),
    feeRateBps: z.number().int().nonnegative(),
    feeExponent: z.number().int().nonnegative(),
    feesTakerOnly: z.boolean(),
    bestBidPusd: probabilityDecimalSchema.nullable(),
    bestAskPusd: probabilityDecimalSchema.nullable(),
    spreadPusd: nonNegativeDecimalSchema.nullable(),
    depthPusdAtLimit: nonNegativeDecimalSchema.nullable(),
    bids: z.array(priceLevelSchema),
    asks: z.array(priceLevelSchema),
    geoblockStatus: z.enum(["allowed", "blocked", "unknown"]),
    capturedAt: timestampSchema
  })
  .strict();

export const portfolioPositionSchema = z
  .object({
    tokenId: identifierSchema,
    conditionId: identifierSchema,
    question: z.string().trim().min(1),
    outcome: z.string().trim().min(1),
    sizeShares: nonNegativeDecimalSchema,
    averagePricePusd: probabilityDecimalSchema,
    currentPricePusd: probabilityDecimalSchema,
    currentValuePusd: nonNegativeDecimalSchema,
    cashPnlPusd: signedDecimalSchema,
    realizedPnlPusd: signedDecimalSchema,
    endTime: timestampSchema
  })
  .strict();

export const candidateMarketSchema = z
  .object({
    conditionId: identifierSchema,
    slug: z.string().trim().min(1),
    question: z.string().trim().min(1),
    category: marketCategorySchema,
    endTime: timestampSchema,
    volume24hPusd: nonNegativeDecimalSchema,
    liquidityPusd: nonNegativeDecimalSchema,
    spreadPusd: nonNegativeDecimalSchema.nullable(),
    tokenIds: z.array(identifierSchema).min(1),
    active: z.boolean(),
    acceptingOrders: z.boolean()
  })
  .strict();

export const riskLimitSchema = z
  .object({
    allocatedCapitalPusd: nonNegativeDecimalSchema,
    maxOrderPusd: nonNegativeDecimalSchema,
    maxMarketOrCorrelationPusd: nonNegativeDecimalSchema,
    maxTotalExposurePusd: nonNegativeDecimalSchema,
    maxOpenMarkets: z.number().int().positive(),
    dailyStopPusd: nonNegativeDecimalSchema,
    canaryTradesRequired: z.number().int().nonnegative()
  })
  .strict();

export const orderProposalSchema = z
  .object({
    proposalId: proposalIdSchema,
    proposalHash: proposalHashSchema,
    status: z.enum(["STAGED", "SIMULATED", "AWAITING_LOCAL"]),
    executionMode: z.enum(["paper", "live"]),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    market: marketSnapshotSchema,
    side: orderSideSchema,
    shares: positiveDecimalSchema,
    limitPricePusd: probabilityDecimalSchema,
    maxCostPusd: nonNegativeDecimalSchema,
    maxLossPusd: nonNegativeDecimalSchema,
    estimatedFeePusd: nonNegativeDecimalSchema,
    estimatedProbability: probabilityDecimalSchema,
    expectedEdge: signedDecimalSchema,
    postTradeMarketExposurePusd: nonNegativeDecimalSchema,
    postTradeTotalExposurePusd: nonNegativeDecimalSchema,
    thesis: z.string().trim().min(20),
    counterThesis: z.string().trim().min(20),
    sources: z.array(evidenceSourceSchema).min(1),
    correlationKey: z.string().trim().min(1).max(200),
    policyVersion: z.string().trim().min(1)
  })
  .strict();

export const getAccountStatusInputSchema = z.object({}).strict();
export const getAccountStatusOutputSchema = z
  .object({
    status: z.enum([
      "UNCONFIGURED",
      "READ_ONLY",
      "PAPER",
      "LIVE_LOCKED",
      "LIVE_READY",
      "EMERGENCY_STOPPED"
    ]),
    profileAddress: addressSchema.nullable(),
    signerAddress: addressSchema.nullable(),
    funderAddress: addressSchema.nullable(),
    walletType: z.enum(["EOA", "POLY_PROXY", "POLY_1271"]).nullable(),
    keychainReady: z.boolean(),
    l2CredentialsReady: z.boolean(),
    liveEnabled: z.boolean(),
    emergencyStopped: z.boolean(),
    paperGate: paperGateSchema,
    capturedAt: timestampSchema
  })
  .strict();

export const getPortfolioInputSchema = z.object({}).strict();
export const getPortfolioOutputSchema = z
  .object({
    profileAddress: addressSchema,
    pUsdBalancePusd: nonNegativeDecimalSchema.nullable(),
    totalPositionValuePusd: nonNegativeDecimalSchema,
    totalPnlPusd: signedDecimalSchema,
    positions: z.array(portfolioPositionSchema),
    capturedAt: timestampSchema,
    source: z.enum(["public", "authenticated"])
  })
  .strict();

export const scanCandidatesInputSchema = z
  .object({
    categories: z
      .array(marketCategorySchema)
      .min(1)
      .max(3)
      .default(["politics", "economics", "technology"]),
    limit: z.number().int().min(1).max(50).default(20),
    minLiquidityPusd: nonNegativeDecimalSchema.optional()
  })
  .strict();
export const scanCandidatesOutputSchema = z
  .object({
    candidates: z.array(candidateMarketSchema),
    capturedAt: timestampSchema
  })
  .strict();

export const getMarketSnapshotInputSchema = z
  .object({
    tokenId: identifierSchema.optional(),
    conditionId: identifierSchema.optional(),
    side: orderSideSchema.optional(),
    limitPricePusd: probabilityDecimalSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.tokenId === undefined && value.conditionId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Provide tokenId or conditionId."
      });
    }
    if (
      value.limitPricePusd !== undefined &&
      value.side === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["side"],
        message: "side is required when limitPricePusd is provided."
      });
    }
  });
export const getMarketSnapshotOutputSchema = marketSnapshotSchema;

export const getRiskStatusInputSchema = z.object({}).strict();
export const getRiskStatusOutputSchema = z
  .object({
    phase: z.enum(["CANARY", "PILOT", "PAUSED"]),
    policyVersion: z.string().trim().min(1),
    emergencyStopped: z.boolean(),
    coolingDownUntil: timestampSchema.nullable(),
    limits: riskLimitSchema,
    totalOpenExposurePusd: nonNegativeDecimalSchema,
    dailyPnlPusd: signedDecimalSchema,
    openMarketCount: z.number().int().nonnegative(),
    liveTradeCount: z.number().int().nonnegative(),
    activeViolations: z.array(
      z
        .object({
          code: z.string().trim().min(1),
          message: z.string().trim().min(1)
        })
        .strict()
    ),
    paperGate: paperGateSchema,
    capturedAt: timestampSchema
  })
  .strict();

export const getOrderStatusInputSchema = z
  .object({
    orderId: identifierSchema.optional(),
    proposalId: proposalIdSchema.optional()
  })
  .strict()
  .refine(
    (value) =>
      Number(value.orderId !== undefined) + Number(value.proposalId !== undefined) ===
      1,
    "Provide exactly one of orderId or proposalId."
  );
export const getOrderStatusOutputSchema = z
  .object({
    proposalId: proposalIdSchema,
    proposalHash: proposalHashSchema,
    orderId: identifierSchema.nullable(),
    status: z.string().trim().min(1),
    side: orderSideSchema,
    limitPricePusd: probabilityDecimalSchema,
    originalShares: positiveDecimalSchema,
    filledShares: nonNegativeDecimalSchema,
    remainingShares: nonNegativeDecimalSchema,
    averageFillPricePusd: probabilityDecimalSchema.nullable(),
    feesPusd: nonNegativeDecimalSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict();

export const stageOrderInputSchema = z
  .object({
    executionMode: z.enum(["paper", "live"]).default("paper"),
    tokenId: identifierSchema,
    conditionId: identifierSchema.optional(),
    outcome: z.string().trim().min(1).max(200),
    side: orderSideSchema,
    shares: positiveDecimalSchema,
    limitPricePusd: probabilityDecimalSchema,
    estimatedProbability: probabilityDecimalSchema,
    thesis: z.string().trim().min(20).max(5_000),
    counterThesis: z.string().trim().min(20).max(5_000),
    sources: z.array(evidenceSourceSchema).min(1).max(20),
    confirmsNoConfidentialInformation: z.literal(true),
    confirmsNoOutcomeInfluence: z.literal(true)
  })
  .strict();
export const stageOrderOutputSchema = orderProposalSchema;

export const executeStagedOrderInputSchema = z
  .object({
    proposalId: proposalIdSchema,
    proposalHash: proposalHashSchema
  })
  .strict();

export const loopbackApprovalUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1";
  }, "Approval URL must use http://127.0.0.1.");

export const executeStagedOrderOutputSchema = z
  .object({
    proposalId: proposalIdSchema,
    proposalHash: proposalHashSchema,
    status: z.enum(["AWAITING_LOCAL_CONFIRMATION", "SUBMITTED", "REJECTED"]),
    approvalUrl: loopbackApprovalUrlSchema,
    expiresAt: timestampSchema,
    message: z.string().trim().min(1)
  })
  .strict();

export const cancelOrderInputSchema = z
  .object({
    orderId: identifierSchema.optional(),
    proposalId: proposalIdSchema.optional(),
    reason: z.string().trim().min(1).max(500).optional()
  })
  .strict()
  .refine(
    (value) =>
      Number(value.orderId !== undefined) + Number(value.proposalId !== undefined) ===
      1,
    "Provide exactly one of orderId or proposalId."
  );
export const cancelOrderOutputSchema = z
  .object({
    orderId: identifierSchema.nullable(),
    proposalId: proposalIdSchema.nullable(),
    status: z.enum([
      "CANCEL_REQUESTED",
      "CANCELLED",
      "ALREADY_TERMINAL",
      "NOT_FOUND"
    ]),
    cancelledAt: timestampSchema,
    message: z.string().trim().min(1)
  })
  .strict();

export const emergencyStopInputSchema = z
  .object({
    confirmation: z.literal("CANCEL_ALL_AND_LOCK"),
    reason: z.string().trim().min(1).max(500)
  })
  .strict();
export const emergencyStopOutputSchema = z
  .object({
    active: z.literal(true),
    cancelledOrderIds: z.array(identifierSchema),
    failedOrderIds: z.array(identifierSchema),
    activatedAt: timestampSchema,
    message: z.string().trim().min(1)
  })
  .strict();

export type GetAccountStatusInput = z.infer<typeof getAccountStatusInputSchema>;
export type GetAccountStatusOutput = z.infer<typeof getAccountStatusOutputSchema>;
export type GetPortfolioInput = z.infer<typeof getPortfolioInputSchema>;
export type GetPortfolioOutput = z.infer<typeof getPortfolioOutputSchema>;
export type ScanCandidatesInput = z.infer<typeof scanCandidatesInputSchema>;
export type ScanCandidatesOutput = z.infer<typeof scanCandidatesOutputSchema>;
export type GetMarketSnapshotInput = z.infer<
  typeof getMarketSnapshotInputSchema
>;
export type GetMarketSnapshotOutput = z.infer<
  typeof getMarketSnapshotOutputSchema
>;
export type GetRiskStatusInput = z.infer<typeof getRiskStatusInputSchema>;
export type GetRiskStatusOutput = z.infer<typeof getRiskStatusOutputSchema>;
export type GetOrderStatusInput = z.infer<typeof getOrderStatusInputSchema>;
export type GetOrderStatusOutput = z.infer<typeof getOrderStatusOutputSchema>;
export type StageOrderInput = z.infer<typeof stageOrderInputSchema>;
export type StageOrderOutput = z.infer<typeof stageOrderOutputSchema>;
export type ExecuteStagedOrderInput = z.infer<
  typeof executeStagedOrderInputSchema
>;
export type ExecuteStagedOrderOutput = z.infer<
  typeof executeStagedOrderOutputSchema
>;
export type CancelOrderInput = z.infer<typeof cancelOrderInputSchema>;
export type CancelOrderOutput = z.infer<typeof cancelOrderOutputSchema>;
export type EmergencyStopInput = z.infer<typeof emergencyStopInputSchema>;
export type EmergencyStopOutput = z.infer<typeof emergencyStopOutputSchema>;
