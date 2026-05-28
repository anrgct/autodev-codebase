#!/usr/bin/env python3
"""
修改 GGUF 模型的 pooling_type，生成 NONE 和 LAST 两个版本。

用法:
    python3 scripts/evidence/260528-modify-gguf-pooling.py /path/to/model.gguf

输出（与输入文件同目录）:
    model-pooling-NONE.gguf   (pooling_type=0)
    model-pooling-LAST.gguf   (pooling_type=3)

依赖: pip install gguf numpy

参考:
    - scripts/evidence/260525-evidence-embedding-failure.ts
    - scripts/evidence/260525-evidence-jina-v5-none-vs-last.ts
    - scripts/evidence/260525-evidence-reproduce-bug.sh
"""

import os
import sys
import shutil

import gguf


# ── PoolingType 常量 ──
# gguf.PoolingType:
#   NONE = 0   逐 token hidden states
#   MEAN = 1   均值池化
#   CLS  = 2   CLS token
#   LAST = 3   最后 token
#   RANK = 4   Ranking head
POOLING_VALUES = {
    "NONE": 0,
    "LAST": 3,
}


def find_pooling_field(reader: gguf.GGUFReader) -> str | None:
    """扫描所有字段，返回第一个包含 pooling_type 的字段名，或 None。"""
    for name in reader.fields:
        if name.endswith("pooling_type"):
            return name
    return None


def modify_pooling(src_path: str, dst_path: str, value: int) -> None:
    """
    复制 src 到 dst，然后设置 pooling_type 为 value。

    通过 mmap 操作，不重写整个 GGUF 文件。
    """
    # 1. 复制文件
    shutil.copy2(src_path, dst_path)
    print(f"  └─ 复制到: {os.path.basename(dst_path)}")

    # 2. 打开副本（r+ 读写模式），通过 memmap 直接修改 pooling_type 值
    reader = gguf.GGUFReader(dst_path, mode='r+')
    field_name = find_pooling_field(reader)
    if field_name is None:
        os.remove(dst_path)
        raise ValueError(f"无法在 {dst_path} 中找到 pooling_type 字段")

    field = reader.fields[field_name]
    old_val = int(field.parts[3][0])
    field.parts[3][0] = value
    # memmap 直接写入文件，显式 flush 确保落盘
    field.parts[3].flush()

    label = [k for k, v in POOLING_VALUES.items() if v == value][0]
    print(f"     pooling_type: {field_name} = {old_val} → {value} ({label})")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    src_path = os.path.abspath(sys.argv[1])

    if not os.path.isfile(src_path):
        print(f"错误: 文件不存在: {src_path}")
        sys.exit(1)

    # 检查 gguf 库可用
    try:
        import gguf
    except ImportError:
        print("错误: 需要 gguf Python 库")
        print("  pip install gguf")
        sys.exit(1)

    # ── 读取原始文件，确认 pooling_type ──
    print(f"\n🔍 原始文件: {src_path}")
    reader = gguf.GGUFReader(src_path, mode='r')
    field_name = find_pooling_field(reader)
    if field_name is None:
        print("  没有找到 pooling_type 字段。支持的模型字段格式：")
        print("    - eurobert.pooling_type (jina-v5)")
        print("    - bert.pooling_type")
        print("    - 或其他以 pooling_type 结尾的字段")
        print("\n可用的所有字段（前 30 个）:")
        for i, name in enumerate(reader.fields):
            if i >= 30:
                print(f"    ... 还有 {len(reader.fields) - 30} 个字段")
                break
            print(f"    - {name}")
        sys.exit(1)

    field = reader.fields[field_name]
    original_val = int(field.parts[3][0])
    print(f"  pooling_type: {field_name} = {original_val}")
    try:
        pt_name = gguf.PoolingType(original_val).name
    except ValueError:
        pt_name = "未知"
    print(f"  含义: {pt_name}")
    print()

    # ── 基础路径 ──
    base, ext = os.path.splitext(src_path)
    # 如果已有 -pooling-XXX 后缀，去掉它
    for suffix in ["-pooling-NONE", "-pooling-LAST", "-pooling-MEAN", "-pooling-CLS", "-pooling-RANK"]:
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break

    # ── 始终生成两个版本 ──
    print("📦 生成 pooling 变体:\n")
    for label, val in POOLING_VALUES.items():
        dst_path = f"{base}-pooling-{label}{ext}"
        if os.path.exists(dst_path):
            print(f"  ⚠️  已存在: {os.path.basename(dst_path)} (跳过)")
            continue

        if val == original_val:
            # 原始就是这个模式，直接复制一份即可
            shutil.copy2(src_path, dst_path)
            print(f"  └─ 直接复制: {os.path.basename(dst_path)}")
        else:
            modify_pooling(src_path, dst_path, val)

    print()
    print("✅ 完成！")
    print(f"   原始: {os.path.basename(src_path)}")
    print(f"   NONE: {os.path.basename(base)}-pooling-NONE{ext}")
    print(f"   LAST: {os.path.basename(base)}-pooling-LAST{ext}")


if __name__ == "__main__":
    main()
