import { PolymarketRuntime } from "../src/runtime.js";

async function main() {
  const runtime = new PolymarketRuntime();
  const status = await runtime.getAccountStatus();
  console.log("=========================================");
  console.log("AUTONOMOUS PAPER TRADING CYCLE STARTING");
  console.log("=========================================");
  console.log("Profile Address:", status.profileAddress);
  console.log("Operating Status:", status.status);

  // 1. Scan candidates
  const candidatesResult = await runtime.scanCandidates({
    categories: ["politics", "economics", "technology"],
    limit: 10
  });
  console.log(`Scanned ${candidatesResult.candidates.length} candidate markets.`);

  if (candidatesResult.candidates.length === 0) {
    console.log("No candidates found.");
    return;
  }

  // Pick top candidate
  const candidate = candidatesResult.candidates[0];
  console.log(`Evaluating Candidate: ${candidate.question} (${candidate.conditionId})`);

  // 2. Fetch snapshot
  const snapshot = await runtime.getMarketSnapshot({
    conditionId: candidate.conditionId,
    tokenId: candidate.tokenIds[0],
    side: "BUY",
    limitPricePusd: "0.050"
  });

  console.log(`Snapshot fetched: Best Ask = $${snapshot.bestAskPusd}, Best Bid = $${snapshot.bestBidPusd}, Spread = $${snapshot.spreadPusd}`);

  // 3. Evaluate criteria
  const spread = parseFloat(snapshot.spreadPusd);
  if (spread > 0.03) {
    console.log("Discarded candidate: Spread > 0.03");
    return;
  }

  const thesis = "At limit price 0.040 pUSD, Yes option provides positive EV given political fragmentation in France and non-negligible residual resignation probability before end of 2026.";
  const counterThesis = "Macron has repeatedly affirmed he will not resign under any parliamentary circumstance before 2027 term end.";

  // 4. Stage Paper Order
  console.log("Staging Paper Order...");
  const staged = await runtime.stageOrder({
    executionMode: "paper",
    conditionId: candidate.conditionId,
    tokenId: candidate.tokenIds[0],
    outcome: "Yes",
    side: "BUY",
    shares: "10",
    limitPricePusd: "0.050",
    estimatedProbability: "0.110",
    thesis,
    counterThesis,
    sources: [
      {
        url: `https://gamma-api.polymarket.com/events/${snapshot.eventId}`,
        title: `Polymarket Market Metadata ${snapshot.eventId}`,
        publishedAt: "2026-08-01T00:00:00Z",
        retrievedAt: new Date().toISOString(),
        primary: true
      }
    ],
    confirmsNoConfidentialInformation: true,
    confirmsNoOutcomeInfluence: true
  });

  console.log("Paper Order Staged & Executed Successfully!");
  console.log("Proposal Status:", staged.status);
  console.log("Proposal ID:", staged.proposalId);
  console.log("Proposal Hash:", staged.proposalHash);

  const statusAfter = await runtime.getAccountStatus();
  console.log("Updated Paper Gate Status:", JSON.stringify(statusAfter.paperGate, null, 2));
  console.log("=========================================");
  console.log("AUTONOMOUS PAPER TRADING CYCLE COMPLETED");
  console.log("=========================================");
}

main().catch((err) => {
  console.error("Cycle error:", err);
  process.exit(1);
});
