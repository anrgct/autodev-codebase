#!/usr/bin/env bash
# 交叉实验：层深度 × 池化方式（last-token / mean）
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

RESULTS_DIR="$ROOT_DIR/experiment-results/layer-pooling-cross-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"
cp demo/autodev-config.json "$RESULTS_DIR/config-backup.json"

# Restore qr-attention at end
cleanup() { cp "$RESULTS_DIR/config-backup.json" demo/autodev-config.json; }
trap cleanup EXIT

LAYERS=(23 22 20 18 15 12 8)
MODES=("last-token" "mean" "qr-weighted" "late-chunking")

echo "layer,mode,hits,total,mrr,recall1,recall3,recall5,recall10,recall20,median" > "$RESULTS_DIR/summary.csv"

for MODE in "${MODES[@]}"; do
    # sed the pooling mode in JSONC config
    sed -i '' 's/"embedderPoolingMode": "[^"]*"/"embedderPoolingMode": "'"$MODE"'"/' demo/autodev-config.json

    for LAYER in "${LAYERS[@]}"; do
        LABEL="L${LAYER}-${MODE}"
        echo ""
        echo "=== $LABEL ==="

        set +e
        POOLING_LAYER=$LAYER npx tsx src/cli.ts index --force --demo --log-level=error 2>&1 | tail -3
        BUILD_EXIT=$?
        set -e

        if [ $BUILD_EXIT -ne 0 ]; then
            echo "  BUILD FAILED"
            echo "$LAYER,$MODE,BUILD_FAIL,,,,,,," >> "$RESULTS_DIR/summary.csv"
            continue
        fi

        EVAL_OUT="$RESULTS_DIR/eval-${LABEL}.txt"
        set +e
        python3 src/examples/eval_search.py > "$EVAL_OUT" 2>&1
        set -e

        HITS=$(grep '命中数:' "$EVAL_OUT" | grep -o '[0-9]\+' | head -1 || echo "0")
        TOTAL=$(grep '命中数:' "$EVAL_OUT" | grep -o '/ [0-9]\+' | grep -o '[0-9]\+' || echo "12")
        MRR=$(grep 'MRR' "$EVAL_OUT" | grep -o '[0-9]\+\.[0-9]\+' | head -1 || echo "0")
        R1=$(grep 'Recall@1:' "$EVAL_OUT" | grep -o '[0-9]\+\.[0-9]\+' | head -1 || echo "0")
        R3=$(grep 'Recall@3:' "$EVAL_OUT" | grep -o '[0-9]\+\.[0-9]\+' | head -1 || echo "0")
        R5=$(grep 'Recall@5:' "$EVAL_OUT" | grep -o '[0-9]\+\.[0-9]\+' | head -1 || echo "0")
        R10=$(grep 'Recall@10:' "$EVAL_OUT" | grep -o '[0-9]\+\.[0-9]\+' | head -1 || echo "0")
        R20=$(grep 'Recall@20:' "$EVAL_OUT" | grep -o '[0-9]\+\.[0-9]\+' | head -1 || echo "0")
        MEDIAN=$(grep '中位数排名' "$EVAL_OUT" | grep -o '[0-9]\+' | head -1 || echo "99")

        echo "  $HITS/$TOTAL  MRR=$MRR  R@1=$R1  R@10=$R10  median=$MEDIAN"
        echo "$LAYER,$MODE,$HITS,$TOTAL,$MRR,$R1,$R3,$R5,$R10,$R20,$MEDIAN" >> "$RESULTS_DIR/summary.csv"
    done
done

echo ""
echo "============================================"
echo "Done!"
echo "============================================"
column -t -s',' "$RESULTS_DIR/summary.csv"
