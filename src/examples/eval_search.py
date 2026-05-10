#!/usr/bin/env python3
"""
eval_search.py - 语义搜索召回率评估工具

用预先标注的问题对（query → 期望代码片段）测试搜索系统的召回效果。

用法:
  ./eval_search.py                                              # 默认用 demo 工作区
  ./eval_search.py --search-cmd "node dist/cli.js"             # 自定义 CLI 命令
  ./eval_search.py --no-demo                                     # 不限定 demo 工作区
  ./eval_search.py --verbose                                     # 显示每个结果的详细信息

输出指标:
  - Recall@K:  Top-1 / Top-3 / Top-5 / Top-10 / Top-20 召回率
  - MRR:       平均倒数排名 (Mean Reciprocal Rank)
  - Avg Score: 目标结果的平均分数
"""

import json
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Optional


# ==============================
# 1. 测试用例定义
# ==============================

@dataclass
class TestCase:
    """单个测试用例"""
    query: str                              # 搜索查询
    description: str                        # 简短描述
    expect_file: str = "model.py"           # 期望的文件名
    expect_code_kw: str = ""                # 代码中应包含的关键词
    expect_hierarchy_kw: str = ""           # 层级中应包含的关键词
    expect_line_start: Optional[int] = None # 期望的行号（近似值，用于辅助验证）

@dataclass
class SearchResult:
    """搜索结果片段"""
    file: str = "N/A"
    line_range: str = "N/A"
    hierarchy: str = "N/A"
    code: str = ""
    score: float = 0.0

    @classmethod
    def from_json(cls, item: dict) -> "SearchResult":
        return cls(
            file=item.get("filePath", item.get("source_file", "N/A")),
            line_range=item.get("lineRange", "N/A"),
            hierarchy=item.get("hierarchy", "N/A"),
            code=item.get("code", ""),
            score=item.get("score", 0.0),
        )

@dataclass
class EvalResult:
    """单个测试用例的评估结果"""
    index: int
    query: str
    description: str
    total_results: int
    found: bool
    rank: Optional[int] = None        # 1-based rank (None = 未找到)
    target_score: Optional[float] = None
    top_scores: list = field(default_factory=list)


# ==============================
# 2. 测试用例列表
# ==============================

TEST_CASES = [
    TestCase(
        query="模型初始化时如何处理不同的模型来源",
        description="初始化时 HUB/Triton/本地文件判断分支",
        expect_code_kw="is_hub_model",
        expect_hierarchy_kw="__init__",
    ),
    TestCase(
        query="如何判断一个模型字符串指向远程推理服务",
        description="is_triton_model 静态方法",
        expect_code_kw="def is_triton_model",
        expect_hierarchy_kw="class Model",  # @staticmethod 的 hierarchy 不含 function 名
        expect_line_start=178,
    ),
    TestCase(
        query="进行模型推理时，流式输出和命令行输出走的不同路径",
        description="predict_cli vs predictor() 分支",
        expect_code_kw="predict_cli",
        expect_hierarchy_kw="predict",
        expect_line_start=318,
    ),
    TestCase(
        query="训练完成后更新模型权重",
        description="train 末尾用 best/last 权重更新模型",
        expect_code_kw="attempt_load_one_weight",
        expect_hierarchy_kw="train",
        expect_line_start=479,
    ),
    TestCase(
        query="模型导出成不同格式时支持哪些配置选项",
        description="export 文档中的 format/half/int8 等参数",
        expect_code_kw="export format",
        expect_hierarchy_kw="export",
        expect_line_start=390,
    ),
    TestCase(
        query="超参数调优的两种模式",
        description="tune 方法: use_ray vs Tuner 分支",
        expect_code_kw="run_ray_tune",
        expect_hierarchy_kw="tune",
        expect_line_start=503,
    ),
    TestCase(
        query="持久化模型文件时都保存了哪些额外信息",
        description="保存模型时的 license/version/docs 信息",
        expect_code_kw="AGPL-3.0 License",
        expect_hierarchy_kw="save",
        expect_line_start=218,
    ),
    TestCase(
        query="加载 checkpoint 时保留哪些参数",
        description="_reset_ckpt_args 保留 imgsz/data/task",
        expect_code_kw="def _reset_ckpt_args",
        expect_hierarchy_kw="class Model",  # @staticmethod 的 hierarchy 不含 function 名
        expect_line_start=1035,
    ),
    TestCase(
        query="如何为模型注册自定义事件处理函数",
        description="add_callback/clear_callback/reset_callbacks",
        expect_code_kw="add_callback",
        expect_hierarchy_kw="add_callback",
        expect_line_start=589,
    ),
    TestCase(
        query="提取特征向量时默认使用哪一层的输出",
        description="embed 默认取倒数第二层",
        expect_code_kw="len(self.model.model)",
        expect_hierarchy_kw="embed",
        expect_line_start=275,
    ),
    TestCase(
        query="目标跟踪和普通预测推理在实现上有哪些不同",
        description="track 注册跟踪器、低置信度阈值",
        expect_code_kw="register_tracker",
        expect_hierarchy_kw="track",
        expect_line_start=341,
    ),
    TestCase(
        query="不同类型任务对应的模块是怎么自动匹配的",
        description="通过 task_map 动态加载 model/trainer 等",
        expect_code_kw="task_map",
        expect_hierarchy_kw="_smart_load",
        expect_line_start=665,
    ),
]


# ==============================
# 3. 搜索执行器
# ==============================

class SearchRunner:
    """封装搜索 CLI 调用"""

    def __init__(self, search_cmd: str, use_demo: bool, verbose: bool):
        self.search_cmd = search_cmd
        self.use_demo = use_demo
        self.verbose = verbose

    def search(self, query: str, limit: int = 20) -> list[SearchResult]:
        """执行单次搜索，返回按分数降序排列的结果列表"""
        args = self.search_cmd.split() + [
            "search",
            query,
            "--json",
            "--limit", str(limit),
            "--log-level", "error",
        ]
        if self.use_demo:
            args += ["--demo"]

        if self.verbose:
            print(f"      运行: {' '.join(args)[:120]}...")

        try:
            result = subprocess.run(
                args,
                capture_output=True,
                text=True,
                timeout=60,
            )
            output = result.stdout
            if not output.strip():
                output = result.stderr

            # 提取 JSON（跳过日志前缀）
            json_start = output.find("{")
            if json_start == -1:
                print(f"      ⚠ 未找到 JSON 输出, stderr={result.stderr[:200]!r}")
                return []

            data = json.loads(output[json_start:])
        except (subprocess.TimeoutExpired, json.JSONDecodeError) as e:
            print(f"      ✖ 搜索失败: {e}")
            return []

        # 兼容新旧格式
        raw_items = data.get("snippets") or data.get("files") or []
        if data.get("files"):
            # 旧格式: files → snippets 嵌套
            items = []
            for f in data["files"]:
                fp = f.get("filePath", "N/A")
                for s in f.get("snippets", []):
                    s["filePath"] = fp
                    items.append(s)
        else:
            items = raw_items

        results = [SearchResult.from_json(item) for item in items]
        results.sort(key=lambda r: r.score, reverse=True)
        return results


# ==============================
# 4. 匹配判断
# ==============================

def is_target(result: SearchResult, case: TestCase) -> bool:
    """判断搜索结果是否匹配预期"""
    file_ok = case.expect_file in result.file
    code_ok = case.expect_code_kw.lower() in result.code.lower() if case.expect_code_kw else True
    hier_ok = case.expect_hierarchy_kw.lower() in result.hierarchy.lower() if case.expect_hierarchy_kw else True
    return file_ok and code_ok and hier_ok


# ==============================
# 5. 报告格式化
# ==============================

def print_summary_table(results: list[EvalResult]):
    """输出汇总表"""
    print()
    print("=" * 100)
    print("  单项结果明细")
    print("=" * 100)
    print(f"  {'#':>3}  {'查询描述':<30} {'命中':^6} {'排名':>6} {'分数':>8} {'Top-结果':<30}")
    print("  " + "-" * 96)

    for r in results:
        hit = "✓" if r.found else "✗"
        rank_str = f"#{r.rank}" if r.rank else "-"
        score_str = f"{r.target_score:.4f}" if r.target_score else "-"
        # 前 5 个结果的分数预览
        top_prev = ", ".join(f"{s:.3f}" for s in r.top_scores[:5])
        print(f"  {r.index:>3}  {r.description:<30} {hit:^6} {rank_str:>6} {score_str:>8}  [{top_prev}]")
    print()


def print_aggregate_metrics(results: list[EvalResult]):
    """输出聚合指标"""
    total = len(results)
    found = sum(1 for r in results if r.found)

    # Recall@K
    ranks = [r.rank for r in results if r.rank is not None]
    recall_at = {}
    for k in [1, 3, 5, 10, 20]:
        recall_at[k] = sum(1 for r in ranks if r <= k) / total * 100

    # MRR
    mrr = sum(1.0 / r.rank for r in results if r.rank is not None) / total if total else 0

    # 平均分数
    scores = [r.target_score for r in results if r.target_score is not None]
    avg_score = sum(scores) / len(scores) if scores else 0.0

    print("=" * 100)
    print("  聚合指标")
    print("=" * 100)
    print(f"  总用例数:          {total}")
    print(f"  命中数:            {found} / {total}  ({found/total*100:.1f}%)")
    print(f"  未命中数:          {total - found}")
    print()
    print(f"  Recall@1:          {recall_at[1]:5.1f}%  ({sum(1 for r in ranks if r <= 1)} 个)")
    print(f"  Recall@3:          {recall_at[3]:5.1f}%  ({sum(1 for r in ranks if r <= 3)} 个)")
    print(f"  Recall@5:          {recall_at[5]:5.1f}%  ({sum(1 for r in ranks if r <= 5)} 个)")
    print(f"  Recall@10:         {recall_at[10]:5.1f}%  ({sum(1 for r in ranks if r <= 10)} 个)")
    print(f"  Recall@20:         {recall_at[20]:5.1f}%  ({sum(1 for r in ranks if r <= 20)} 个)")
    print()
    print(f"  MRR (Mean Reciprocal Rank):  {mrr:.4f}")
    print(f"  目标平均分数:                {avg_score:.4f}")
    print(f"  命中结果中位数排名:          {sorted(ranks)[len(ranks)//2] if ranks else '-'}")
    print()


def print_missed_details(results: list[EvalResult]):
    """输出未命中用例的详细信息"""
    missed = [r for r in results if not r.found]
    if not missed:
        return

    print("=" * 100)
    print("  未命中用例详情")
    print("=" * 100)
    for r in missed:
        case = TEST_CASES[r.index - 1]
        print(f"  #{r.index} [{r.query}]")
        print(f"      期望: code_kw={case.expect_code_kw!r}, hierarchy={case.expect_hierarchy_kw!r}")
        if r.top_scores:
            print(f"      Top-3 最高分: {', '.join(f'{s:.4f}' for s in r.top_scores[:3])}")
        print()


# ==============================
# 6. 主流程
# ==============================

def parse_args():
    import argparse
    p = argparse.ArgumentParser(
        description="语义搜索召回率评估工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--search-cmd", default="npx tsx src/cli.ts",
                    help="搜索 CLI 命令 (默认: npx tsx src/cli.ts)")
    p.add_argument("--no-demo", action="store_true",
                    help="不使用 demo 工作区")
    p.add_argument("--verbose", "-v", action="store_true",
                    help="显示详细日志")
    p.add_argument("--limit", type=int, default=20,
                    help="每个查询返回的结果数 (默认: 20)")
    return p.parse_args()


def main():
    args = parse_args()
    runner = SearchRunner(
        search_cmd=args.search_cmd,
        use_demo=not args.no_demo,
        verbose=args.verbose,
    )

    total = len(TEST_CASES)
    eval_results: list[EvalResult] = []

    print()
    print("╔" + "═" * 78 + "╗")
    print("║  语义搜索召回率评估                                          ║")
    print("╚" + "═" * 78 + "╝")
    print()
    print(f"  搜索命令:   {args.search_cmd}")
    print(f"  工作区:     {'demo (autodev-codebase/demo)' if not args.no_demo else '当前目录'}")
    print(f"  测试用例数: {total}")
    print(f"  每查询结果: Top-{args.limit}")
    print()

    for i, case in enumerate(TEST_CASES, start=1):
        if args.verbose:
            print(f"  [{i}/{total}] {case.description}")
            print(f"      查询: {case.query}")
        else:
            print(f"  [{i}/{total}] {case.description} ... ", end="", flush=True)

        t0 = time.time()
        results = runner.search(case.query, limit=args.limit)
        elapsed = time.time() - t0

        # 查找目标
        target_rank = None
        target_score = None
        for rank, r in enumerate(results, start=1):
            if is_target(r, case):
                target_rank = rank
                target_score = r.score
                break

        eval_r = EvalResult(
            index=i,
            query=case.query,
            description=case.description,
            total_results=len(results),
            found=target_rank is not None,
            rank=target_rank,
            target_score=target_score,
            top_scores=[r.score for r in results[:10]],
        )
        eval_results.append(eval_r)

        # 输出运行结果
        if args.verbose:
            status = f"{'✓' if eval_r.found else '✗'} 排名={target_rank}, 分数={target_score:.4f}" if target_rank else "✗ 未命中"
            print(f"      {status} ({elapsed:.1f}s)")
            if eval_r.found:
                r = results[target_rank - 1]
                print(f"      文件: {r.file}, 行: {r.line_range}, 层级: {r.hierarchy}")
            print()
        else:
            if eval_r.found:
                print(f"✓  #{target_rank}  score={target_score:.4f}  ({elapsed:.1f}s)")
            else:
                print(f"✗  未命中  ({elapsed:.1f}s)")

        # 简要进度
        sys.stdout.flush()

    # 汇总输出
    print_summary_table(eval_results)
    print_aggregate_metrics(eval_results)
    print_missed_details(eval_results)

    # 退出码
    missed = sum(1 for r in eval_results if not r.found)
    sys.exit(1 if missed > 0 else 0)


if __name__ == "__main__":
    main()
