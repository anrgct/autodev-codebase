#!/usr/bin/env bash
# evidence-reproduce-bug.sh
# 全链路复现：jina-v5 pooling_type=LAST vs NONE 的检索效果对比
#
# 用法:
#   bash src/examples/evidence-reproduce-bug.sh
#
# 前置条件:
#   - Qdrant 运行在 localhost:6333
#   - GGUF 文件已准备好:
#       .../v5-nano-retrieval-Q8_0-pooling-LAST.gguf
#       .../v5-nano-retrieval-Q8_0-pooling-NONE.gguf

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_DIR"

GGUF_BASE="/Users/anrgct/llm_models/jinaai/jina-embeddings-v5-text-nano-retrieval-GGUF/v5-nano-retrieval-Q8_0"
GGUF_LAST="${GGUF_BASE}-pooling-LAST.gguf"
GGUF_NONE="${GGUF_BASE}-pooling-NONE.gguf"

echo "════════════════════════════════════════════════════════"
echo "  jina-v5 pooling_type 对比全链路复现"
echo "════════════════════════════════════════════════════════"
echo ""
echo "  LAST GGUF: $GGUF_LAST"
echo "  NONE GGUF: $GGUF_NONE"
echo ""

# ── 辅助函数 ──
run_test() {
    local label="$1"
    local gguf_path="$2"

    echo "──────────────────────────────────────────────────────"
    echo "  $label"
    echo "──────────────────────────────────────────────────────"

    # 1. 修改 config（provider 已预设为 llamacpp-llm，无需改）
    npx tsx src/cli.ts config --set "embedderGgufLlmPath=$gguf_path" --path=demo 2>&1 | grep -v "npm warn" | tail -1
    npx tsx src/cli.ts config --set "embedderPoolingMode=last-token" --path=demo 2>&1 | grep -v "npm warn" | tail -1
    echo "  Config: embedderGgufLlmPath → $(basename "$gguf_path")"

    # 2. 重建索引
    echo ""
    echo "  Re-indexing..."
    npm run dev -- index --force --demo 2>&1 | tail -3

    # 3. 运行 eval
    echo ""
    echo "  Running eval..."
    python3 src/examples/eval_search.py 2>&1 || true
    echo ""
}

# ── 运行两组测试 ──
run_test "PASS 1: pooling_type=LAST" "$GGUF_LAST"
run_test "PASS 2: pooling_type=NONE" "$GGUF_NONE"

# ── 恢复 config 到 MiniCPM ──
npx tsx src/cli.ts config --set "embedderGgufLlmPath=/Users/anrgct/llm_models/openbmb/MiniCPM-V-4.6-gguf/MiniCPM-V-4_6-Q8_0.gguf" --path=demo 2>&1 | grep -v "npm warn" | tail -1

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Done. Config restored to MiniCPM."
echo "════════════════════════════════════════════════════════"
