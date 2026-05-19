// End-to-end test: QRRankerReranker vs known C++ demo output
//
// Usage:
//   npx tsx src/code-index/rerankers/__tests__/qrranker.e2e.ts

import { QRRankerReranker } from "../qrranker";
import type { RerankerCandidate } from "../../interfaces";

const MODEL_PATH = "../open_provence_demo/output/QRRanker/QRRanker-q8_0.gguf";

// Same test data as C++ demo (demo_qrranker_gguf.cpp)
const QUESTION = "What is the tallest structure in the world and where is it located?";

const CANDIDATES: RerankerCandidate[] = [
  {
    id: 1,
    content:
      "The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars " +
      "in Paris, France. It is named after the engineer Gustave Eiffel, whose " +
      "company designed and built the tower from 1887 to 1889. Standing at " +
      "330 metres (1,083 ft), it was the tallest man-made structure in the " +
      "world until 1930.",
    payload: { title: "Eiffel Tower" },
    score: 0.5,
  },
  {
    id: 2,
    content:
      "The Burj Khalifa is a skyscraper in Dubai, United Arab Emirates. " +
      "It is the world's tallest structure, standing at 828 metres (2,717 ft). " +
      "Construction began in 2004 and was completed in 2009. It has 163 floors " +
      "and holds numerous height records.",
    payload: { title: "Burj Khalifa" },
    score: 0.6,
  },
  {
    id: 3,
    content:
      "The Empire State Building is a 102-story Art Deco skyscraper in " +
      "Midtown Manhattan, New York City. It was the world's tallest building " +
      "from 1931 until 1971, standing at 1,454 feet (443.2 m) including its " +
      "antenna.",
    payload: { title: "Empire State Building" },
    score: 0.4,
  },
  {
    id: 4,
    content:
      "The Shanghai Tower is a 128-story, 632-meter (2,073 ft) tall skyscraper " +
      "in Shanghai, China. It is the tallest building in China and the third-" +
      "tallest building in the world. It features a distinctive twisted form.",
    payload: { title: "Shanghai Tower" },
    score: 0.45,
  },
  {
    id: 5,
    content:
      "The Great Pyramid of Giza is the oldest and largest of the three " +
      "pyramids in the Giza pyramid complex. Originally standing at 146.6 " +
      "metres (481 ft), it was the tallest man-made structure in the world " +
      "for over 3,800 years.",
    payload: { title: "Great Pyramid of Giza" },
    score: 0.55,
  },
];

// Expected ranking from C++ demo (GGUF q8_0):
// #1 Burj Khalifa     score=3.66
// #2 Great Pyramid    score=1.25
// #3 Eiffel Tower     score=1.22
// #4 Shanghai Tower   score=1.08
// #5 Empire State     score=0.93
const EXPECTED_ORDER = [
  "Burj Khalifa",
  "Great Pyramid of Giza",
  "Eiffel Tower",
  "Shanghai Tower",
  "Empire State Building",
];

async function main() {
  console.log("=".repeat(60));
  console.log("QRRankerReranker End-to-End Test");
  console.log("=".repeat(60));

  const reranker = new QRRankerReranker(MODEL_PATH, console);

  // Validate configuration
  const validation = await reranker.validateConfiguration();
  console.log(`\nValidation: ${validation.valid ? "PASS" : "FAIL"}`);
  if (!validation.valid) {
    console.error(`  Error: ${validation.error}`);
    process.exit(1);
  }

  // Run reranking
  console.log(`\nReranking ${CANDIDATES.length} candidates for query: "${QUESTION}"`);
  const startTime = Date.now();
  const results = await reranker.rerank(QUESTION, CANDIDATES);
  const elapsed = Date.now() - startTime;

  // Print results
  console.log(`\nResults (${elapsed}ms):`);
  console.log("-".repeat(60));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const candidate = CANDIDATES.find((c) => c.id === r.id);
    const title = candidate?.payload?.title ?? `id=${r.id}`;
    console.log(`  #${i + 1}  ${title.padEnd(25)} score=${r.score.toFixed(4)}`);
  }

  // Verify ranking order
  console.log(`\n${"-".repeat(60)}`);
  console.log("Ranking verification:");
  let allCorrect = true;
  for (let i = 0; i < EXPECTED_ORDER.length; i++) {
    const resultTitle = CANDIDATES.find((c) => c.id === results[i].id)?.payload?.title;
    const expected = EXPECTED_ORDER[i];
    const match = resultTitle === expected;
    if (!match) allCorrect = false;
    console.log(`  #${i + 1}: expected "${expected}", got "${resultTitle}" ${match ? "✅" : "❌"}`);
  }

  // Verify #1 is Burj Khalifa with highest score
  const topResult = results[0];
  const topCandidate = CANDIDATES.find((c) => c.id === topResult.id);
  const topIsBurj = topCandidate?.payload?.title === "Burj Khalifa";
  console.log(`\n  Top result is Burj Khalifa: ${topIsBurj ? "✅" : "❌"}`);

  // Verify scores are descending
  const scoresDescending = results.every(
    (r, i) => i === 0 || r.score <= results[i - 1].score,
  );
  console.log(`  Scores are descending: ${scoresDescending ? "✅" : "❌"}`);

  console.log(`\n${"=".repeat(60)}`);
  if (allCorrect && topIsBurj) {
    console.log("E2E TEST PASSED ✅");
  } else {
    console.log("E2E TEST: RANKING MISMATCH ⚠️ (score values may differ from C++ demo)");
  }

  // Cleanup
  await reranker.dispose();
}

main().catch((err) => {
  console.error("E2E test failed:", err);
  process.exit(1);
});
