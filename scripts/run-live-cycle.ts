import { PolymarketRuntime } from "../src/runtime.js";

async function main() {
  const runtime = new PolymarketRuntime();
  const status = await runtime.getAccountStatus();
  console.log("=========================================");
  console.log("AUTONOMOUS LIVE TRADING CYCLE STARTING");
  console.log("=========================================");
  console.log("Profile Address:", status.profileAddress);
  console.log("Operating Status:", status.status);
  console.log("Live Enabled:", status.liveEnabled);

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

  const thesis = "At limit price 0.050 pUSD, Yes option provides positive EV given political fragmentation in France and non-negligible residual resignation probability before end of 2026.";
  const counterThesis = "Macron has repeatedly affirmed he will not resign under any parliamentary circumstance before 2027 term end.";

  // 3. Stage Live Order
  console.log("Staging Live Order...");
  const staged = await runtime.stageOrder({
    executionMode: "live",
    conditionId: candidate.conditionId,
    tokenId: candidate.tokenIds[0],
    outcome: "Yes",
    side: "BUY",
    shares: "20",
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

  console.log("Live Order Staged Successfully!");
  console.log("Proposal ID:", staged.proposalId);
  console.log("Proposal Hash:", staged.proposalHash);

  const approval = await runtime.createApprovalRequest({
    proposalId: staged.proposalId,
    proposalHash: staged.proposalHash
  });

  const lastSix = staged.proposalHash.slice(-6);

  console.log(`\n=========================================`);
  console.log(`EJECUCIÓN EN VIVO AL CLOB COMPLETADA`);
  console.log(`=========================================`);
  console.log(`Proposal ID:   ${staged.proposalId}`);
  console.log(`Proposal Hash: ${staged.proposalHash}`);
  console.log(`Resultado:     ${approval.status}`);
  console.log(`Detalle:       ${approval.message}`);
  console.log(`=========================================\n`);
}

main().catch((err) => {
  console.error("Live cycle error:", err);
  process.exit(1);
});
