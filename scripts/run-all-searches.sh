#!/usr/bin/env bash
# 刁钻搜索测试 — 一键跑完所有问题
# usage: bash scripts/run-all-searches.sh

set -e

QUESTIONS=(
    # 1. 概念转译型
    "怎么把代码切碎了喂给AI？"
    "代码之间的亲戚关系怎么查？"

    # 2. 跨模块关联型
    "给代码写摘要的时候，用什么AI模型？背后的请求怎么发出去的？"
    "从敲下搜索回车到看到结果，向量是怎么存进去又查出来的？"

    # 3. 同义词/近义陷阱型
    "怎么让工具只翻TypeScript的牌子？"
    "能不能让搜索只看src目录，别管node_modules？"

    # 4. 不存在之物型
    "支持用Redis做向量数据库吗？"

    # 5. 配置刁钻型
    "项目配置和全局配置打架了，听谁的？"
    "换个搜索引擎后端要改几个地方？"

    # 6. 抽象概念具体化型
    "这个工具连接了多少个AI服务提供商？"
    "Ollama既能做嵌入又能做重排序，代码里这两条路是怎么分开走的？"

    # 7. 终极大魔王
    "我想让搜索只看 src/commands/ 下的函数调用关系，排除测试文件，用 Gemini 做嵌入，用 Ollama 做重排序，还要输出中文摘要——这配置怎么写？"

    # 8. 代码路径选择型
    "llamacpp reranker 两种模式怎么选的？"

    # 9. 精确符号定位型（语义搜索容易跑偏，BM25 精确匹配）
    '字面量"Clear index mode"'
    '字面量"v1.0.0"'
)

TOTAL=${#QUESTIONS[@]}
PASS=0
FAIL=0
SEARCH_ERROR=0

echo "=========================================="
echo "  🔥 语义搜索刁钻测试 — 共 $TOTAL 题"
echo "=========================================="
echo

for i in "${!QUESTIONS[@]}"; do
    q="${QUESTIONS[$i]}"
    num=$((i + 1))

    echo "─────────── 【第 $num 题】 ───────────"
    echo "❓ $q"
    echo

    # 分离：先捕获原始输出和退出码，再过滤展示
    set +e
    RAW_OUTPUT=$(npx tsx src/cli.ts search -f '!*.md' "$q" 2>&1)
    SEARCH_EXIT=$?
    set -e

    if [ $SEARCH_EXIT -ne 0 ]; then
        echo "   ❌ 命令执行失败 (exit code: $SEARCH_EXIT)"
        echo "   --- 原始输出 ---"
        echo "$RAW_OUTPUT"
        echo "   ---"
        FAIL=$((FAIL + 1))
        SEARCH_ERROR=$((SEARCH_ERROR + 1))
        echo
        continue
    fi

    OUTPUT=$(echo "$RAW_OUTPUT" | grep -E 'results in|^< |File: ' || true)

    if [ -z "$OUTPUT" ]; then
        echo "   ⚠️  无结果"
        FAIL=$((FAIL + 1))
    else
        echo "$OUTPUT"
        echo
        echo "   ✅ 有结果"
        PASS=$((PASS + 1))
    fi

    echo
done

echo "=========================================="
echo "  🏁 测试完成"
echo "  通过: $PASS / $TOTAL"
echo "  失败: $FAIL / $TOTAL"
if [ $SEARCH_ERROR -gt 0 ]; then
    echo "  ⚠️  其中 $SEARCH_ERROR 题因命令错误失败"
fi
echo "=========================================="
