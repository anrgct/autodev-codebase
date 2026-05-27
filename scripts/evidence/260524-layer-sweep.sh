#!/usr/bin/env bash
# layer-sweep.sh
# 实验：扫描不同 transformer 层提取 embedding 的检索质量
# 前置条件：llama.cpp embd_layer patch 已编译部署
#
# 用法:
#   ./layer-sweep.sh                    # 非对称模式：index 层变，search 固定 L23（默认）
#   SEARCH_LAYER=22 ./layer-sweep.sh    # 自定义 search 层
#   SYMMETRIC=1 ./layer-sweep.sh        # 对称模式：index 和 search 用相同层
#   LAYERS="22 20 18" ./layer-sweep.sh  # 自定义扫描层列表
#
# 此脚本通过 POOLING_LAYER 环境变量覆盖 index 层，
# 通过 embedderQueryPoolingLayer 控制 search 层（修改 demo config），
# 在实验结束后恢复原始配置。
#
# 实验发现：非对称配置（index L22 + search L23）MRR 最高（0.55 vs 0.37 对称）
# 原因：L22 hidden states 更干净（少 next-token 偏置），L23 更适合"提问"语义
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

RESULTS_DIR="$ROOT_DIR/experiment-results/layer-sweep-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"

# 测试层：基于全层扫描结果选择关键采样点
LAYERS=(${LAYERS:-23 22})

# 搜索层：默认 L23 (last)，支持非对称编码器
# 实验证实非对称层（index L22 + search L23）优于对称层（index L22 + search L22）
SEARCH_LAYER=${SEARCH_LAYER:-23}
if [[ "${SYMMETRIC:-0}" == "1" ]]; then
    SEARCH_LAYER="__auto__"  # 动态匹配当前 index layer
fi

echo "============================================"
echo "Embedding Layer Sweep Experiment"
echo "Results dir: $RESULTS_DIR"
echo "Layers: ${LAYERS[*]}"
if [[ "$SEARCH_LAYER" == "__auto__" ]]; then
    echo "Search Layer: symmetric (matches index)"
else
    echo "Search Layer: $SEARCH_LAYER (asymmetric)"
fi

# 打印当前配置关键参数
CONFIG_FILE="demo/autodev-config.json"
GGUF_PATH=$(grep -v '^[[:space:]]*//' "$CONFIG_FILE" | sed -n 's/.*"embedderGgufLlmPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
POOLING_MODE=$(grep -v '^[[:space:]]*//' "$CONFIG_FILE" | sed -n 's/.*"embedderPoolingMode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
echo "GGUF Model: $GGUF_PATH"
echo "Pooling Mode: $POOLING_MODE"
echo "============================================"

SUMMARY_FILE="$RESULTS_DIR/summary.csv"
echo "layer,hits,total,mrr,recall1,recall3,recall5,recall10,recall20,median_rank,avg_score" > "$SUMMARY_FILE"

# 备份当前 demo 配置
cp demo/autodev-config.json "$RESULTS_DIR/config-backup.json"

for LAYER in "${LAYERS[@]}"; do
    echo ""
    echo "========================================="
    echo ">>> Layer $LAYER"
    echo "========================================="

    # [1] 重建索引
    echo "[1/2] Building index (layer=$LAYER)..."
    set +e
    POOLING_LAYER=$LAYER npx tsx src/cli.ts index --force --demo --log-level=error 2>&1 | tail -5
    BUILD_EXIT=$?
    set -e

    if [ $BUILD_EXIT -ne 0 ]; then
        echo "  WARNING: Index build failed for layer $LAYER, skipping"
        echo "$LAYER,BUILD_FAILED,,,,,,,," >> "$SUMMARY_FILE"
        continue
    fi

    # [2] 运行评估
    # 非对称模式：索引用 POOLING_LAYER，搜索用 QUERY_POOLING_LAYER（默认 L23）
    # 对称模式：$SYMMETRIC=1 时 QUERY_POOLING_LAYER 匹配 POOLING_LAYER
    local_search_layer="$SEARCH_LAYER"
    if [[ "$SEARCH_LAYER" == "__auto__" ]]; then
        local_search_layer="$LAYER"
    fi
    echo "[2/2] Running eval (search layer=$local_search_layer)..."
    EVAL_OUT="$RESULTS_DIR/eval-layer-${LAYER}.txt"
    set +e
    QUERY_POOLING_LAYER=$local_search_layer python3 src/examples/eval_search.py > "$EVAL_OUT" 2>&1
    set -e

    # 提取指标
    HITS=$(grep '命中数:' "$EVAL_OUT" | grep -o '[0-9]\+' | head -1 || echo "0")
    TOTAL=$(grep '命中数:' "$EVAL_OUT" | grep -o '/ [0-9]\+' | grep -o '[0-9]\+' || echo "12")
    MRR=$(grep 'MRR' "$EVAL_OUT" | grep -o '[0-9]\+\.[0-9]\+' | head -1 || echo "0")
    R1=$(grep 'Recall@1:' "$EVAL_OUT" | grep -o '[0-9]\+\.[0-9]\+' | head -1 || echo "0")
    R3=$(grep 'Recall@3:' "$EVAL_OUT" | grep -o '[0-9]\+\.[0-9]\+' | head -1 || echo "0")
    R5=$(grep 'Recall@5:' "$EVAL_OUT" | grep -o '[0-9]\+\.[0-9]\+' | head -1 || echo "0")
    R10=$(grep 'Recall@10:' "$EVAL_OUT" | grep -o '[0-9]\+\.[0-9]\+' | head -1 || echo "0")
    R20=$(grep 'Recall@20:' "$EVAL_OUT" | grep -o '[0-9]\+\.[0-9]\+' | head -1 || echo "0")
    MEDIAN=$(grep '中位数排名' "$EVAL_OUT" | grep -o '[0-9]\+' | head -1 || echo "99")
    AVG_SCORE=$(grep '平均分数' "$EVAL_OUT" | grep -o '[0-9]\+\.[0-9]\+' | head -1 || echo "0")

    echo "  Hits: $HITS/$TOTAL | MRR: $MRR | R@10: $R10 | Median: $MEDIAN"
    echo "$LAYER,$HITS,$TOTAL,$MRR,$R1,$R3,$R5,$R10,$R20,$MEDIAN,$AVG_SCORE" >> "$SUMMARY_FILE"
done

# 恢复配置
cp "$RESULTS_DIR/config-backup.json" demo/autodev-config.json

echo ""
echo "============================================"
echo "Sweep complete!"
echo "Summary: $SUMMARY_FILE"
echo "============================================"
column -t -s',' "$SUMMARY_FILE"
