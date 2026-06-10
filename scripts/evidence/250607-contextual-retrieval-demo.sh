#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Contextual Retrieval via codebase highlight
#
# 从文件中摘取代码块，构造 query = instruction + 代码块，
# 传给 highlight 的底层 LLM，输出的高分行就是 Contextual Retrieval 的 context。
#
# 用法:
#   ./scripts/test.sh --file=src/code-index/embedders/llamacpp-llm.ts \
#                     --start=75 --end=121 --topk=10
#
# 参数:
#   --file=<path>      代码块所在文件（必填，相对于项目根）
#   --start=<num>      起始行号 1-based（必填）
#   --end=<num>        结束行号 1-based 包含（必填）
#   --target=<path>    highlight 搜索的文件（默认同 --file）
#   --instruction=<str> 上下文指令（默认 Anthropic 风格，无 <document>）
#   --topk=<num>       保留行数（默认 20）
# ═══════════════════════════════════════════════════════════════════════════

# ─── 解析参数 ──
FILE=""; START=""; END=""; TARGET=""
INSTRUCTION="Please give a short succinct context to situate this code chunk within its file for the purposes of improving search retrieval. Answer only with the succinct context and nothing else."
TOPK=20

for arg in "$@"; do
  case "$arg" in
    --file=*)        FILE="${arg#--file=}" ;;
    --start=*)       START="${arg#--start=}" ;;
    --end=*)         END="${arg#--end=}" ;;
    --target=*)      TARGET="${arg#--target=}" ;;
    --instruction=*) INSTRUCTION="${arg#--instruction=}" ;;
    --topk=*)        TOPK="${arg#--topk=}" ;;
    --help) sed -n '/^# ═/,/^# ═/p' "$0" | head -n -1; exit 0 ;;
  esac
done

if [ -z "$FILE" ] || [ -z "$START" ] || [ -z "$END" ]; then
  sed -n '/^# 用法:/,/^# ═/p' "$0" | grep "^#" | cut -c3-
  exit 1
fi
[ -z "$TARGET" ] && TARGET="$FILE"

# ─── 摘取代码块 ──
ROOT_DIR="$(pwd)"
RESOLVED="$ROOT_DIR/$FILE"
[ ! -f "$RESOLVED" ] && { echo >&2 "❌ $RESOLVED not found"; exit 1; }

CHUNK=$(sed -n "${START},${END}p" "$RESOLVED")

# ─── 构造 query = <chunk> + 代码块 + </chunk> + instruction ──
QUERY="<chunk>
${CHUNK}
</chunk>
${INSTRUCTION}"

# ─── 运行 highlight ──
echo >&2 "🧠 Contextual Retrieval"
echo >&2 "   chunk: $FILE:$START-$END → target: $TARGET  topk=$TOPK"
echo >&2 ""

OUT=$(mktemp /tmp/ctx-out-XXXXXX.json)
trap 'rm -f "$OUT"' EXIT

npx tsx src/cli.ts highlight "$QUERY" "$TARGET" \
  --topk="$TOPK" --json 2>/dev/null | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
kept = data.get('files', [{}])[0].get('lines', [])
sys.stdout.write(json.dumps([l for l in kept if l.get('kept')]))
" > "$OUT"

# ─── 输出 context ──
echo >&2 "✅ done ($(python3 -c "import json; print(len(json.load(open('$OUT'))))") lines)"

python3 -c "
import json
for l in json.load(open('$OUT')):
    print(f'  [{l[\"score\"]:.4f}] L{l[\"lineNumber\"]}  {l[\"text\"]}')
"
