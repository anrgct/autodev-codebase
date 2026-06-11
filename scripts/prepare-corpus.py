#!/usr/bin/env python3
"""将 HotpotQA 语料转换为 .md 文件，供 autodev-codebase 索引。

用法:
    python scripts/prepare-corpus.py \
        --corpus /path/to/hotpotqa_corpus.json \
        --out /tmp/hotpotqa-corpus

输入格式 (HippoRAG reproduce/dataset/hotpotqa_corpus.json):
    [
        {"title": "Title1", "text": "Document text...", "idx": 0},
        {"title": "Title2", "text": "More text...", "idx": 1}
    ]

输出:
    /tmp/hotpotqa-corpus/*.md  - 每篇文档一个 .md 文件
    /tmp/hotpotqa-corpus/.metadata.json  - title→filename 映射
"""

import argparse
import json
import os
import re
import sys


def sanitize_filename(title: str) -> str:
    """将文档标题转成安全的文件名。"""
    safe = title.strip()
    safe = re.sub(r'[\\/:*?"<>|]', '_', safe)  # 替换非法字符
    safe = re.sub(r'\s+', ' ', safe)           # 合并空白
    safe = safe.strip()
    if not safe:
        safe = "untitled"
    # 避免文件名过长
    max_name_len = 200
    if len(safe) > max_name_len:
        safe = safe[:max_name_len]
    return safe


def main():
    parser = argparse.ArgumentParser(description="Prepare HotpotQA corpus for autodev-codebase")
    parser.add_argument("--corpus", required=True, help="Path to corpus JSON file")
    parser.add_argument("--out", required=True, help="Output directory for .md files")
    args = parser.parse_args()

    # 加载语料
    with open(args.corpus, "r", encoding="utf-8") as f:
        corpus = json.load(f)

    os.makedirs(args.out, exist_ok=True)

    metadata = {}  # title → filename
    for doc in corpus:
        title = doc["title"]
        text = doc["text"]
        _idx = doc.get("idx")  # optional, unused but kept for compatibility

        safe_name = sanitize_filename(title)
        filename = f"{safe_name}.md"

        # 处理文件名冲突（不同 title 可能 sanitize 后相同）
        counter = 1
        while filename in metadata.values():
            filename = f"{safe_name}_{counter}.md"
            counter += 1

        # 写入 .md 文件
        # ⚠️ 重要：不加 Markdown 标题 (# Title)，这样 parseMarkdown 没找到 header
        # 会将整个文件作为单一 section 处理（CodeParser.parseMarkdownContent L955-957）
        filepath = os.path.join(args.out, filename)
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(text)

        metadata[title] = filename

    # 保存 metadata 映射
    meta_path = os.path.join(args.out, ".metadata.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)

    print(f"✓ 已生成 {len(corpus)} 个 .md 文件到: {args.out}")
    print(f"  metadata: {meta_path}")


if __name__ == "__main__":
    main()
