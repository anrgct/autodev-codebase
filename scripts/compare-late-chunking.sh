#!/bin/bash
# Late Chunking vs Last-Token 一键对比脚本
# 用法: bash scripts/compare-late-chunking.sh
#
# 依赖: Qdrant 已在 localhost:6333 运行，demo/autodev-config.json 配置正确

set -e

DEMO_DIR="$(cd "$(dirname "$0")/.." && pwd)/demo"
CONFIG="$DEMO_DIR/autodev-config.json"
QUERY="capital of the country"

# 保存原始配置
ORIGINAL=$(grep embedderPoolingMode "$CONFIG" | head -1)

echo "=========================================="
echo " Late Chunking vs Last-Token 对比测试"
echo " 查询: \"$QUERY\""
echo " 文件: demo/city-facts.md (元数据零泄漏)"
echo "=========================================="
echo ""

run_test() {
    local MODE=$1
    local LABEL=$2

    echo "--- 切换到 $LABEL ---"
    if [ "$MODE" = "late-chunking" ]; then
        sed -i '' 's/"embedderPoolingMode": "[^"]*"/"embedderPoolingMode": "late-chunking"/' "$CONFIG"
    else
        sed -i '' 's/"embedderPoolingMode": "[^"]*"/"embedderPoolingMode": "last-token"/' "$CONFIG"
    fi

    echo "重新索引..."
    npx tsx src/cli.ts index --force --demo 2>/dev/null

    echo "搜索..."
    npx tsx src/cli.ts search "$QUERY" --demo --limit=10 --json 2>/dev/null \
        | python3 -c "
import json, sys
data = json.load(sys.stdin)
print('')
print(f'=== {data[\"query\"]} ===')
print('')
chunks = [s for s in data['snippets'] if 'city-facts' in s['filePath']]
if not chunks:
    print('  (无 city-facts.md 结果)')
else:
    for s in chunks:
        name = s['hierarchy'].split('>')[-1].strip()
        lines = s['code'].strip()[:65].replace(chr(10),' ')
        print(f'  {s[\"score\"]:.3f}  {name:10s} | {lines}...')
print('')
"
}

# Last-Token
run_test "last-token" "Last-Token"

# Late-Chunking
run_test "late-chunking" "Late-Chunking"

# 恢复原始配置
echo "--- 恢复原始配置 ---"
if echo "$ORIGINAL" | grep -q "late-chunking"; then
    sed -i '' 's/"embedderPoolingMode": "[^"]*"/"embedderPoolingMode": "late-chunking"/' "$CONFIG"
else
    sed -i '' 's/"embedderPoolingMode": "[^"]*"/"embedderPoolingMode": "last-token"/' "$CONFIG"
fi

echo ""
echo "=========================================="
echo " 关键看点:"
echo "   Two 块不含 capital 也不含 country，"
echo "   last-token 下搜索不到，late-chunking 下出现"
echo "   Four 块同样从无到有"
echo "=========================================="
