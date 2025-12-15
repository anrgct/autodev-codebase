#!/bin/bash
query='Instruct: Given a codebase search query, retrieve relevant code snippets or document that answer the query. \nQuery: where is the actual train method implementation in the source code?'
filter='model.py'
echo "=== 开始 codebase 搜索测试 ==="
echo "搜索查询: $query"
echo "路径过滤器: $filter"
echo ""

# 执行搜索并处理结果
npx tsx src/cli.ts --demo --search="$query" --path-filters="$filter" --json 2>&1 | awk '/^{/ {found=1} found' | python3 -c "
import json
import sys

data = json.load(sys.stdin)

# 检查新的输出格式
if 'snippets' in data:
    # 新格式: snippets 直接在根级别
    all_snippets = []
    for snippet in data.get('snippets', []):
        snippet['source_file'] = snippet.get('filePath', 'N/A')
        all_snippets.append(snippet)

    print(f'检测到新格式输出')
    print(f'总 snippets 数: {len(all_snippets)}')
    print(f'总结果数: {data.get(\"totalResults\", \"N/A\")}')
    print(f'总代码片段数: {data.get(\"totalSnippets\", \"N/A\")}')
    print(f'重复移除数: {data.get(\"duplicatesRemoved\", \"N/A\")}')
elif 'files' in data:
    # 旧格式: files 数组
    all_snippets = []
    for file_data in data.get('files', []):
        file_path = file_data.get('filePath', 'N/A')
        print(f'文件: {file_path}, 平均分数: {file_data.get(\"avgScore\", \"N/A\"):.3f}, 代码片段数: {file_data.get(\"snippetCount\", 0)}')
        for snippet in file_data.get('snippets', []):
            snippet['source_file'] = file_path
            all_snippets.append(snippet)

    print(f'\\n总 snippets 数: {len(all_snippets)}')
else:
    print(f'错误: 无法识别的输出格式')
    print(f'数据键: {list(data.keys())}')
    sys.exit(1)

# 按分数降序排序
sorted_snippets = sorted(all_snippets, key=lambda x: x.get('score', 0), reverse=True)

print('\\n=== 按分数重新排序后的结果 ===')

# 1. 查找目标代码块在重新排序后的排名
target_found = False
for i, snippet in enumerate(sorted_snippets):
    code = snippet.get('code', '')
    if 'def train' in code and 'Model' in snippet.get('hierarchy', ''):
        print(f'\\n1. 目标代码块按分数排序后的排名: 第 {i+1} 位')
        print(f'   分数: {snippet.get(\"score\", \"N/A\")}')
        print(f'   文件: {snippet.get(\"source_file\", \"N/A\")}')
        print(f'   行范围: {snippet.get(\"lineRange\", \"N/A\")}')
        print(f'   层级: {snippet.get(\"hierarchy\", \"N/A\")}')
        target_found = True
        break

if not target_found:
    print('未找到目标代码块')

# 2. 查看前20个最高分的结果
print('\\n2. 前20个最高分的结果:')
for i, snippet in enumerate(sorted_snippets[:20]):
    score = snippet.get('score', 0)
    file_path = snippet.get('source_file', 'N/A')
    line_range = snippet.get('lineRange', 'N/A')
    hierarchy = snippet.get('hierarchy', 'N/A')
    code_preview = snippet.get('code', '')[:50].replace('\n', ' ')
    print(f'   第 {i+1:3d} 位: 分数={score:.3f}, 文件={file_path}')
    print(f'       行范围={line_range}, 层级={hierarchy}')
    print(f'       代码预览: {code_preview}...')
    if i < 19:
        print()

# 3. 查看分数分布
print('\\n3. 分数分布统计:')
scores = [s.get('score', 0) for s in sorted_snippets]
if scores:
    print(f'   最高分: {max(scores):.3f}')
    print(f'   最低分: {min(scores):.3f}')
    print(f'   平均分: {sum(scores)/len(scores):.3f}')
    print(f'   中位数: {sorted(scores)[len(scores)//2]:.3f}')
else:
    print('   没有分数数据')

# 4. 查看目标代码块周围的分数情况
if target_found:
    target_score = None
    for i, snippet in enumerate(sorted_snippets):
        code = snippet.get('code', '')
        if 'def train' in code and 'Model' in snippet.get('hierarchy', ''):
            target_score = snippet.get('score', 0)
            target_index = i
            break

    if target_score is not None:
        print(f'\\n4. 目标代码块分数对比:')
        print(f'   目标代码块分数: {target_score:.3f}')
        print(f'   目标代码块文件: {sorted_snippets[target_index].get(\"source_file\", \"N/A\")}')

        # 统计有多少个结果分数更高
        higher_count = sum(1 for s in sorted_snippets if s.get('score', 0) > target_score)
        same_count = sum(1 for s in sorted_snippets if s.get('score', 0) == target_score)
        lower_count = sum(1 for s in sorted_snippets if s.get('score', 0) < target_score)

        print(f'   分数更高的结果数: {higher_count}')
        print(f'   分数相同的结果数: {same_count}')
        print(f'   分数更低的结果数: {lower_count}')
        if sorted_snippets:
            print(f'   百分比位置: 前 {higher_count/len(sorted_snippets)*100:.1f}% 的结果分数更高')

# 5. 按文件统计结果
print('\\n5. 按文件统计:')
file_stats = {}
for snippet in all_snippets:
    file_path = snippet.get('source_file', 'N/A')
    if file_path not in file_stats:
        file_stats[file_path] = {'count': 0, 'total_score': 0, 'max_score': 0}
    file_stats[file_path]['count'] += 1
    score = snippet.get('score', 0)
    file_stats[file_path]['total_score'] += score
    file_stats[file_path]['max_score'] = max(file_stats[file_path]['max_score'], score)

print(f'   文件总数: {len(file_stats)}')
for file_path, stats in sorted(file_stats.items(), key=lambda x: x[1]['count'], reverse=True)[:10]:
    avg_score = stats['total_score'] / stats['count'] if stats['count'] > 0 else 0
    print(f'   {file_path}:')
    print(f'       代码片段数: {stats[\"count\"]}, 平均分数: {avg_score:.3f}, 最高分数: {stats[\"max_score\"]:.3f}')
"

echo ""
echo "=== 测试完成 ==="
