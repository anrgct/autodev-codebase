#!/usr/bin/env bash
# qr-temperature-sweep.sh
# 实验：QR-attention temperature 扫描，模拟不同"层深度"效果
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

RESULTS_DIR="$ROOT_DIR/experiment-results/qr-temp-sweep-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"

# 要测试的温度值
TEMPERATURES=(0.25 0.5 1.0 2.0 3.0 4.0)

echo "============================================"
echo "QR-Attention Temperature Sweep Experiment"
echo "Results dir: $RESULTS_DIR"
echo "Temperatures: ${TEMPERATURES[*]}"
echo "============================================"

SUMMARY_FILE="$RESULTS_DIR/summary.csv"
echo "temperature,hits,recall1,recall3,recall5,recall10,recall20,mrr,median_rank" > "$SUMMARY_FILE"

# Helper: extract first number after a label from eval output
extract_num() {
    local label="$1" file="$2"
    awk -v label="$label" '
        $0 ~ label {
            # find the number (percentage or decimal) after the label
            if (match($0, /[0-9]+(\.[0-9]+)?/)) {
                val = substr($0, RSTART, RLENGTH)
                # Remove trailing % for recall values
                gsub(/%$/, "", val)
                print val
                exit
            }
        }
    ' "$file"
}

for TEMP in "${TEMPERATURES[@]}"; do
    echo ""
    echo "========================================="
    echo ">>> QR_TEMPERATURE=$TEMP"
    echo "========================================="

    # [1] 重建索引
    echo "[1/2] Building index ..."
    QR_TEMPERATURE=$TEMP npx tsx src/cli.ts index --force --demo --log-level=error 2>&1 | tail -3

    # [2] 运行评估
    echo "[2/2] Running eval ..."
    EVAL_OUT="$RESULTS_DIR/eval-temp-${TEMP}.txt"
    set +e
    QR_TEMPERATURE=$TEMP python src/examples/eval_search.py > "$EVAL_OUT" 2>&1
    set -e

    # 提取关键指标
    HITS=$(extract_num "命中数:" "$EVAL_OUT")
    MRR=$(extract_num "MRR" "$EVAL_OUT")
    R1=$(extract_num "Recall@1:" "$EVAL_OUT")
    R3=$(extract_num "Recall@3:" "$EVAL_OUT")
    R5=$(extract_num "Recall@5:" "$EVAL_OUT")
    R10=$(extract_num "Recall@10:" "$EVAL_OUT")
    R20=$(extract_num "Recall@20:" "$EVAL_OUT")
    MEDIAN=$(extract_num "命中结果中位数排名:" "$EVAL_OUT")

    echo "  命中=${HITS:-?}/12  MRR=${MRR:-?}  R@10=${R10:-?}%  中位数=${MEDIAN:-?}"
    echo "$TEMP,${HITS:-?},${R1:-?},${R3:-?},${R5:-?},${R10:-?},${R20:-?},${MRR:-?},${MEDIAN:-?}" >> "$SUMMARY_FILE"
done

echo ""
echo "============================================"
echo "Experiment complete! Summary:"
echo "============================================"
column -t -s, "$SUMMARY_FILE"
echo ""
echo "Full results in: $RESULTS_DIR"
