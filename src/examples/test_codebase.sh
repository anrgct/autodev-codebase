#!/bin/bash
#
# test_codebase.sh - 代码语义搜索测试工具
#
# 用法:
#   ./test_codebase.sh                                     # 默认搜索"处理异常"过滤 model.py
#   ./test_codebase.sh "用户认证" "src/**/*.ts" 20         # 自定义查询和过滤
#   ./test_codebase.sh "train" "" 30 --no-filter          # 不过滤路径
#
# 依赖:
#   - npx tsx (或构建后的 dist/cli.js)
#   - python3
#

set -euo pipefail

# =============================
# 1. 配置与参数解析
# =============================

DEFAULT_QUERY="where is the actual train method implementation in the source code?"
DEFAULT_FILTER="model.py"
DEFAULT_LIMIT=20

QUERY="${1:-$DEFAULT_QUERY}"
FILTER="${2:-$DEFAULT_FILTER}"
LIMIT="${3:-$DEFAULT_LIMIT}"
NO_FILTER="${4:-}"  # 传入任意值则跳过过滤器

# 确定 CLI 命令（优先用构建版本）
BUILT_CLI="npx tsx src/cli.ts"
if [ -f "$BUILT_CLI" ]; then
    CLI_CMD="node $BUILT_CLI"
else
    CLI_CMD="npx tsx src/cli.ts"
fi

# 构建 CLI 参数
CLI_ARGS=(
    search
    "$QUERY"
    --demo
    --limit "$LIMIT"
    --json
    --log-level error
)
if [ "$NO_FILTER" = "" ] && [ -n "$FILTER" ]; then
    CLI_ARGS+=(--path-filters "$FILTER")
fi

# =============================
# 2. 帮助函数
# =============================

print_header() { echo ""; echo "━━━ $1 ━━━"; }
print_ok()     { echo " ✔ $1"; }
print_warn()   { echo " ⚠ $1"; }
print_err()    { echo " ✖ $1"; }

# =============================
# 3. 执行搜索并提取 JSON
# =============================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  搜索测试"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  查询:     $QUERY"
echo "  过滤器:   ${FILTER:-（无）}"
echo "  限制数:   $LIMIT"
echo "  CLI:      $CLI_CMD"
echo ""

SEARCH_OUTPUT=$($CLI_CMD "${CLI_ARGS[@]}" 2>&1 || true)
JSON_DATA=$(echo "$SEARCH_OUTPUT" | awk '/^{/{found=1} found')

if [ -z "$JSON_DATA" ]; then
    print_err "未找到 JSON 输出"
    echo "CLI 输出内容:"
    echo "$SEARCH_OUTPUT"
    exit 1
fi

print_ok "JSON 数据提取成功"

# =============================
# 4. Python 分析处理 (临时文件传递 JSON)
# =============================

JSON_FILE=$(mktemp -t codebase_test.XXXXXX)
echo "$JSON_DATA" > "$JSON_FILE"

python3 /dev/stdin "$JSON_FILE" << 'PYEOF'
import json
import sys
import os
from collections import defaultdict
import statistics

json_path = sys.argv[1]
with open(json_path) as f:
    data = json.load(f)
os.unlink(json_path)  # 用完即删

def print_header(title):
    print(f"\n━━━ {title} ━━━")

def print_ok(msg):
    print(f" ✔ {msg}")

def print_warn(msg):
    print(f" ⚠ {msg}")

# 4.1 统一提取 snippets
def extract_snippets(data):
    """兼容新旧输出格式"""
    if 'snippets' in data:
        for s in data['snippets']:
            s['source_file'] = s.get('filePath', 'N/A')
        return data['snippets']
    elif 'files' in data:
        result = []
        for f in data['files']:
            fp = f.get('filePath', 'N/A')
            for s in f.get('snippets', []):
                s['source_file'] = fp
                result.append(s)
        return result
    return []

all_snippets = extract_snippets(data)
snippet_count = len(all_snippets)

print(f"\n  格式:          {'新格式' if 'snippets' in data else '旧格式'}")
print(f"  总片段数:     {snippet_count}")
if 'totalResults' in data:
    print(f"  结果总数:     {data['totalResults']}")
if 'totalSnippets' in data:
    print(f"  原始片段数:   {data['totalSnippets']}")
if 'duplicatesRemoved' in data:
    print(f"  重复移除数:   {data['duplicatesRemoved']}")

if snippet_count == 0:
    print("\n⚠ 没有找到匹配的代码片段")
    sys.exit(0)

# 4.2 按分数降序排序
sorted_snippets = sorted(all_snippets, key=lambda x: x.get('score', 0), reverse=True)

# 4.3 查找目标片段（包含 def train 且层级含 Model）
TARGET_CODE_KW = 'def train'
TARGET_HIER_KW = 'Model'

def find_target(snippets):
    for i, s in enumerate(snippets):
        code = s.get('code', '')
        hierarchy = s.get('hierarchy', '')
        if TARGET_CODE_KW in code and TARGET_HIER_KW in hierarchy:
            return i, s
    return None, None

target_idx, target = find_target(sorted_snippets)

# 4.x 输出前 20 个结果
print_header('前 20 个最高分结果')

if snippet_count == 0:
    print('  （空）')
else:
    for i, s in enumerate(sorted_snippets[:20]):
        score = s.get('score', 0)
        fp = s.get('source_file', 'N/A')
        lr = s.get('lineRange', 'N/A')
        hi = s.get('hierarchy', 'N/A')
        code_pv = s.get('code', '')[:60].replace('\n', ' ').strip()
        marker = ' ← 目标' if target_idx is not None and i == target_idx else ''
        print(f"  #{i+1:3d}  score={score:.4f}{marker}")
        print(f"       文件: {fp}")
        print(f"       行号: {lr}")
        print(f"       层级: {hi}")
        print(f"       预览: {code_pv}")
        if i < 19:
            print()

# 4.4 目标代码块详情
if target is not None:
    print_header('目标代码块详情')
    print(f"  排名:        第 {target_idx + 1} 位（共 {snippet_count} 个）")
    print(f"  分数:        {target.get('score', 'N/A'):.4f}")
    print(f"  文件:        {target.get('source_file', 'N/A')}")
    print(f"  行范围:      {target.get('lineRange', 'N/A')}")
    print(f"  层级:        {target.get('hierarchy', 'N/A')}")

    target_score = target['score']
    higher = sum(1 for s in sorted_snippets if s.get('score', 0) > target_score)
    same   = sum(1 for s in sorted_snippets if s.get('score', 0) == target_score)
    lower  = sum(1 for s in sorted_snippets if s.get('score', 0) < target_score)

    print(f"  分数更高:    {higher} 个 ({higher/snippet_count*100:.1f}%)")
    print(f"  分数相同:    {same} 个 ({same/snippet_count*100:.1f}%)")
    print(f"  分数更低:    {lower} 个 ({lower/snippet_count*100:.1f}%)")
else:
    print_warn(f'未找到包含 "{TARGET_CODE_KW}" 且层级含 "{TARGET_HIER_KW}" 的目标片段')

# 4.5 分数分布
scores = [s.get('score', 0) for s in sorted_snippets]
print_header('分数分布')
if scores:
    print(f"  最高分:      {max(scores):.4f}")
    print(f"  最低分:      {min(scores):.4f}")
    print(f"  平均分:      {statistics.mean(scores):.4f}")
    print(f"  中位数:      {statistics.median(scores):.4f}")
    if len(scores) > 1:
        print(f"  标准差:      {statistics.stdev(scores):.4f}")
else:
    print('  （无分数数据）')

# 4.6 按文件统计
print_header('按文件统计（Top 10）')
file_stats = defaultdict(lambda: {'count': 0, 'score_sum': 0.0, 'score_max': 0.0})
for s in all_snippets:
    fp = s.get('source_file', 'N/A')
    score = s.get('score', 0)
    file_stats[fp]['count'] += 1
    file_stats[fp]['score_sum'] += score
    file_stats[fp]['score_max'] = max(file_stats[fp]['score_max'], score)

print(f"  文件总数:    {len(file_stats)}")
for fp, st in sorted(file_stats.items(), key=lambda x: -x[1]['count'])[:10]:
    avg = st['score_sum'] / st['count'] if st['count'] else 0
    print(f"  {fp}")
    print(f"      片段数: {st['count']}, 平均分: {avg:.4f}, 最高分: {st['score_max']:.4f}")
PYEOF

# =============================
# 5. 完成
# =============================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  测试完成"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
