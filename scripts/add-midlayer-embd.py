#!/usr/bin/env python3
"""
Batch-apply mid-layer embedding support to llama.cpp model files.
This script adds embd_layer computation and mid-layer t_embd extraction
to all model architecture files.

Usage: python3 scripts/add-midlayer-embd.py
"""

import os
import re
import sys

MODELS_DIR = "src/models"

# Files already modified (e.g., the reference implementation)
ALREADY_MODIFIED = {"llama.cpp"}


def find_build_norm(context_lines, t_embd_line_idx):
    """
    Extract the multiline build_norm call pattern from the context before t_embd.
    Returns (norm_lines, norm_label) or (None, None) for BERT-like models.
    """
    norm_label = "result_norm"

    # Look at lines before t_embd to find build_norm and cb
    for i in range(max(0, t_embd_line_idx - 5), t_embd_line_idx):
        line = context_lines[i]
        if "result_embd" in line:
            norm_label = "result_embd"

    # Find the build_norm call - may span multiple lines
    norm_start = -1
    for i in range(max(0, t_embd_line_idx - 10), t_embd_line_idx):
        line = context_lines[i]
        if "build_norm" in line and ("cur" in line or "inpL" in line):
            norm_start = i
            break

    if norm_start < 0:
        return (None, norm_label)

    # Collect all lines of the build_norm call (until semicolon)
    norm_lines = []
    for i in range(norm_start, t_embd_line_idx):
        line = context_lines[i]
        norm_lines.append(line)
        if ";" in line:
            break

    return (norm_lines, norm_label)


def generate_embd_layer_computation():
    """Generate the embd_layer computation code block."""
    return [
        "",
        "    // determine the target layer for embedding extraction",
        "    // -1 (default) = last layer; 0..n_layer-1 = specified layer",
        "    const int embd_layer = cparams.embeddings",
        "        ? (cparams.embd_layer >= 0 ? cparams.embd_layer : n_layer - 1)",
        "        : n_layer - 1;",
    ]


def generate_midlayer_check(norm_lines, norm_label):
    """
    Generate the mid-layer check code block.
    If norm_lines is None, use raw cur (BERT-like).
    Otherwise, replicate the norm call with a temp variable.
    """
    if norm_lines is None:
        return [
            "        // mid-layer embedding extraction: capture hidden states at target layer",
            "        if (il == embd_layer) {",
            f'            cb(cur, "{norm_label}", -1);',
            "            res->t_embd = cur;",
            "        }",
        ]

    result = [
        "        // mid-layer embedding extraction: capture hidden states at target layer",
        "        if (il == embd_layer) {",
    ]

    # Process the norm lines: replace assignment with ggml_tensor declaration
    for idx, nl in enumerate(norm_lines):
        stripped = nl.strip()
        if idx == 0:
            # First line: replace "cur = build_norm" or "inpL = build_norm" with declaration
            # Also replace build_norm(inpL, with build_norm(cur, if needed
            modified = stripped
            if "inpL" in modified and "build_norm(inpL" in modified:
                modified = modified.replace("build_norm(inpL,", "build_norm(cur,", 1)
            if "= build_norm" in modified:
                modified = re.sub(r'^\S+\s*=\s*build_norm', 'build_norm', modified)
                modified = "            ggml_tensor * cur_embd = " + modified
            else:
                modified = "            " + modified
        else:
            modified = "            " + stripped
        result.append(modified)

    result.append(f'            cb(cur_embd, "{norm_label}", -1);')
    result.append("            res->t_embd = cur_embd;")
    result.append("        }")

    return result


def find_for_loop_end(lines, for_loop_start, t_embd_line_idx):
    """
    Find the line index just before 'inpL = cur' inside the for loop.
    This is where we insert the mid-layer check.
    """
    for i in range(for_loop_start + 1, t_embd_line_idx):
        stripped = lines[i].strip()
        if stripped.startswith("inpL = cur") or stripped.startswith("inpL = cur;"):
            return i
    return None


def find_cur_inpl(lines, t_embd_line_idx):
    """Find the line with 'cur = inpL' before t_embd."""
    for i in range(t_embd_line_idx - 20, t_embd_line_idx):
        stripped = lines[i].strip()
        if stripped.startswith("cur = inpL"):
            return i
    return None


def process_file(filepath):
    """Process a single model file."""
    if os.path.basename(filepath) in ALREADY_MODIFIED:
        print(f"  SKIP: {filepath} (already modified)")
        return True

    with open(filepath, "r") as f:
        content = f.read()

    lines = content.split("\n")

    # Find t_embd assignment
    t_embd_idx = None
    for i, line in enumerate(lines):
        if "res->t_embd = cur" in line:
            t_embd_idx = i
            break

    if t_embd_idx is None:
        print(f"  WARN: {filepath} - no res->t_embd found")
        return False

    # Find the for loop start
    for_loop_start = None
    for i in range(t_embd_idx):
        stripped = lines[i].strip()
        if "for (int il = 0; il < n_layer;" in stripped or \
           "for (int il = 0; il < n_layer ;" in stripped or \
           "for (int il = 0; il < n_layer; ++il)" in stripped:
            for_loop_start = i
            # Don't break - we want the LAST (outermost) for loop

    if for_loop_start is None:
        print(f"  WARN: {filepath} - no for loop found")
        return False

    # Find where to insert mid-layer check (before inpL = cur)
    inpL_idx = find_for_loop_end(lines, for_loop_start, t_embd_idx)

    if inpL_idx is None:
        print(f"  WARN: {filepath} - no inpL = cur found inside loop")
        return False

    # Extract norm pattern from lines before t_embd
    # Get the context: lines from for_loop_end to t_embd
    context_start = inpL_idx + 1
    context_lines = lines[context_start:t_embd_idx + 1]
    context_indices = list(range(context_start, t_embd_idx + 1))

    norm_lines, norm_label = find_build_norm(context_lines, len(context_lines) - 1)

    # Generate the new code blocks
    embd_layer_block = generate_embd_layer_computation()
    midlayer_block = generate_midlayer_check(norm_lines, norm_label)

    # Build the new content
    new_lines = []

    for i, line in enumerate(lines):
        # Insert embd_layer computation BEFORE the for loop
        if i == for_loop_start:
            for el in embd_layer_block:
                new_lines.append(el)

        # Insert mid-layer check BEFORE inpL = cur
        if i == inpL_idx:
            for ml in midlayer_block:
                new_lines.append(ml)

        # Wrap res->t_embd in conditional
        if i == t_embd_idx:
            # Check if this line is already inside a conditional (skip if already modified)
            indent = line[: len(line) - len(line.lstrip())]
            new_lines.append(f"{indent}if (embd_layer == n_layer - 1) {{")
            new_lines.append(line)
            new_lines.append(f"{indent}}}")
        else:
            new_lines.append(line)

    new_content = "\n".join(new_lines)

    with open(filepath, "w") as f:
        f.write(new_content)

    print(f"  OK: {filepath}")
    return True


def main():
    # Accept --llamacpp-dir for external callers (e.g., build.mjs)
    if "--llamacpp-dir" in sys.argv:
        idx = sys.argv.index("--llamacpp-dir")
        if idx + 1 < len(sys.argv):
            base_dir = sys.argv[idx + 1]
            models_dir = os.path.join(base_dir, MODELS_DIR)
        else:
            print("Error: --llamacpp-dir requires a path argument")
            sys.exit(1)
    else:
        # Default: relative to script location (for llama.cpp repo root)
        models_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", MODELS_DIR)
    models_dir = os.path.normpath(models_dir)

    if not os.path.isdir(models_dir):
        print(f"Error: {models_dir} not found")
        sys.exit(1)

    cpp_files = sorted([f for f in os.listdir(models_dir) if f.endswith(".cpp")])

    success = 0
    failed = 0
    skipped = 0

    for f in cpp_files:
        filepath = os.path.join(models_dir, f)

        # Only process files that have t_embd
        with open(filepath, "r") as fh:
            if "res->t_embd" not in fh.read():
                continue

        if process_file(filepath):
            if os.path.basename(filepath) in ALREADY_MODIFIED:
                skipped += 1
            else:
                success += 1
        else:
            failed += 1

    print(f"\nSummary: {success} modified, {skipped} skipped, {failed} failed")


if __name__ == "__main__":
    main()
