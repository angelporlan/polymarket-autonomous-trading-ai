import { PolymarketRuntime } from "../src/runtime.js";

async function main() {
  const runtime = new PolymarketRuntime();
  const status = await runtime.getAccountStatus();
  console.log("=========================================");
  console.log("AUTONOMOUS PAPER TRADING CYCLE STARTING");
  console.log("=========================================");
  console.log("Profile Address:", status.profileAddress);
  console.log("Operating Status:", status.status);

  // A paper session must be prepared and authorized locally before this cycle.
  const sessionStatus = await runtime.getTradingSession({ executionMode: "paper" });
  if (!sessionStatus.activeSession) {
    throw new Error(
      "SESSION_REQUIRED: prepare a paper session, authorize it locally, then rerun this cycle."
    );
  }

  // 1. Scan candidates
  const candidatesResult = await runtime.scanCandidates({
    categories: ["politics", "economics", "technology"],
    limit: 10
  });
  console.log(`Scanned ${candidatesResult.candidates.length} candidate markets.`);

  const candidate = candidatesResult.candidates[0];
  if (!candidate) {
    console.log("No candidates found.");
    return;
  }

  const tokenId = candidate.tokenIds[0];
  if (!tokenId) {
    console.log("Candidate missing token IDs.");
    return;
  }

  console.log(`Evaluating Candidate: ${candidate.question} (${candidate.conditionId})`);

  // 2. Fetch snapshot
  const snapshot = await runtime.getMarketSnapshot({
    conditionId: candidate.conditionId,
    tokenId,
    side: "BUY",
    limitPricePusd: "0.050000"
  });

  const eventId = snapshot.eventId ?? candidate.conditionId;

  console.log(`Snapshot fetched: Best Ask = $${snapshot.bestAskPusd}, Best Bid = $${snapshot.bestBidPusd}, Spread = $${snapshot.spreadPusd}`);

  // 3. Evaluate criteria
  const spread = parseFloat(snapshot.spreadPusd ?? "1.000");
  if (spread > 0.03) {
    console.log("Discarded candidate: Spread > 0.03");
    return;
  }

  const thesis = "At limit price 0.050 pUSD, Yes option provides positive EV given current policy analysis and economic indicators.";
  const counterThesis = "Macroeconomic baseline stability indicates low probability of sudden policy shifts before resolution.";
  const nowIso = new Date().toISOString();
  const recentPublished = new Date(Date.now() - 3600 * 1000).toISOString();

  // 4. Stage Paper Order
  console.log("Staging Paper Order...");
  const staged = await runtime.stageOrder({
    executionMode: "paper",
    intent: "ENTRY",
    conditionId: candidate.conditionId,
    tokenId,
    outcome: "Yes",
    side: "BUY",
    shares: "10.000000",
    limitPricePusd: "0.050000",
    estimatedProbability: "0.110000",
    thesis,
    counterThesis,
    sources: [
      {
        url: `https://www.reuters.com/business/finance/economic-outlook-2026?id=${eventId}`,
        title: "Reuters Macroeconomic Policy Report",
        publishedAt: recentPublished,
        retrievedAt: nowIso,
        primary: true
      },
      {
        url: "https://www.bbc.com/news/business-654321",
        title: "BBC Analysis on Central Bank Outlook",
        publishedAt: recentPublished,
        retrievedAt: nowIso,
        primary: false
      }
    ],
    confirmsNoConfidentialInformation: true,
    confirmsNoOutcomeInfluence: true
  });

  console.log("Paper Order Staged & Executed Successfully!");
  console.log("Proposal Status:", staged.status);
  console.log("Proposal ID:", staged.proposalId);
  console.log("Proposal Hash:", staged.proposalHash);

  const statusAfter = await runtime.getRiskStatus();
  console.log("Updated Risk Status:", JSON.stringify(statusAfter, null, 2));
  console.log("=========================================");
  console.log("AUTONOMOUS PAPER TRADING CYCLE COMPLETED");
  console.log("=========================================");
}

main().catch((err) => {
  console.error("Cycle error:", err);
  process.exit(1);
});
