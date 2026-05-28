/**
 * Reproduce and characterize kq_soft_max NaN / zero data from QRRanker.
 *
 * Usage:
 *   npx tsx src/examples/repro-kq-softmax-nan.ts
 *   npx tsx src/examples/repro-kq-softmax-nan.ts --targets=12000,15000,22000
 *   npx tsx src/examples/repro-kq-softmax-nan.ts --batch-size=4096 --target=15000
 *   npx tsx src/examples/repro-kq-softmax-nan.ts --gpu=false --target=15000
 *
 * The script intentionally runs one context per target so the output shows
 * whether failures correlate with total tokens, expected JS decode batches,
 * or the query range's batch position.
 */

import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp";

const MODEL_PATH = "/Users/anrgct/workspace/open_provence_demo/output/QRRanker/QRRanker-q8_0.gguf";
const DEFAULT_BATCH_SIZE = 8192;
const DEFAULT_TARGETS = [10820, 14972, 21630];
const QUERY_LINE = "\n\nQuery: What is the meaning of this test?\n";
const FILLER =
  "This is a test document about machine learning and artificial intelligence. " +
  "It contains various topics related to neural networks, deep learning, and natural language processing. " +
  "The goal is to create enough tokens to trigger the multi-micro-batch code path.\n\n";

// QR_HEADS from QRRanker config
const QR_HEADS: Array<{ layer: number; head: number }> = [
  { layer: 20, head: 15 }, { layer: 21, head: 11 }, { layer: 17, head: 27 },
  { layer: 23, head: 10 }, { layer: 22, head:  4 }, { layer: 21, head: 10 },
  { layer: 21, head:  8 }, { layer: 21, head: 18 }, { layer: 18, head: 15 },
  { layer: 18, head: 19 }, { layer: 17, head: 25 }, { layer: 17, head: 17 },
  { layer: 24, head: 13 }, { layer: 17, head:  4 }, { layer: 19, head: 12 },
  { layer: 21, head: 31 },
];

type GpuOption = "metal" | false;

type Options = {
  batchSize: number;
  gpu: GpuOption;
  targets: number[];
};

type BatchRange = {
  start: number;
  end: number;
};

type CaseResult = {
  target: number;
  tokens: number;
  okHeads: number;
  nanHeads: number;
  zeroHeads: number;
  shortHeads: number;
  missingHeads: number;
  scoreNonZero: number;
};

function parseOptions(): Options {
  const options: Options = {
    batchSize: DEFAULT_BATCH_SIZE,
    gpu: "metal",
    targets: DEFAULT_TARGETS,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--batch-size=")) {
      options.batchSize = parsePositiveInt(arg.slice("--batch-size=".length), "batch-size");
    } else if (arg.startsWith("--target=")) {
      options.targets = [parsePositiveInt(arg.slice("--target=".length), "target")];
    } else if (arg.startsWith("--targets=")) {
      options.targets = arg
        .slice("--targets=".length)
        .split(",")
        .map((value) => parsePositiveInt(value.trim(), "targets"));
    } else if (arg === "--gpu=false" || arg === "--cpu") {
      options.gpu = false;
    } else if (arg === "--gpu=metal") {
      options.gpu = "metal";
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function expectedDecodeBatches(totalTokens: number, batchSize: number): BatchRange[] {
  const batches: BatchRange[] = [];
  for (let start = 0; start < totalTokens; start += batchSize) {
    batches.push({ start, end: Math.min(totalTokens, start + batchSize) });
  }
  return batches;
}

function describeQueryBatches(queryStart: number, queryEnd: number, batches: BatchRange[]): string {
  return batches
    .map((batch, index) => {
      const start = Math.max(queryStart, batch.start);
      const end = Math.min(queryEnd, batch.end);
      if (start >= end) return null;
      return `#${index + 1}[${batch.start},${batch.end}) queryLocal=[${start - batch.start},${end - batch.start})`;
    })
    .filter((value): value is string => value != null)
    .join("; ");
}

function buildPromptForAtLeastTokens(model: any, targetTokens: number): { prompt: string; tokens: number[] } {
  const parts: string[] = [];
  let prompt = QUERY_LINE;
  let tokens = model.tokenize(prompt) as number[];

  while (tokens.length < targetTokens) {
    parts.push(FILLER);
    prompt = parts.join("") + QUERY_LINE;
    tokens = model.tokenize(prompt) as number[];
  }

  return { prompt, tokens };
}

function countValues(data: Float32Array, start: number, length: number): {
  nan: number;
  zero: number;
  finite: number;
  positive: number;
  sum: number;
  max: number;
} {
  let nan = 0;
  let zero = 0;
  let finite = 0;
  let positive = 0;
  let sum = 0;
  let max = 0;

  for (let i = start; i < start + length; i++) {
    const value = data[i];
    if (Number.isNaN(value)) {
      nan++;
    } else {
      finite++;
      sum += value;
      if (value === 0) zero++;
      if (value > 0) positive++;
      if (value > max) max = value;
    }
  }

  return { nan, zero, finite, positive, sum, max };
}

async function runCase(model: any, options: Options, target: number): Promise<CaseResult> {
  const { tokens } = buildPromptForAtLeastTokens(model, target);
  const queryTokens = model.tokenize(QUERY_LINE) as number[];
  const queryStart = tokens.length - queryTokens.length;
  const queryEnd = tokens.length;
  const nQueryTokens = queryEnd - queryStart;
  const batches = expectedDecodeBatches(tokens.length, options.batchSize);

  console.log(`\n[case] target=${target} actualTokens=${tokens.length} batchSize=${options.batchSize}`);
  console.log(`[case] expected decode batches: ${batches.map((batch) => batch.end - batch.start).join(" + ")}`);
  console.log(`[case] query range: [${queryStart}, ${queryEnd}) len=${nQueryTokens}`);
  console.log(`[case] query batch coverage: ${describeQueryBatches(queryStart, queryEnd, batches) || "none"}`);

  const context = await model.createContext({
    contextSize: Math.max(32768, tokens.length + 256),
    batchSize: options.batchSize,
    sequences: 1,
    flashAttention: false,
    collectKqSoftMax: true,
  }) as any;

  try {
    context.setKqSoftMaxQueryRange(queryStart, queryEnd);

    const sequence = context.getSequence();
    const startedAt = Date.now();
    await sequence.evaluateWithoutGeneratingNewTokens(tokens);
    console.log(`[case] eval done in ${Date.now() - startedAt}ms`);

    const shape = context.getKqSoftMaxShape();
    const nKv: number = shape.nKv;
    const nTokens: number = shape.nTokens;
    const nHead: number = shape.nHead;
    const layers: number[] = shape.layers;

    console.log(
      `[case] kq_soft_max shape: nKv=${nKv}, nTokens=${nTokens}, nHead=${nHead}, ` +
      `nLayers=${shape.nLayers}, layers=[${layers.join(",")}]`,
    );

    if (nTokens !== nQueryTokens) {
      console.log(`[case] shape warning: nTokens=${nTokens} differs from query token count=${nQueryTokens}`);
    }

    const perKvScores = new Float32Array(nKv);
    let okHeads = 0;
    let nanHeads = 0;
    let zeroHeads = 0;
    let shortHeads = 0;
    let missingHeads = 0;

    for (const { layer, head } of QR_HEADS) {
      if (!layers.includes(layer)) {
        console.log(`[head] L${layer} H${head}: missing layer`);
        missingHeads++;
        continue;
      }

      const layerData = context.getKqSoftMax(layer) as Float32Array | undefined;
      if (!layerData) {
        console.log(`[head] L${layer} H${head}: missing data`);
        missingHeads++;
        continue;
      }

      const headOffset = head * nTokens * nKv;
      const headLength = nTokens * nKv;
      const requiredLength = headOffset + headLength;
      if (layerData.length < requiredLength) {
        shortHeads++;
        console.log(
          `[head] L${layer} H${head}: short data length=${layerData.length}, ` +
          `required=${requiredLength}, headOffset=${headOffset}`,
        );
        continue;
      }

      const stats = countValues(layerData, headOffset, headLength);
      const firstKvStats = countValues(layerData, headOffset, Math.min(nTokens * Math.min(8, nKv), headLength));

      const bytesOffset = headOffset * Float32Array.BYTES_PER_ELEMENT;
      const mbOffset = (bytesOffset / 1024 / 1024).toFixed(1);

      if (stats.nan > 0) {
        nanHeads++;
        console.log(
          `[head] L${layer} H${head}: NaN=${stats.nan}/${headLength} ` +
          `finite=${stats.finite} positive=${stats.positive} offset=${mbOffset}MB`,
        );
        continue;
      }

      if (stats.positive === 0) {
        zeroHeads++;
        console.log(
          `[head] L${layer} H${head}: zero/all-nonpositive finite=${stats.finite}/${headLength} ` +
          `samplePositive=${firstKvStats.positive} offset=${mbOffset}MB`,
        );
        continue;
      }

      okHeads++;
      console.log(
        `[head] L${layer} H${head}: OK positive=${stats.positive}/${headLength} ` +
        `sum=${stats.sum.toExponential(3)} max=${stats.max.toExponential(3)} offset=${mbOffset}MB`,
      );

      for (let q = 0; q < nTokens; q++) {
        const rowOffset = headOffset + q * nKv;
        for (let kv = 0; kv < nKv; kv++) {
          perKvScores[kv] += layerData[rowOffset + kv];
        }
      }
    }

    let scoreNonZero = 0;
    let scoreSum = 0;
    let scoreMax = 0;
    for (let kv = 0; kv < nKv; kv++) {
      const value = perKvScores[kv];
      if (value > 0) {
        scoreNonZero++;
        scoreSum += value;
        if (value > scoreMax) scoreMax = value;
      }
    }

    console.log(
      `[case] summary: okHeads=${okHeads}, nanHeads=${nanHeads}, zeroHeads=${zeroHeads}, ` +
      `shortHeads=${shortHeads}, missingHeads=${missingHeads}`,
    );
    console.log(
      `[case] perKvScores: nonZero=${scoreNonZero}/${nKv} ` +
      `sum=${scoreSum.toFixed(6)} max=${scoreMax.toFixed(6)}`,
    );

    return { target, tokens: tokens.length, okHeads, nanHeads, zeroHeads, shortHeads, missingHeads, scoreNonZero };
  } finally {
    await context.dispose();
  }
}

async function main() {
  const options = parseOptions();

  console.log(`[repro] Loading model: ${MODEL_PATH}`);
  console.log(`[repro] gpu=${options.gpu === false ? "false" : options.gpu}, batchSize=${options.batchSize}`);
  const llama = await getLlama({ logLevel: LlamaLogLevel.info, gpu: options.gpu });
  const model = await llama.loadModel({ modelPath: MODEL_PATH });
  console.log("[repro] Model loaded");

  const results: CaseResult[] = [];
  for (const target of options.targets) {
    results.push(await runCase(model, options, target));
  }

  console.log("\n[repro] matrix:");
  for (const result of results) {
    console.log(
      `[repro] target=${result.target} tokens=${result.tokens} ok=${result.okHeads} ` +
      `nan=${result.nanHeads} zero=${result.zeroHeads} short=${result.shortHeads} missing=${result.missingHeads} ` +
      `scoreNonZero=${result.scoreNonZero}`,
    );
  }

  const failed = results.some((result) =>
    result.nanHeads > 0 || result.zeroHeads > 0 || result.shortHeads > 0 || result.scoreNonZero === 0,
  );
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error("[repro] Fatal:", err);
  process.exitCode = 1;
});
