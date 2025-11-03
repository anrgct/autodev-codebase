```
rg -A 5 "^# |📊 总体表现:" docs/250702-embed-model-compare.md
awk '
/^# / {
    print $0
    # 跳过接下来的行直到找到总体表现
    while ((getline) > 0) {
        if (/📊 总体表现:/) {
            print $0
            # 打印总体表现后的4行
            for (i = 1; i <= 4; i++) {
                if ((getline) > 0) print $0
            }
            print ""
            break
        }
    }
}
rg -A 5 "^# |📊 总体表现:" docs/250702-embed-model-compare.md | awk '/^# / {print; for(i=1;i<=5;i++) {getline; if(/📊 总体表现:/) {skip=0; print; break} else skip++} next} /^--$/ {next} {print}'
```

| Model | Avg Precision@3 | Avg Precision@5 | Good Queries (≥66.7%) | Failed Queries (0%) |
|-------|-----------------|-----------------|-----------------------|---------------------|
| siliconflow/Qwen/Qwen3-Embedding-8B | **76.7%** | 66.0% | 5/10 | 0/10 |
| siliconflow/Qwen/Qwen3-Embedding-4B | **73.3%** | 54.0% | 5/10 | 1/10 |
| voyage/voyage-code-3 | **73.3%** | 52.0% | 6/10 | 1/10 |
| jina/jina-code-embeddings-1.5b | **66.7%** | 52.0% | 4/10 | 0/10 |
| jina/jina-code-embeddings-0.5b | **63.3%** | 50.0% | 2/10 | 0/10 |
| siliconflow/Qwen/Qwen3-Embedding-0.6B | **63.3%** | 42.0% | 4/10 | 1/10 |
| morph-embedding-v2 | **56.7%** | 44.0% | 3/10 | 1/10 |
| openai/text-embedding-ada-002 | **53.3%** | 38.0% | 2/10 | 1/10 |
| voyage/voyage-3-large | **53.3%** | 42.0% | 3/10 | 2/10 |
| openai/text-embedding-3-large | **46.7%** | 38.0% | 1/10 | 3/10 |
| voyage/voyage-3.5 | **43.3%** | 38.0% | 1/10 | 2/10 |
| jina-embeddings-v4 | **36.7%** | 36.0% | 0/10 | 4/10 |
| voyage/voyage-3.5-lite | **36.7%** | 28.0% | 1/10 | 2/10 |
| openai/text-embedding-3-small | **33.3%** | 28.0% | 1/10 | 4/10 |
| siliconflow/BAAI/bge-large-en-v1.5 | **30.0%** | 28.0% | 0/10 | 3/10 |
| siliconflow/Pro/BAAI/bge-m3 | **26.7%** | 24.0% | 0/10 | 2/10 |
| ollama/nomic-embed-text | **16.7%** | 18.0% | 0/10 | 6/10 |
| siliconflow/netease-youdao/bce-embedding-base_v1 | **13.3%** | 16.0% | 0/10 | 6/10 |

ollama专场

| Model                                                    | Precision@3 | Precision@5 | Good Queries (≥66.7%) | Failed Queries (0%) |
| -------------------------------------------------------- | ----------- | ----------- | --------------------- | ------------------- |
| ollama/dengcao/Qwen3-Embedding-4B:Q4_K_M                 | 66.7%       | 48.0%       | 4/10                  | 1/10                |
| ollama/dengcao/Qwen3-Embedding-0.6B:f16                  | 63.3%       | 44.0%       | 3/10                  | 0/10                |
| ollama/dengcao/Qwen3-Embedding-0.6B:Q8_0                 | 63.3%       | 44.0%       | 3/10                  | 0/10                |
| ollama/dengcao/Qwen3-Embedding-4B:Q8_0                   | 60.0%       | 48.0%       | 3/10                  | 1/10                |
| lmstudio/taylor-jones/bge-code-v1-Q8_0-GGUF              | 60.0%       | 54.0%       | 4/10                  | 1/10                |
| ollama/dengcao/Qwen3-Embedding-8B:Q4_K_M                 | 56.7%       | 42.0%       | 2/10                  | 2/10                |
| ollama/hf.co/nomic-ai/nomic-embed-code-GGUF:Q4_K_M       | 53.3%       | 44.0%       | 2/10                  | 0/10                |
| ollama/embeddinggemma:bf16                               | 26.7%       | 26.0%       | 0/10                  | 3/10                |
| ollama/bge-m3:f16                                        | 26.7%       | 24.0%       | 0/10                  | 2/10                |
| ollama/hf.co/nomic-ai/nomic-embed-text-v2-moe-GGUF:f16   | 26.7%       | 20.0%       | 0/10                  | 2/10                |
| ollama/granite-embedding:278m-fp16                       | 23.3%       | 18.0%       | 0/10                  | 4/10                |
| ollama/unclemusclez/jina-embeddings-v2-base-code:f16     | 23.3%       | 16.0%       | 0/10                  | 5/10                |
| lmstudio/awhiteside/CodeRankEmbed-Q8_0-GGUF              | 23.3%       | 16.0%       | 0/10                  | 5/10                |
| lmstudio/wsxiaoys/jina-embeddings-v2-base-code-Q8_0-GGUF | 23.3%       | 16.0%       | 0/10                  | 5/10                |
| ollama/dengcao/Dmeta-embedding-zh:F16                    | 20.0%       | 20.0%       | 0/10                  | 6/10                |
| ollama/znbang/bge:small-en-v1.5-q8_0                     | 16.7%       | 16.0%       | 0/10                  | 6/10                |
| lmstudio/nomic-ai/nomic-embed-text-v1.5-GGUF@Q4_K_M      | 16.7%       | 14.0%       | 0/10                  | 6/10                |
| ollama/nomic-embed-text:f16                              | 16.7%       | 18.0%       | 0/10                  | 6/10                |
| ollama/snowflake-arctic-embed2:568m:f16                  | 16.7%       | 18.0%       | 0/10                  | 5/10                |



"package manager"单项对比
| **模型名称**                                         | **答对个数** | **具体匹配项**  |
| ---------------------------------------------------- | ------------ | --------------- |
| ollama/nomic-embed-text                              | 0            | -               |
| siliconflow/Qwen/Qwen3-Embedding-4B                  | 1            | pnpm            |
| siliconflow/Qwen/Qwen3-Embedding-8B                  | 3            | pnpm, yarn, bun |
| siliconflow/Qwen/Qwen3-Embedding-0.6B                | 2            | pnpm, yarn      |
| siliconflow/Pro/BAAI/bge-m3                          | 1            | pnpm            |
| siliconflow/BAAI/bge-large-en-v1.5                   | 2            | pnpm, bun       |
| siliconflow/netease-youdao/bce-embedding-base_v1     | 0            | -               |
| morph-embedding-v2                                   | 1            | pnpm            |
| openai/text-embedding-ada-002                        | 2            | pnpm, yarn      |
| openai/text-embedding-3-small                        | 2            | pnpm, yarn      |
| openai/text-embedding-3-large                        | 0            | -               |
| voyage/voyage-3-large                                | 3            | pnpm, bun, yarn |
| voyage/voyage-code-3                                 | 3            | pnpm, yarn, bun |
| ollama/dengcao/Qwen3-Embedding-4B:Q4_K_M             | 2            | pnpm, yarn      |
| ollama/znbang/bge:small-en-v1.5-q8_0                 | 2            | yarn, pnpm      |
| ollama/dengcao/Qwen3-Embedding-0.6B:f16              | 2            | pnpm, yarn      |
| ollama/dengcao/Qwen3-Embedding-0.6B:Q8_0             | 2            | pnpm, yarn      |
| ollama/nomic-embed-text:f16                          | 0            | -               |
| ollama/embeddinggemma:bf16                           | 0            | -               |
| ollama/bge-m3:f16                                    | 1            | pnpm            |
| ollama/dengcao/Dmeta-embedding-zh:F16                | 2            | pnpm, yarn      |
| ollama/granite-embedding:278m-fp16                   | 0            | -               |
| ollama/snowflake-arctic-embed2:568m:f16              | 0            | -               |
| ollama/unclemusclez/jina-embeddings-v2-base-code:f16 | 0            | -               |
| ollama/dengcao/Qwen3-Embedding-8B:Q4_K_M             | 2            | pnpm, yarn      |
| ollama/dengcao/Qwen3-Embedding-4B:Q8_0               | 2            | pnpm, yarn      |
| lmstudio/taylor-jones/bge-code-v1-Q8_0-GGUF              | 2            | pnpm, bun      |
| lmstudio/nomic-ai/nomic-embed-text-v1.5-GGUF@Q4_K_M      | 0            | -              |
| lmstudio/wsxiaoys/jina-embeddings-v2-base-code-Q8_0-GGUF | 0            | -              |
| lmstudio/awhiteside/CodeRankEmbed-Q8_0-GGUF              | 0            | -              |
| ollama/hf.co/nomic-ai/nomic-embed-text-v2-moe-GGUF:f16   | 2            | pnpm, bun      |
| ollama/hf.co/nomic-ai/nomic-embed-code-GGUF:Q4_K_M       | 1            | pnpm           |

"bundler"单项对比
| **模型名称**                                         | **答对个数** | **正确匹配项**     |
| ---------------------------------------------------- | ------------ | ------------------ |
| ollama/nomic-embed-text                              | 2            | parcel, swc        |
| siliconflow/Qwen/Qwen3-Embedding-4B                  | 2            | turbo, parcel      |
| siliconflow/Qwen/Qwen3-Embedding-8B                  | 2            | turbo, parcel      |
| siliconflow/Qwen/Qwen3-Embedding-0.6B                | 2            | turbo, parcel      |
| siliconflow/Pro/BAAI/bge-m3                          | 1            | turbo              |
| siliconflow/BAAI/bge-large-en-v1.5                   | 2            | turbo, parcel      |
| siliconflow/netease-youdao/bce-embedding-base_v1     | 1            | swc                |
| morph-embedding-v2                                   | 1            | parcel             |
| openai/text-embedding-ada-002                        | 1            | parcel             |
| openai/text-embedding-3-small                        | 2            | parcel, turbo      |
| openai/text-embedding-3-large                        | 3            | parcel, swc, turbo |
| voyage/voyage-3-large                                | 1            | parcel             |
| voyage/voyage-code-3                                 | 2            | turbo, parcel      |
| ollama/dengcao/Qwen3-Embedding-4B:Q4_K_M             | 0            | -                  |
| ollama/znbang/bge:small-en-v1.5-q8_0                 | 1            | turbo              |
| ollama/dengcao/Qwen3-Embedding-0.6B:f16              | 1            | parcel             |
| ollama/dengcao/Qwen3-Embedding-0.6B:Q8_0             | 1            | parcel             |
| ollama/nomic-embed-text:f16                          | 2            | parcel, swc        |
| ollama/embeddinggemma:bf16                          | 2            | parcel, turbo      |
| ollama/bge-m3:f16                                    | 1            | turbo              |
| ollama/dengcao/Dmeta-embedding-zh:F16                | 0            | -                  |
| ollama/granite-embedding:278m-fp16                   | 0            | -                  |
| ollama/snowflake-arctic-embed2:568m:f16              | 1            | swc                |
| ollama/unclemusclez/jina-embeddings-v2-base-code:f16 | 0            | -                  |
| ollama/dengcao/Qwen3-Embedding-8B:Q4_K_M             | 0            | -                  |
| ollama/dengcao/Qwen3-Embedding-4B:Q8_0               | 0            | -                  |
| lmstudio/taylor-jones/bge-code-v1-Q8_0-GGUF              | 1        | parcel        |
| lmstudio/nomic-ai/nomic-embed-text-v1.5-GGUF@Q4_K_M      | 1        | parcel        |
| lmstudio/wsxiaoys/jina-embeddings-v2-base-code-Q8_0-GGUF | 0        | -             |
| lmstudio/awhiteside/CodeRankEmbed-Q8_0-GGUF              | 0        | -             |
| ollama/hf.co/nomic-ai/nomic-embed-text-v2-moe-GGUF:f16   | 1        | parcel        |
| ollama/hf.co/nomic-ai/nomic-embed-code-GGUF:Q4_K_M       | 2        | parcel, turbo |

# ollama/nomic-embed-text

╭─   ~/workspace/autodev-codebase on   master ?3                                                     base
╰─❯ npx tsx src/examples/embedding-test-simple.ts
🚀 开始embedding测试...

📦 添加模拟包数据...
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📊 搜索结果:
  1. qwik (56.2%) ❌
  2. standard (55.1%) ❌
  3. solid (55.0%) ❌
  4. turbo (54.1%) ✅
  5. jotai (54.1%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📊 搜索结果:
  1. react (54.4%) ❌
  2. standard (52.1%) ❌
  3. qwik (51.0%) ❌
  4. zustand (51.0%) ❌
  5. solid (49.9%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📊 搜索结果:
  1. qwik (55.7%) ❌
  2. standard (55.6%) ✅
  3. solid (52.2%) ❌
  4. react (49.1%) ❌
  5. jotai (48.7%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📊 搜索结果:
  1. qwik (57.9%) ✅
  2. vue (57.9%) ✅
  3. zustand (56.7%) ❌
  4. jotai (54.4%) ❌
  5. solid (54.2%) ✅
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📊 搜索结果:
  1. standard (58.4%) ❌
  2. ava (57.4%) ❌
  3. kysely (57.0%) ❌
  4. tap (55.6%) ❌
  5. biome (55.6%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📊 搜索结果:
  1. parcel (64.9%) ❌
  2. standard (62.6%) ❌
  3. react (62.4%) ❌
  4. kysely (61.1%) ❌
  5. vue (60.8%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📊 搜索结果:
  1. jotai (57.0%) ❌
  2. react (55.6%) ❌
  3. standard (54.2%) ❌
  4. qwik (53.3%) ❌
  5. recoil (52.6%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📊 搜索结果:
  1. solid (58.3%) ❌
  2. standard (58.2%) ❌
  3. biome (56.9%) ❌
  4. jasmine (56.7%) ❌
  5. ava (56.4%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📊 搜索结果:
  1. kysely (56.1%) ❌
  2. parcel (56.0%) ✅
  3. standard (56.0%) ❌
  4. swc (55.7%) ✅
  5. qwik (55.7%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📊 搜索结果:
  1. zustand (57.3%) ❌
  2. standard (55.1%) ❌
  3. vue (55.0%) ✅
  4. solid (54.7%) ✅
  5. react (54.4%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 16.7%
  平均 Precision@5: 18.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 6/10 (0%)

📋 详细结果:
  🔴 build tool           P@3:   0.0% | 首位: qwik (56.2%) 首个命中: turbo
  🔴 test framework       P@3:   0.0% | 首位: react (54.4%) 无命中
  🟡 code quality         P@3:  33.3% | 首位: qwik (55.7%) 首个命中: standard
  🟡 ui framework         P@3:  66.7% | 首位: qwik (57.9%) 首个命中: qwik
  🔴 state management     P@3:   0.0% | 首位: standard (58.4%) 无命中
  🔴 package manager      P@3:   0.0% | 首位: parcel (64.9%) 无命中
  🔴 javascript runtime   P@3:   0.0% | 首位: jotai (57.0%) 无命中
  🔴 database orm         P@3:   0.0% | 首位: solid (58.3%) 无命中
  🟡 bundler              P@3:  33.3% | 首位: kysely (56.1%) 首个命中: parcel
  🟡 frontend framework   P@3:  33.3% | 首位: zustand (57.3%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "ui framework" (66.7%)
  最差查询: "build tool" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# siliconflow/Qwen/Qwen3-Embedding-4B

╭─   ~/workspace/autodev-codebase on   master ?3                                                     base
╰─❯ npx tsx src/examples/embedding-test-simple.ts
🚀 开始embedding测试...

📦 添加模拟包数据...
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📊 搜索结果:
  1. bun (47.8%) ❌
  2. rome (47.1%) ✅
  3. turbo (47.0%) ✅
  4. biome (46.6%) ❌
  5. parcel (45.8%) ✅
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📊 搜索结果:
  1. jasmine (47.9%) ✅
  2. mocha (46.2%) ✅
  3. ava (44.3%) ✅
  4. tap (40.6%) ✅
  5. rome (39.1%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📊 搜索结果:
  1. standard (50.4%) ✅
  2. biome (49.7%) ✅
  3. qwik (49.1%) ❌
  4. rome (47.5%) ❌
  5. swc (45.2%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📊 搜索结果:
  1. vue (42.7%) ✅
  2. qwik (42.1%) ✅
  3. svelte (40.1%) ✅
  4. solid (39.8%) ✅
  5. turbo (39.3%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📊 搜索结果:
  1. recoil (54.6%) ✅
  2. zustand (52.2%) ✅
  3. redux (49.3%) ✅
  4. jotai (49.0%) ✅
  5. qwik (44.9%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📊 搜索结果:
  1. pnpm (51.1%) ✅
  2. parcel (47.6%) ❌
  3. rome (47.0%) ❌
  4. turbo (45.6%) ❌
  5. biome (45.3%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📊 搜索结果:
  1. rome (55.7%) ❌
  2. solid (49.3%) ❌
  3. svelte (48.0%) ❌
  4. biome (47.8%) ❌
  5. qwik (47.3%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📊 搜索结果:
  1. kysely (55.3%) ✅
  2. prisma (51.7%) ✅
  3. drizzle (49.0%) ✅
  4. rome (41.0%) ❌
  5. biome (39.9%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📊 搜索结果:
  1. bun (56.8%) ❌
  2. turbo (51.1%) ✅
  3. parcel (48.9%) ✅
  4. biome (47.5%) ❌
  5. rome (46.1%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📊 搜索结果:
  1. vue (47.4%) ✅
  2. svelte (47.2%) ✅
  3. qwik (45.8%) ✅
  4. solid (45.3%) ✅
  5. react (43.2%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 73.3%
  平均 Precision@5: 54.0%
  表现良好查询: 5/10 (≥66.7%)
  完全失败查询: 1/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  66.7% | 首位: bun (47.8%) 首个命中: rome
  🟢 test framework       P@3: 100.0% | 首位: jasmine (47.9%) 首个命中: jasmine
  🟡 code quality         P@3:  66.7% | 首位: standard (50.4%) 首个命中: standard
  🟢 ui framework         P@3: 100.0% | 首位: vue (42.7%) 首个命中: vue
  🟢 state management     P@3: 100.0% | 首位: recoil (54.6%) 首个命中: recoil
  🟡 package manager      P@3:  33.3% | 首位: pnpm (51.1%) 首个命中: pnpm
  🔴 javascript runtime   P@3:   0.0% | 首位: rome (55.7%) 无命中
  🟢 database orm         P@3: 100.0% | 首位: kysely (55.3%) 首个命中: kysely
  🟡 bundler              P@3:  66.7% | 首位: bun (56.8%) 首个命中: turbo
  🟢 frontend framework   P@3: 100.0% | 首位: vue (47.4%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "test framework" (100.0%)
  最差查询: "javascript runtime" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# siliconflow/Qwen/Qwen3-Embedding-8B

╭─   ~/workspace/autodev-codebase on   master ?3                                                     base
╰─❯ npx tsx src/examples/embedding-test-simple.ts
🚀 开始embedding测试...

📦 添加模拟包数据...
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📊 搜索结果:
  1. turbo (55.4%) ✅
  2. bun (54.9%) ❌
  3. biome (54.8%) ❌
  4. swc (51.4%) ✅
  5. rome (50.5%) ✅
📈 Precision@3: 33.3% | Precision@5: 60.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📊 搜索结果:
  1. mocha (52.1%) ✅
  2. ava (51.8%) ✅
  3. jasmine (49.6%) ✅
  4. tap (48.3%) ✅
  5. turbo (43.6%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📊 搜索结果:
  1. standard (55.0%) ✅
  2. qwik (52.2%) ❌
  3. biome (52.1%) ✅
  4. ava (49.0%) ❌
  5. rome (47.0%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📊 搜索结果:
  1. vue (48.2%) ✅
  2. qwik (47.3%) ✅
  3. solid (45.3%) ✅
  4. svelte (44.6%) ✅
  5. react (43.5%) ✅
📈 Precision@3: 100.0% | Precision@5: 100.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📊 搜索结果:
  1. zustand (63.4%) ✅
  2. redux (60.5%) ✅
  3. recoil (58.5%) ✅
  4. jotai (56.2%) ✅
  5. solid (52.8%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📊 搜索结果:
  1. pnpm (61.9%) ✅
  2. parcel (54.7%) ❌
  3. yarn (52.5%) ✅
  4. bun (51.2%) ✅
  5. rome (50.9%) ❌
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📊 搜索结果:
  1. rome (52.4%) ❌
  2. node (51.8%) ✅
  3. bun (51.7%) ✅
  4. deno (51.6%) ✅
  5. biome (50.6%) ❌
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📊 搜索结果:
  1. drizzle (58.0%) ✅
  2. kysely (55.1%) ✅
  3. prisma (54.1%) ✅
  4. deno (39.3%) ❌
  5. biome (38.6%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📊 搜索结果:
  1. bun (60.3%) ❌
  2. yarn (52.3%) ❌
  3. turbo (50.9%) ✅
  4. biome (49.3%) ❌
  5. parcel (47.9%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📊 搜索结果:
  1. vue (51.2%) ✅
  2. qwik (50.9%) ✅
  3. svelte (48.3%) ✅
  4. solid (48.3%) ✅
  5. react (47.9%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 76.7%
  平均 Precision@5: 66.0%
  表现良好查询: 5/10 (≥66.7%)
  完全失败查询: 0/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: turbo (55.4%) 首个命中: turbo
  🟢 test framework       P@3: 100.0% | 首位: mocha (52.1%) 首个命中: mocha
  🟡 code quality         P@3:  66.7% | 首位: standard (55.0%) 首个命中: standard
  🟢 ui framework         P@3: 100.0% | 首位: vue (48.2%) 首个命中: vue
  🟢 state management     P@3: 100.0% | 首位: zustand (63.4%) 首个命中: zustand
  🟡 package manager      P@3:  66.7% | 首位: pnpm (61.9%) 首个命中: pnpm
  🟡 javascript runtime   P@3:  66.7% | 首位: rome (52.4%) 首个命中: node
  🟢 database orm         P@3: 100.0% | 首位: drizzle (58.0%) 首个命中: drizzle
  🟡 bundler              P@3:  33.3% | 首位: bun (60.3%) 首个命中: turbo
  🟢 frontend framework   P@3: 100.0% | 首位: vue (51.2%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "test framework" (100.0%)
  最差查询: "build tool" (33.3%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# siliconflow/Qwen/Qwen3-Embedding-0.6B

╭─   ~/workspace/autodev-codebase on   master ?3                                                     base
╰─❯ npx tsx src/examples/embedding-test-simple.ts
🚀 开始embedding测试...

📦 添加模拟包数据...
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📊 搜索结果:
  1. mocha (62.4%) ❌
  2. turbo (61.1%) ✅
  3. standard (60.3%) ❌
  4. rome (59.7%) ✅
  5. ava (59.3%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📊 搜索结果:
  1. jasmine (61.9%) ✅
  2. mocha (61.4%) ✅
  3. ava (60.1%) ✅
  4. jotai (56.7%) ❌
  5. swc (53.6%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📊 搜索结果:
  1. rome (56.5%) ❌
  2. standard (55.9%) ✅
  3. mocha (55.8%) ❌
  4. ava (54.0%) ❌
  5. swc (53.6%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📊 搜索结果:
  1. vue (58.0%) ✅
  2. react (58.0%) ✅
  3. qwik (55.7%) ✅
  4. swc (55.5%) ❌
  5. rome (55.4%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📊 搜索结果:
  1. zustand (70.1%) ✅
  2. redux (66.9%) ✅
  3. recoil (62.5%) ✅
  4. react (59.6%) ❌
  5. rome (55.7%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📊 搜索结果:
  1. pnpm (65.0%) ✅
  2. yarn (61.3%) ✅
  3. mocha (61.1%) ❌
  4. react (59.3%) ❌
  5. standard (58.9%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📊 搜索结果:
  1. jasmine (66.0%) ❌
  2. react (63.4%) ❌
  3. rome (62.8%) ❌
  4. swc (62.2%) ❌
  5. turbo (60.9%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📊 搜索结果:
  1. prisma (60.0%) ✅
  2. kysely (59.5%) ✅
  3. drizzle (55.5%) ✅
  4. rome (47.1%) ❌
  5. biome (46.0%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📊 搜索结果:
  1. turbo (67.0%) ✅
  2. mocha (62.6%) ❌
  3. bun (62.2%) ❌
  4. parcel (60.0%) ✅
  5. tap (59.9%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📊 搜索结果:
  1. react (59.6%) ❌
  2. svelte (59.2%) ✅
  3. vue (59.0%) ✅
  4. rome (58.5%) ❌
  5. mocha (56.3%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 63.3%
  平均 Precision@5: 42.0%
  表现良好查询: 4/10 (≥66.7%)
  完全失败查询: 1/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: mocha (62.4%) 首个命中: turbo
  🟢 test framework       P@3: 100.0% | 首位: jasmine (61.9%) 首个命中: jasmine
  🟡 code quality         P@3:  33.3% | 首位: rome (56.5%) 首个命中: standard
  🟢 ui framework         P@3: 100.0% | 首位: vue (58.0%) 首个命中: vue
  🟢 state management     P@3: 100.0% | 首位: zustand (70.1%) 首个命中: zustand
  🟡 package manager      P@3:  66.7% | 首位: pnpm (65.0%) 首个命中: pnpm
  🔴 javascript runtime   P@3:   0.0% | 首位: jasmine (66.0%) 无命中
  🟢 database orm         P@3: 100.0% | 首位: prisma (60.0%) 首个命中: prisma
  🟡 bundler              P@3:  33.3% | 首位: turbo (67.0%) 首个命中: turbo
  🟡 frontend framework   P@3:  66.7% | 首位: react (59.6%) 首个命中: svelte

🔍 关键洞察:
  最佳查询: "test framework" (100.0%)
  最差查询: "javascript runtime" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# siliconflow/Pro/BAAI/bge-m3

╭─   ~/workspace/autodev-codebase on   master ?3                                                     base
╰─❯ npx tsx src/examples/embedding-test-simple.ts
🚀 开始embedding测试...

📦 添加模拟包数据...
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📊 搜索结果:
  1. kysely (56.1%) ❌
  2. turbo (55.5%) ✅
  3. recoil (55.0%) ❌
  4. solid (53.5%) ❌
  5. tap (52.6%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📊 搜索结果:
  1. standard (55.3%) ❌
  2. kysely (55.3%) ❌
  3. turbo (54.4%) ❌
  4. react (54.3%) ❌
  5. parcel (53.2%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📊 搜索结果:
  1. standard (52.2%) ✅
  2. solid (50.8%) ❌
  3. kysely (50.0%) ❌
  4. biome (48.4%) ✅
  5. zustand (48.4%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📊 搜索结果:
  1. vue (56.7%) ✅
  2. kysely (51.4%) ❌
  3. standard (50.7%) ❌
  4. turbo (50.3%) ❌
  5. parcel (50.2%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📊 搜索结果:
  1. zustand (56.2%) ✅
  2. kysely (48.7%) ❌
  3. standard (48.3%) ❌
  4. solid (48.0%) ❌
  5. redux (45.8%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📊 搜索结果:
  1. parcel (54.4%) ❌
  2. kysely (53.3%) ❌
  3. pnpm (52.1%) ✅
  4. standard (51.8%) ❌
  5. turbo (51.4%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📊 搜索结果:
  1. kysely (53.3%) ❌
  2. jotai (53.0%) ❌
  3. zustand (51.5%) ❌
  4. recoil (49.5%) ❌
  5. turbo (49.3%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📊 搜索结果:
  1. biome (53.0%) ❌
  2. prisma (49.7%) ✅
  3. rome (48.0%) ❌
  4. kysely (47.9%) ✅
  5. drizzle (47.6%) ✅
📈 Precision@3: 33.3% | Precision@5: 60.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📊 搜索结果:
  1. solid (51.7%) ❌
  2. drizzle (50.9%) ❌
  3. turbo (50.2%) ✅
  4. vue (50.0%) ❌
  5. standard (49.9%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📊 搜索结果:
  1. vue (56.0%) ✅
  2. kysely (55.1%) ❌
  3. react (54.2%) ❌
  4. parcel (54.2%) ❌
  5. standard (54.2%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 26.7%
  平均 Precision@5: 24.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 2/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: kysely (56.1%) 首个命中: turbo
  🔴 test framework       P@3:   0.0% | 首位: standard (55.3%) 无命中
  🟡 code quality         P@3:  33.3% | 首位: standard (52.2%) 首个命中: standard
  🟡 ui framework         P@3:  33.3% | 首位: vue (56.7%) 首个命中: vue
  🟡 state management     P@3:  33.3% | 首位: zustand (56.2%) 首个命中: zustand
  🟡 package manager      P@3:  33.3% | 首位: parcel (54.4%) 首个命中: pnpm
  🔴 javascript runtime   P@3:   0.0% | 首位: kysely (53.3%) 无命中
  🟡 database orm         P@3:  33.3% | 首位: biome (53.0%) 首个命中: prisma
  🟡 bundler              P@3:  33.3% | 首位: solid (51.7%) 首个命中: turbo
  🟡 frontend framework   P@3:  33.3% | 首位: vue (56.0%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "build tool" (33.3%)
  最差查询: "test framework" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# siliconflow/BAAI/bge-large-en-v1.5

╭─   ~/workspace/autodev-codebase on   master ?3                                                     base
╰─❯ npx tsx src/examples/embedding-test-simple.ts
🚀 开始embedding测试...

📦 添加模拟包数据...
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📊 搜索结果:
  1. turbo (62.3%) ✅
  2. bun (62.1%) ❌
  3. solid (61.0%) ❌
  4. kysely (60.9%) ❌
  5. yarn (60.5%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📊 搜索结果:
  1. mocha (57.3%) ✅
  2. bun (57.0%) ❌
  3. jasmine (56.8%) ✅
  4. turbo (56.8%) ❌
  5. kysely (56.4%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📊 搜索结果:
  1. turbo (58.7%) ❌
  2. standard (58.0%) ✅
  3. bun (56.5%) ❌
  4. ava (56.1%) ❌
  5. kysely (55.8%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📊 搜索结果:
  1. prisma (58.0%) ❌
  2. kysely (57.2%) ❌
  3. rome (56.9%) ❌
  4. solid (56.8%) ✅
  5. svelte (56.8%) ✅
📈 Precision@3: 0.0% | Precision@5: 40.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📊 搜索结果:
  1. pnpm (55.3%) ❌
  2. rome (54.2%) ❌
  3. ava (53.3%) ❌
  4. tap (52.7%) ❌
  5. zustand (52.6%) ✅
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📊 搜索结果:
  1. pnpm (67.4%) ✅
  2. bun (65.1%) ✅
  3. kysely (64.5%) ❌
  4. turbo (64.4%) ❌
  5. qwik (64.1%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📊 搜索结果:
  1. turbo (60.1%) ❌
  2. mocha (58.9%) ❌
  3. bun (58.3%) ✅
  4. jotai (57.7%) ❌
  5. jasmine (57.6%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📊 搜索结果:
  1. standard (56.7%) ❌
  2. turbo (56.1%) ❌
  3. kysely (55.2%) ✅
  4. deno (54.7%) ❌
  5. pnpm (54.6%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📊 搜索结果:
  1. turbo (60.1%) ✅
  2. yarn (59.5%) ❌
  3. kysely (58.9%) ❌
  4. svelte (57.5%) ❌
  5. parcel (57.2%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📊 搜索结果:
  1. mocha (61.6%) ❌
  2. jotai (61.1%) ❌
  3. rome (60.8%) ❌
  4. standard (60.7%) ❌
  5. svelte (60.2%) ✅
📈 Precision@3: 0.0% | Precision@5: 20.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 30.0%
  平均 Precision@5: 28.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 3/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: turbo (62.3%) 首个命中: turbo
  🟡 test framework       P@3:  66.7% | 首位: mocha (57.3%) 首个命中: mocha
  🟡 code quality         P@3:  33.3% | 首位: turbo (58.7%) 首个命中: standard
  🔴 ui framework         P@3:   0.0% | 首位: prisma (58.0%) 首个命中: solid
  🔴 state management     P@3:   0.0% | 首位: pnpm (55.3%) 首个命中: zustand
  🟡 package manager      P@3:  66.7% | 首位: pnpm (67.4%) 首个命中: pnpm
  🟡 javascript runtime   P@3:  33.3% | 首位: turbo (60.1%) 首个命中: bun
  🟡 database orm         P@3:  33.3% | 首位: standard (56.7%) 首个命中: kysely
  🟡 bundler              P@3:  33.3% | 首位: turbo (60.1%) 首个命中: turbo
  🔴 frontend framework   P@3:   0.0% | 首位: mocha (61.6%) 首个命中: svelte

🔍 关键洞察:
  最佳查询: "test framework" (66.7%)
  最差查询: "ui framework" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# siliconflow/netease-youdao/bce-embedding-base_v1

╭─   ~/workspace/autodev-codebase on   master ?3                                                     base
╰─❯ npx tsx src/examples/embedding-test-simple.ts
🚀 开始embedding测试...

📦 添加模拟包数据...
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📊 搜索结果:
  1. solid (52.4%) ❌
  2. qwik (52.1%) ❌
  3. prisma (52.1%) ❌
  4. standard (52.1%) ❌
  5. rome (51.7%) ✅
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📊 搜索结果:
  1. standard (51.7%) ❌
  2. rome (51.2%) ❌
  3. prisma (51.0%) ❌
  4. tap (50.7%) ✅
  5. solid (50.1%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📊 搜索结果:
  1. mocha (45.2%) ❌
  2. standard (45.1%) ✅
  3. swc (45.1%) ❌
  4. rome (45.0%) ❌
  5. solid (44.9%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📊 搜索结果:
  1. qwik (55.2%) ✅
  2. redux (52.2%) ❌
  3. swc (52.2%) ❌
  4. vue (51.8%) ✅
  5. ava (51.0%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📊 搜索结果:
  1. swc (51.4%) ❌
  2. ava (50.2%) ❌
  3. kysely (46.7%) ❌
  4. qwik (46.7%) ❌
  5. mocha (46.5%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📊 搜索结果:
  1. swc (53.0%) ❌
  2. parcel (52.6%) ❌
  3. tap (52.6%) ❌
  4. rome (52.3%) ❌
  5. ava (52.1%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📊 搜索结果:
  1. jasmine (53.8%) ❌
  2. qwik (51.3%) ❌
  3. rome (50.9%) ❌
  4. react (50.8%) ❌
  5. jotai (50.6%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📊 搜索结果:
  1. rome (56.5%) ❌
  2. mocha (53.2%) ❌
  3. biome (52.5%) ❌
  4. prisma (52.4%) ✅
  5. turbo (51.3%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📊 搜索结果:
  1. swc (54.5%) ✅
  2. drizzle (54.3%) ❌
  3. solid (54.3%) ❌
  4. bun (53.5%) ❌
  5. recoil (52.6%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📊 搜索结果:
  1. standard (56.5%) ❌
  2. rome (55.9%) ❌
  3. solid (55.6%) ✅
  4. swc (55.5%) ❌
  5. ava (55.2%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 13.3%
  平均 Precision@5: 16.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 6/10 (0%)

📋 详细结果:
  🔴 build tool           P@3:   0.0% | 首位: solid (52.4%) 首个命中: rome
  🔴 test framework       P@3:   0.0% | 首位: standard (51.7%) 首个命中: tap
  🟡 code quality         P@3:  33.3% | 首位: mocha (45.2%) 首个命中: standard
  🟡 ui framework         P@3:  33.3% | 首位: qwik (55.2%) 首个命中: qwik
  🔴 state management     P@3:   0.0% | 首位: swc (51.4%) 无命中
  🔴 package manager      P@3:   0.0% | 首位: swc (53.0%) 无命中
  🔴 javascript runtime   P@3:   0.0% | 首位: jasmine (53.8%) 无命中
  🔴 database orm         P@3:   0.0% | 首位: rome (56.5%) 首个命中: prisma
  🟡 bundler              P@3:  33.3% | 首位: swc (54.5%) 首个命中: swc
  🟡 frontend framework   P@3:  33.3% | 首位: standard (56.5%) 首个命中: solid

🔍 关键洞察:
  最佳查询: "code quality" (33.3%)
  最差查询: "build tool" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# morph-embedding-v2

╭─   ~/workspace/autodev-codebase on   master ?3                                                     base
╰─❯ npx tsx src/examples/embedding-test-simple.ts
🚀 开始embedding测试...

📦 添加模拟包数据...
document dimension 1536
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📊 搜索结果:
  1. solid (66.5%) ❌
  2. standard (64.8%) ❌
  3. turbo (64.6%) ✅
  4. swc (64.0%) ✅
  5. rome (64.0%) ✅
📈 Precision@3: 33.3% | Precision@5: 60.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📊 搜索结果:
  1. mocha (68.9%) ✅
  2. jasmine (67.9%) ✅
  3. ava (67.1%) ✅
  4. standard (66.3%) ❌
  5. rome (66.1%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📊 搜索结果:
  1. standard (66.6%) ✅
  2. solid (65.4%) ❌
  3. qwik (65.1%) ❌
  4. rome (63.7%) ❌
  5. mocha (63.5%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📊 搜索结果:
  1. qwik (66.5%) ✅
  2. rome (66.4%) ❌
  3. vue (66.1%) ✅
  4. solid (65.9%) ✅
  5. react (64.4%) ✅
📈 Precision@3: 66.7% | Precision@5: 80.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📊 搜索结果:
  1. redux (66.0%) ✅
  2. zustand (65.5%) ✅
  3. prisma (64.9%) ❌
  4. solid (64.8%) ❌
  5. jotai (64.4%) ✅
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📊 搜索结果:
  1. pnpm (69.4%) ✅
  2. prisma (68.3%) ❌
  3. solid (68.2%) ❌
  4. parcel (67.2%) ❌
  5. rome (66.7%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📊 搜索结果:
  1. rome (70.5%) ❌
  2. solid (68.5%) ❌
  3. swc (68.5%) ❌
  4. ava (68.0%) ❌
  5. standard (67.5%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📊 搜索结果:
  1. kysely (68.0%) ✅
  2. drizzle (66.4%) ✅
  3. prisma (65.7%) ✅
  4. rome (62.4%) ❌
  5. solid (60.3%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📊 搜索结果:
  1. bun (70.3%) ❌
  2. parcel (65.9%) ✅
  3. solid (65.3%) ❌
  4. deno (64.4%) ❌
  5. standard (64.2%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📊 搜索结果:
  1. qwik (66.3%) ✅
  2. vue (66.0%) ✅
  3. solid (65.8%) ✅
  4. rome (65.8%) ❌
  5. react (65.5%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 56.7%
  平均 Precision@5: 44.0%
  表现良好查询: 3/10 (≥66.7%)
  完全失败查询: 1/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: solid (66.5%) 首个命中: turbo
  🟢 test framework       P@3: 100.0% | 首位: mocha (68.9%) 首个命中: mocha
  🟡 code quality         P@3:  33.3% | 首位: standard (66.6%) 首个命中: standard
  🟡 ui framework         P@3:  66.7% | 首位: qwik (66.5%) 首个命中: qwik
  🟡 state management     P@3:  66.7% | 首位: redux (66.0%) 首个命中: redux
  🟡 package manager      P@3:  33.3% | 首位: pnpm (69.4%) 首个命中: pnpm
  🔴 javascript runtime   P@3:   0.0% | 首位: rome (70.5%) 无命中
  🟢 database orm         P@3: 100.0% | 首位: kysely (68.0%) 首个命中: kysely
  🟡 bundler              P@3:  33.3% | 首位: bun (70.3%) 首个命中: parcel
  🟢 frontend framework   P@3: 100.0% | 首位: qwik (66.3%) 首个命中: qwik

🔍 关键洞察:
  最佳查询: "test framework" (100.0%)
  最差查询: "javascript runtime" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# openai/text-embedding-ada-002

╭─   ~/workspace/autodev-codebase on   master ?3                                                     base
╰─❯ npx tsx src/examples/embedding-test-simple.ts
🚀 开始embedding测试...

📦 添加模拟包数据...
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📊 搜索结果:
  1. swc (77.2%) ✅
  2. yarn (77.1%) ❌
  3. svelte (77.0%) ❌
  4. turbo (76.7%) ✅
  5. jotai (76.6%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📊 搜索结果:
  1. jasmine (79.8%) ✅
  2. mocha (79.0%) ✅
  3. ava (77.7%) ✅
  4. standard (77.5%) ❌
  5. svelte (77.4%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📊 搜索结果:
  1. qwik (77.0%) ❌
  2. jotai (76.6%) ❌
  3. standard (76.6%) ✅
  4. svelte (76.3%) ❌
  5. jasmine (76.2%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📊 搜索结果:
  1. vue (78.6%) ✅
  2. svelte (78.5%) ✅
  3. redux (78.0%) ❌
  4. jotai (77.9%) ❌
  5. react (77.6%) ✅
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📊 搜索结果:
  1. redux (80.9%) ✅
  2. zustand (78.1%) ✅
  3. recoil (77.8%) ✅
  4. svelte (76.8%) ❌
  5. react (76.8%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📊 搜索结果:
  1. pnpm (79.6%) ✅
  2. yarn (79.3%) ✅
  3. parcel (78.7%) ❌
  4. mocha (77.9%) ❌
  5. jasmine (77.7%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📊 搜索结果:
  1. react (78.7%) ❌
  2. svelte (78.7%) ❌
  3. parcel (78.6%) ❌
  4. jasmine (78.5%) ❌
  5. standard (78.4%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📊 搜索结果:
  1. prisma (78.2%) ✅
  2. jotai (76.5%) ❌
  3. rome (75.8%) ❌
  4. parcel (75.7%) ❌
  5. kysely (75.6%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📊 搜索结果:
  1. bun (80.2%) ❌
  2. parcel (80.0%) ✅
  3. svelte (79.9%) ❌
  4. jasmine (79.1%) ❌
  5. yarn (78.8%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📊 搜索结果:
  1. svelte (79.1%) ✅
  2. vue (79.1%) ✅
  3. redux (78.3%) ❌
  4. react (78.1%) ❌
  5. turbo (77.1%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 53.3%
  平均 Precision@5: 38.0%
  表现良好查询: 2/10 (≥66.7%)
  完全失败查询: 1/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: swc (77.2%) 首个命中: swc
  🟢 test framework       P@3: 100.0% | 首位: jasmine (79.8%) 首个命中: jasmine
  🟡 code quality         P@3:  33.3% | 首位: qwik (77.0%) 首个命中: standard
  🟡 ui framework         P@3:  66.7% | 首位: vue (78.6%) 首个命中: vue
  🟢 state management     P@3: 100.0% | 首位: redux (80.9%) 首个命中: redux
  🟡 package manager      P@3:  66.7% | 首位: pnpm (79.6%) 首个命中: pnpm
  🔴 javascript runtime   P@3:   0.0% | 首位: react (78.7%) 无命中
  🟡 database orm         P@3:  33.3% | 首位: prisma (78.2%) 首个命中: prisma
  🟡 bundler              P@3:  33.3% | 首位: bun (80.2%) 首个命中: parcel
  🟡 frontend framework   P@3:  66.7% | 首位: svelte (79.1%) 首个命中: svelte

🔍 关键洞察:
  最佳查询: "test framework" (100.0%)
  最差查询: "javascript runtime" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# openai/text-embedding-3-small

╭─   ~/workspace/autodev-codebase on   master ?3                                          took  7s  base
╰─❯ npx tsx src/examples/embedding-test-simple.ts
🚀 开始embedding测试...

📦 添加模拟包数据...
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📊 搜索结果:
  1. bun (35.5%) ❌
  2. deno (33.1%) ❌
  3. yarn (31.2%) ❌
  4. node (30.6%) ❌
  5. mocha (30.5%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📊 搜索结果:
  1. mocha (40.7%) ✅
  2. jasmine (38.6%) ✅
  3. ava (32.8%) ✅
  4. turbo (32.6%) ❌
  5. rome (31.9%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📊 搜索结果:
  1. mocha (30.1%) ❌
  2. qwik (29.5%) ❌
  3. jasmine (27.1%) ❌
  4. swc (26.9%) ❌
  5. standard (25.7%) ✅
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📊 搜索结果:
  1. qwik (40.5%) ✅
  2. vue (38.5%) ✅
  3. swc (38.2%) ❌
  4. svelte (38.0%) ✅
  5. mocha (37.7%) ❌
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📊 搜索结果:
  1. zustand (45.2%) ✅
  2. swc (35.2%) ❌
  3. svelte (33.0%) ❌
  4. qwik (32.9%) ❌
  5. standard (32.4%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📊 搜索结果:
  1. pnpm (39.9%) ✅
  2. parcel (35.4%) ❌
  3. yarn (34.1%) ✅
  4. deno (32.2%) ❌
  5. mocha (30.8%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📊 搜索结果:
  1. jasmine (45.5%) ❌
  2. rome (44.3%) ❌
  3. mocha (41.9%) ❌
  4. turbo (41.6%) ❌
  5. swc (40.1%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📊 搜索结果:
  1. rome (32.5%) ❌
  2. ava (31.6%) ❌
  3. mocha (31.2%) ❌
  4. prisma (31.1%) ✅
  5. jasmine (29.7%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📊 搜索结果:
  1. bun (47.6%) ❌
  2. parcel (40.0%) ✅
  3. yarn (37.7%) ❌
  4. deno (36.1%) ❌
  5. turbo (34.6%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📊 搜索结果:
  1. prisma (41.1%) ❌
  2. svelte (40.5%) ✅
  3. turbo (40.4%) ❌
  4. react (39.6%) ❌
  5. jasmine (39.2%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 33.3%
  平均 Precision@5: 28.0%
  表现良好查询: 1/10 (≥66.7%)
  完全失败查询: 4/10 (0%)

📋 详细结果:
  🔴 build tool           P@3:   0.0% | 首位: bun (35.5%) 无命中
  🟢 test framework       P@3: 100.0% | 首位: mocha (40.7%) 首个命中: mocha
  🔴 code quality         P@3:   0.0% | 首位: mocha (30.1%) 首个命中: standard
  🟡 ui framework         P@3:  66.7% | 首位: qwik (40.5%) 首个命中: qwik
  🟡 state management     P@3:  33.3% | 首位: zustand (45.2%) 首个命中: zustand
  🟡 package manager      P@3:  66.7% | 首位: pnpm (39.9%) 首个命中: pnpm
  🔴 javascript runtime   P@3:   0.0% | 首位: jasmine (45.5%) 无命中
  🔴 database orm         P@3:   0.0% | 首位: rome (32.5%) 首个命中: prisma
  🟡 bundler              P@3:  33.3% | 首位: bun (47.6%) 首个命中: parcel
  🟡 frontend framework   P@3:  33.3% | 首位: prisma (41.1%) 首个命中: svelte

🔍 关键洞察:
  最佳查询: "test framework" (100.0%)
  最差查询: "build tool" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# openai/text-embedding-3-large

╭─   ~/workspace/autodev-codebase on   master ?3                                          took  6s  base
╰─❯ npx tsx src/examples/embedding-test-simple.ts
🚀 开始embedding测试...

📦 添加模拟包数据...
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📊 搜索结果:
  1. swc (39.3%) ✅
  2. parcel (35.1%) ✅
  3. qwik (34.4%) ❌
  4. jotai (33.5%) ❌
  5. tap (33.4%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📊 搜索结果:
  1. mocha (35.7%) ✅
  2. jasmine (33.9%) ✅
  3. tap (31.7%) ✅
  4. kysely (30.6%) ❌
  5. ava (28.5%) ✅
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📊 搜索结果:
  1. kysely (28.9%) ❌
  2. qwik (28.8%) ❌
  3. swc (27.9%) ❌
  4. standard (26.9%) ✅
  5. jotai (25.4%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📊 搜索结果:
  1. qwik (34.7%) ✅
  2. vue (33.1%) ✅
  3. kysely (32.7%) ❌
  4. swc (32.0%) ❌
  5. jotai (30.3%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📊 搜索结果:
  1. zustand (33.8%) ✅
  2. redux (29.0%) ✅
  3. kysely (27.3%) ❌
  4. swc (26.0%) ❌
  5. recoil (24.4%) ✅
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📊 搜索结果:
  1. swc (31.5%) ❌
  2. kysely (29.4%) ❌
  3. parcel (28.9%) ❌
  4. qwik (28.3%) ❌
  5. tap (27.2%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📊 搜索结果:
  1. swc (35.6%) ❌
  2. kysely (35.5%) ❌
  3. rome (35.1%) ❌
  4. turbo (34.5%) ❌
  5. qwik (34.5%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📊 搜索结果:
  1. kysely (26.6%) ✅
  2. prisma (24.7%) ✅
  3. jotai (21.4%) ❌
  4. solid (21.4%) ❌
  5. biome (20.9%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📊 搜索结果:
  1. bun (40.7%) ❌
  2. parcel (38.9%) ✅
  3. swc (36.1%) ✅
  4. turbo (34.4%) ✅
  5. tap (33.8%) ❌
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📊 搜索结果:
  1. vue (31.5%) ✅
  2. swc (31.5%) ❌
  3. kysely (30.6%) ❌
  4. turbo (29.3%) ❌
  5. qwik (28.4%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 46.7%
  平均 Precision@5: 38.0%
  表现良好查询: 1/10 (≥66.7%)
  完全失败查询: 3/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  66.7% | 首位: swc (39.3%) 首个命中: swc
  🟢 test framework       P@3: 100.0% | 首位: mocha (35.7%) 首个命中: mocha
  🔴 code quality         P@3:   0.0% | 首位: kysely (28.9%) 首个命中: standard
  🟡 ui framework         P@3:  66.7% | 首位: qwik (34.7%) 首个命中: qwik
  🟡 state management     P@3:  66.7% | 首位: zustand (33.8%) 首个命中: zustand
  🔴 package manager      P@3:   0.0% | 首位: swc (31.5%) 无命中
  🔴 javascript runtime   P@3:   0.0% | 首位: swc (35.6%) 无命中
  🟡 database orm         P@3:  66.7% | 首位: kysely (26.6%) 首个命中: kysely
  🟡 bundler              P@3:  66.7% | 首位: bun (40.7%) 首个命中: parcel
  🟡 frontend framework   P@3:  33.3% | 首位: vue (31.5%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "test framework" (100.0%)
  最差查询: "code quality" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# voyage/voyage-3-large

╭─   ~/workspace/autodev-codebase on   master !1 ?3                                                  base
╰─❯ npx tsx src/examples/embedding-test-simple.ts
🚀 开始embedding测试...

📦 添加模拟包数据...
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📊 搜索结果:
  1. bun (56.3%) ❌
  2. deno (54.1%) ❌
  3. solid (51.6%) ❌
  4. kysely (51.4%) ❌
  5. yarn (51.2%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📊 搜索结果:
  1. jasmine (57.8%) ✅
  2. mocha (57.4%) ✅
  3. ava (57.0%) ✅
  4. tap (55.2%) ✅
  5. standard (51.7%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
Rate limit hit, retrying in 500ms (attempt 1/10)
Rate limit hit, retrying in 1000ms (attempt 2/10)
Rate limit hit, retrying in 2000ms (attempt 3/10)
Rate limit hit, retrying in 4000ms (attempt 4/10)
Rate limit hit, retrying in 8000ms (attempt 5/10)
Rate limit hit, retrying in 16000ms (attempt 6/10)
📊 搜索结果:
  1. standard (49.9%) ✅
  2. solid (48.5%) ❌
  3. jasmine (47.5%) ❌
  4. kysely (46.8%) ❌
  5. deno (46.6%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📊 搜索结果:
  1. jotai (52.1%) ❌
  2. svelte (51.8%) ✅
  3. kysely (51.5%) ❌
  4. redux (51.2%) ❌
  5. solid (51.2%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📊 搜索结果:
  1. zustand (60.7%) ✅
  2. redux (58.0%) ✅
  3. jotai (57.0%) ✅
  4. recoil (53.2%) ✅
  5. kysely (50.6%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📊 搜索结果:
  1. pnpm (61.9%) ✅
  2. bun (58.4%) ✅
  3. yarn (57.5%) ✅
  4. deno (56.7%) ❌
  5. solid (55.4%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📊 搜索结果:
  1. jasmine (57.2%) ❌
  2. node (55.8%) ✅
  3. deno (55.7%) ✅
  4. rome (55.4%) ❌
  5. kysely (54.1%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📊 搜索结果:
  1. kysely (57.7%) ✅
  2. prisma (50.4%) ✅
  3. deno (49.0%) ❌
  4. rome (48.9%) ❌
  5. jotai (47.9%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📊 搜索结果:
  1. bun (64.1%) ❌
  2. biome (55.4%) ❌
  3. yarn (54.8%) ❌
  4. parcel (54.0%) ✅
  5. solid (52.3%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📊 搜索结果:
  1. svelte (51.3%) ✅
  2. kysely (50.9%) ❌
  3. redux (50.0%) ❌
  4. solid (49.7%) ✅
  5. jotai (49.1%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 53.3%
  平均 Precision@5: 42.0%
  表现良好查询: 3/10 (≥66.7%)
  完全失败查询: 2/10 (0%)

📋 详细结果:
  🔴 build tool           P@3:   0.0% | 首位: bun (56.3%) 无命中
  🟢 test framework       P@3: 100.0% | 首位: jasmine (57.8%) 首个命中: jasmine
  🟡 code quality         P@3:  33.3% | 首位: standard (49.9%) 首个命中: standard
  🟡 ui framework         P@3:  33.3% | 首位: jotai (52.1%) 首个命中: svelte
  🟢 state management     P@3: 100.0% | 首位: zustand (60.7%) 首个命中: zustand
  🟢 package manager      P@3: 100.0% | 首位: pnpm (61.9%) 首个命中: pnpm
  🟡 javascript runtime   P@3:  66.7% | 首位: jasmine (57.2%) 首个命中: node
  🟡 database orm         P@3:  66.7% | 首位: kysely (57.7%) 首个命中: kysely
  🔴 bundler              P@3:   0.0% | 首位: bun (64.1%) 首个命中: parcel
  🟡 frontend framework   P@3:  33.3% | 首位: svelte (51.3%) 首个命中: svelte

🔍 关键洞察:
  最佳查询: "test framework" (100.0%)
  最差查询: "build tool" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# voyage/voyage-3.5

╭─   ~/workspace/autodev-codebase on   master !1 ?3                                                  base
╰─❯ npx tsx src/examples/embedding-test-simple.ts
🚀 开始embedding测试...

📦 添加模拟包数据...
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📊 搜索结果:
  1. parcel (41.0%) ✅
  2. bun (38.6%) ❌
  3. deno (38.1%) ❌
  4. standard (37.0%) ❌
  5. swc (36.7%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📊 搜索结果:
  1. tap (43.4%) ✅
  2. parcel (42.7%) ❌
  3. ava (42.6%) ✅
  4. jasmine (41.9%) ✅
  5. mocha (41.7%) ✅
📈 Precision@3: 66.7% | Precision@5: 80.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
Rate limit hit, retrying in 500ms (attempt 1/10)
Rate limit hit, retrying in 1000ms (attempt 2/10)
Rate limit hit, retrying in 2000ms (attempt 3/10)
Rate limit hit, retrying in 4000ms (attempt 4/10)
Rate limit hit, retrying in 8000ms (attempt 5/10)
Rate limit hit, retrying in 16000ms (attempt 6/10)
Rate limit hit, retrying in 32000ms (attempt 7/10)
📊 搜索结果:
  1. standard (44.5%) ✅
  2. parcel (43.8%) ❌
  3. ava (40.1%) ❌
  4. deno (40.0%) ❌
  5. tap (38.9%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📊 搜索结果:
  1. parcel (45.2%) ❌
  2. redux (44.1%) ❌
  3. turbo (43.6%) ❌
  4. drizzle (43.3%) ❌
  5. recoil (43.2%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📊 搜索结果:
  1. zustand (38.7%) ✅
  2. recoil (37.6%) ✅
  3. redux (37.3%) ✅
  4. parcel (35.8%) ❌
  5. rome (33.8%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
Rate limit hit, retrying in 500ms (attempt 1/10)
Rate limit hit, retrying in 1000ms (attempt 2/10)
Rate limit hit, retrying in 2000ms (attempt 3/10)
Rate limit hit, retrying in 4000ms (attempt 4/10)
Rate limit hit, retrying in 8000ms (attempt 5/10)
Rate limit hit, retrying in 16000ms (attempt 6/10)
Rate limit hit, retrying in 32000ms (attempt 7/10)
📊 搜索结果:
  1. pnpm (59.8%) ✅
  2. yarn (56.1%) ✅
  3. parcel (52.8%) ❌
  4. bun (51.4%) ✅
  5. node (50.3%) ❌
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📊 搜索结果:
  1. parcel (46.8%) ❌
  2. deno (45.1%) ✅
  3. jasmine (44.9%) ❌
  4. node (44.9%) ✅
  5. jotai (44.6%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📊 搜索结果:
  1. prisma (47.0%) ✅
  2. deno (44.7%) ❌
  3. kysely (42.6%) ✅
  4. parcel (41.7%) ❌
  5. recoil (41.7%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
Rate limit hit, retrying in 500ms (attempt 1/10)
Rate limit hit, retrying in 1000ms (attempt 2/10)
Rate limit hit, retrying in 2000ms (attempt 3/10)
Rate limit hit, retrying in 4000ms (attempt 4/10)
Rate limit hit, retrying in 8000ms (attempt 5/10)
Rate limit hit, retrying in 16000ms (attempt 6/10)
Rate limit hit, retrying in 32000ms (attempt 7/10)
📊 搜索结果:
  1. bun (57.9%) ❌
  2. parcel (55.1%) ✅
  3. drizzle (47.5%) ❌
  4. turbo (46.3%) ✅
  5. yarn (45.7%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📊 搜索结果:
  1. parcel (53.4%) ❌
  2. recoil (49.4%) ❌
  3. redux (47.5%) ❌
  4. yarn (47.0%) ❌
  5. deno (46.1%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 43.3%
  平均 Precision@5: 38.0%
  表现良好查询: 1/10 (≥66.7%)
  完全失败查询: 2/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: parcel (41.0%) 首个命中: parcel
  🟡 test framework       P@3:  66.7% | 首位: tap (43.4%) 首个命中: tap
  🟡 code quality         P@3:  33.3% | 首位: standard (44.5%) 首个命中: standard
  🔴 ui framework         P@3:   0.0% | 首位: parcel (45.2%) 无命中
  🟢 state management     P@3: 100.0% | 首位: zustand (38.7%) 首个命中: zustand
  🟡 package manager      P@3:  66.7% | 首位: pnpm (59.8%) 首个命中: pnpm
  🟡 javascript runtime   P@3:  33.3% | 首位: parcel (46.8%) 首个命中: deno
  🟡 database orm         P@3:  66.7% | 首位: prisma (47.0%) 首个命中: prisma
  🟡 bundler              P@3:  33.3% | 首位: bun (57.9%) 首个命中: parcel
  🔴 frontend framework   P@3:   0.0% | 首位: parcel (53.4%) 无命中

🔍 关键洞察:
  最佳查询: "state management" (100.0%)
  最差查询: "ui framework" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# voyage/voyage-code-3

╭─   ~/workspace/autodev-codebase on   master !1 ?3                                                  base
╰─❯ npx tsx src/examples/embedding-test-simple.ts
🚀 开始embedding测试...

📦 添加模拟包数据...
document dimension 1024
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📊 搜索结果:
  1. bun (60.2%) ❌
  2. swc (59.2%) ✅
  3. turbo (58.4%) ✅
  4. pnpm (57.9%) ❌
  5. deno (57.8%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📊 搜索结果:
  1. mocha (65.0%) ✅
  2. ava (62.5%) ✅
  3. tap (60.7%) ✅
  4. jasmine (60.6%) ✅
  5. standard (57.8%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📊 搜索结果:
  1. standard (54.9%) ✅
  2. swc (53.9%) ❌
  3. ava (53.5%) ❌
  4. turbo (52.9%) ❌
  5. qwik (52.6%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📊 搜索结果:
  1. svelte (59.6%) ✅
  2. qwik (59.1%) ✅
  3. vue (58.0%) ✅
  4. react (56.2%) ✅
  5. swc (55.7%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📊 搜索结果:
  1. zustand (65.3%) ✅
  2. redux (62.6%) ✅
  3. recoil (58.5%) ✅
  4. jotai (58.1%) ✅
  5. svelte (57.8%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📊 搜索结果:
  1. pnpm (71.0%) ✅
  2. yarn (63.0%) ✅
  3. bun (62.3%) ✅
  4. rome (61.8%) ❌
  5. deno (61.6%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📊 搜索结果:
  1. rome (63.6%) ❌
  2. swc (62.1%) ❌
  3. turbo (61.7%) ❌
  4. jasmine (60.6%) ❌
  5. biome (60.5%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📊 搜索结果:
  1. kysely (66.3%) ✅
  2. prisma (59.2%) ✅
  3. drizzle (55.5%) ✅
  4. rome (54.8%) ❌
  5. deno (54.1%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📊 搜索结果:
  1. bun (69.0%) ❌
  2. turbo (61.2%) ✅
  3. yarn (60.6%) ❌
  4. parcel (60.1%) ✅
  5. pnpm (60.0%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📊 搜索结果:
  1. svelte (63.3%) ✅
  2. vue (61.1%) ✅
  3. qwik (59.5%) ✅
  4. react (57.8%) ❌
  5. redux (56.9%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 73.3%
  平均 Precision@5: 52.0%
  表现良好查询: 6/10 (≥66.7%)
  完全失败查询: 1/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  66.7% | 首位: bun (60.2%) 首个命中: swc
  🟢 test framework       P@3: 100.0% | 首位: mocha (65.0%) 首个命中: mocha
  🟡 code quality         P@3:  33.3% | 首位: standard (54.9%) 首个命中: standard
  🟢 ui framework         P@3: 100.0% | 首位: svelte (59.6%) 首个命中: svelte
  🟢 state management     P@3: 100.0% | 首位: zustand (65.3%) 首个命中: zustand
  🟢 package manager      P@3: 100.0% | 首位: pnpm (71.0%) 首个命中: pnpm
  🔴 javascript runtime   P@3:   0.0% | 首位: rome (63.6%) 无命中
  🟢 database orm         P@3: 100.0% | 首位: kysely (66.3%) 首个命中: kysely
  🟡 bundler              P@3:  33.3% | 首位: bun (69.0%) 首个命中: turbo
  🟢 frontend framework   P@3: 100.0% | 首位: svelte (63.3%) 首个命中: svelte

🔍 关键洞察:
  最佳查询: "test framework" (100.0%)
  最差查询: "javascript runtime" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# voyage/voyage-3.5-lite

╭─   ~/workspace/autodev-codebase on   master !1 ?3                                                  base
╰─❯ npx tsx src/examples/embedding-test-simple.ts
🚀 开始embedding测试...

📦 添加模拟包数据...
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📊 搜索结果:
  1. swc (49.3%) ✅
  2. deno (47.7%) ❌
  3. bun (44.3%) ❌
  4. node (43.3%) ❌
  5. qwik (43.2%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📊 搜索结果:
  1. mocha (44.7%) ✅
  2. deno (41.9%) ❌
  3. qwik (41.2%) ❌
  4. jasmine (40.1%) ✅
  5. vue (38.4%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
Rate limit hit, retrying in 500ms (attempt 1/10)
Rate limit hit, retrying in 1000ms (attempt 2/10)
Rate limit hit, retrying in 2000ms (attempt 3/10)
Rate limit hit, retrying in 4000ms (attempt 4/10)
Rate limit hit, retrying in 8000ms (attempt 5/10)
Rate limit hit, retrying in 16000ms (attempt 6/10)
Rate limit hit, retrying in 32000ms (attempt 7/10)
📊 搜索结果:
  1. qwik (46.5%) ❌
  2. deno (46.4%) ❌
  3. mocha (46.3%) ❌
  4. swc (43.4%) ❌
  5. jasmine (40.0%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📊 搜索结果:
  1. qwik (47.4%) ✅
  2. vue (45.0%) ✅
  3. react (42.2%) ✅
  4. redux (41.0%) ❌
  5. swc (39.9%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📊 搜索结果:
  1. deno (38.2%) ❌
  2. redux (36.5%) ✅
  3. swc (36.3%) ❌
  4. recoil (35.3%) ✅
  5. react (35.2%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
Rate limit hit, retrying in 500ms (attempt 1/10)
Rate limit hit, retrying in 1000ms (attempt 2/10)
Rate limit hit, retrying in 2000ms (attempt 3/10)
Rate limit hit, retrying in 4000ms (attempt 4/10)
Rate limit hit, retrying in 8000ms (attempt 5/10)
Rate limit hit, retrying in 16000ms (attempt 6/10)
Rate limit hit, retrying in 32000ms (attempt 7/10)
📊 搜索结果:
  1. yarn (53.4%) ✅
  2. parcel (52.8%) ❌
  3. pnpm (49.5%) ✅
  4. node (47.9%) ❌
  5. mocha (47.3%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📊 搜索结果:
  1. rome (48.9%) ❌
  2. drizzle (47.5%) ❌
  3. jasmine (47.3%) ❌
  4. mocha (47.0%) ❌
  5. swc (46.8%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📊 搜索结果:
  1. deno (38.9%) ❌
  2. swc (37.1%) ❌
  3. prisma (36.4%) ✅
  4. mocha (35.1%) ❌
  5. bun (34.4%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
Rate limit hit, retrying in 500ms (attempt 1/10)
Rate limit hit, retrying in 1000ms (attempt 2/10)
Rate limit hit, retrying in 2000ms (attempt 3/10)
Rate limit hit, retrying in 4000ms (attempt 4/10)
Rate limit hit, retrying in 8000ms (attempt 5/10)
Rate limit hit, retrying in 16000ms (attempt 6/10)
Rate limit hit, retrying in 32000ms (attempt 7/10)
📊 搜索结果:
  1. bun (53.2%) ❌
  2. parcel (46.3%) ✅
  3. deno (45.0%) ❌
  4. yarn (44.7%) ❌
  5. recoil (43.2%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📊 搜索结果:
  1. vue (54.5%) ✅
  2. react (46.5%) ❌
  3. redux (44.6%) ❌
  4. deno (43.2%) ❌
  5. qwik (42.9%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 36.7%
  平均 Precision@5: 28.0%
  表现良好查询: 1/10 (≥66.7%)
  完全失败查询: 2/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: swc (49.3%) 首个命中: swc
  🟡 test framework       P@3:  33.3% | 首位: mocha (44.7%) 首个命中: mocha
  🔴 code quality         P@3:   0.0% | 首位: qwik (46.5%) 无命中
  🟢 ui framework         P@3: 100.0% | 首位: qwik (47.4%) 首个命中: qwik
  🟡 state management     P@3:  33.3% | 首位: deno (38.2%) 首个命中: redux
  🟡 package manager      P@3:  66.7% | 首位: yarn (53.4%) 首个命中: yarn
  🔴 javascript runtime   P@3:   0.0% | 首位: rome (48.9%) 无命中
  🟡 database orm         P@3:  33.3% | 首位: deno (38.9%) 首个命中: prisma
  🟡 bundler              P@3:  33.3% | 首位: bun (53.2%) 首个命中: parcel
  🟡 frontend framework   P@3:  33.3% | 首位: vue (54.5%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "ui framework" (100.0%)
  最差查询: "code quality" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# ollama/dengcao/Qwen3-Embedding-4B:Q4_K_M

🚀 开始embedding测试...

[memory-vector-search] {
  ollamaBaseUrl: 'http://192.168.31.10:11434',
  ollamaModelId: 'dengcao/Qwen3-Embedding-4B:Q4_K_M',
  type: 'ollama'
}
📦 添加模拟包数据...
ℹ No proxy configured
document dimension 2560
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
ℹ No proxy configured
📊 搜索结果:
  1. biome (54.8%) ❌
  2. yarn (52.4%) ❌
  3. rome (52.0%) ✅
  4. node (50.7%) ❌
  5. parcel (50.3%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
ℹ No proxy configured
📊 搜索结果:
  1. mocha (51.3%) ✅
  2. ava (49.5%) ✅
  3. jasmine (47.8%) ✅
  4. tap (47.4%) ✅
  5. biome (46.9%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
ℹ No proxy configured
📊 搜索结果:
  1. biome (50.3%) ✅
  2. standard (42.5%) ✅
  3. rome (42.1%) ❌
  4. node (40.8%) ❌
  5. qwik (39.8%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
ℹ No proxy configured
📊 搜索结果:
  1. vue (44.7%) ✅
  2. svelte (44.1%) ✅
  3. solid (43.4%) ✅
  4. biome (42.9%) ❌
  5. drizzle (42.8%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
ℹ No proxy configured
📊 搜索结果:
  1. zustand (58.3%) ✅
  2. recoil (56.5%) ✅
  3. redux (55.3%) ✅
  4. jotai (50.0%) ✅
  5. react (46.9%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
ℹ No proxy configured
📊 搜索结果:
  1. pnpm (57.6%) ✅
  2. yarn (55.8%) ✅
  3. node (51.1%) ❌
  4. biome (51.1%) ❌
  5. rome (50.2%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
ℹ No proxy configured
📊 搜索结果:
  1. rome (55.9%) ❌
  2. node (52.4%) ✅
  3. biome (49.9%) ❌
  4. react (48.0%) ❌
  5. standard (47.3%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
ℹ No proxy configured
📊 搜索结果:
  1. kysely (53.0%) ✅
  2. prisma (47.9%) ✅
  3. drizzle (44.2%) ✅
  4. biome (39.8%) ❌
  5. rome (38.7%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
ℹ No proxy configured
📊 搜索结果:
  1. node (52.1%) ❌
  2. yarn (51.2%) ❌
  3. biome (49.4%) ❌
  4. pnpm (47.1%) ❌
  5. standard (46.4%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
ℹ No proxy configured
📊 搜索结果:
  1. vue (50.7%) ✅
  2. svelte (50.1%) ✅
  3. react (46.8%) ❌
  4. drizzle (45.0%) ❌
  5. solid (45.0%) ✅
📈 Precision@3: 66.7% | Precision@5: 60.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 66.7%
  平均 Precision@5: 48.0%
  表现良好查询: 4/10 (≥66.7%)
  完全失败查询: 1/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: biome (54.8%) 首个命中: rome
  🟢 test framework       P@3: 100.0% | 首位: mocha (51.3%) 首个命中: mocha
  🟡 code quality         P@3:  66.7% | 首位: biome (50.3%) 首个命中: biome
  🟢 ui framework         P@3: 100.0% | 首位: vue (44.7%) 首个命中: vue
  🟢 state management     P@3: 100.0% | 首位: zustand (58.3%) 首个命中: zustand
  🟡 package manager      P@3:  66.7% | 首位: pnpm (57.6%) 首个命中: pnpm
  🟡 javascript runtime   P@3:  33.3% | 首位: rome (55.9%) 首个命中: node
  🟢 database orm         P@3: 100.0% | 首位: kysely (53.0%) 首个命中: kysely
  🔴 bundler              P@3:   0.0% | 首位: node (52.1%) 无命中
  🟡 frontend framework   P@3:  66.7% | 首位: vue (50.7%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "test framework" (100.0%)
  最差查询: "bundler" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# ollama/znbang/bge:small-en-v1.5-q8_0

🚀 开始embedding测试...

[memory-vector-search] {
  ollamaBaseUrl: 'http://192.168.31.10:11434',
  ollamaModelId: 'znbang/bge:small-en-v1.5-q8_0',
  type: 'ollama'
}
📦 添加模拟包数据...
ℹ No proxy configured
document dimension 384
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
ℹ No proxy configured
📊 搜索结果:
  1. yarn (67.9%) ❌
  2. turbo (67.6%) ✅
  3. bun (66.8%) ❌
  4. node (66.6%) ❌
  5. rome (66.5%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
ℹ No proxy configured
📊 搜索结果:
  1. turbo (68.7%) ❌
  2. yarn (67.3%) ❌
  3. standard (66.1%) ❌
  4. swc (65.7%) ❌
  5. ava (65.4%) ✅
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
ℹ No proxy configured
📊 搜索结果:
  1. yarn (65.2%) ❌
  2. bun (64.7%) ❌
  3. standard (63.0%) ✅
  4. node (62.4%) ❌
  5. turbo (62.1%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
ℹ No proxy configured
📊 搜索结果:
  1. rome (66.2%) ❌
  2. ava (64.3%) ❌
  3. turbo (64.1%) ❌
  4. prisma (63.4%) ❌
  5. yarn (63.3%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
ℹ No proxy configured
📊 搜索结果:
  1. yarn (64.9%) ❌
  2. bun (64.6%) ❌
  3. node (63.8%) ❌
  4. pnpm (63.5%) ❌
  5. deno (62.8%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
ℹ No proxy configured
📊 搜索结果:
  1. yarn (68.0%) ✅
  2. pnpm (67.5%) ✅
  3. node (66.1%) ❌
  4. turbo (65.6%) ❌
  5. zustand (64.9%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
ℹ No proxy configured
📊 搜索结果:
  1. turbo (66.6%) ❌
  2. yarn (65.0%) ❌
  3. zustand (64.5%) ❌
  4. drizzle (64.5%) ❌
  5. mocha (63.2%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
ℹ No proxy configured
📊 搜索结果:
  1. yarn (64.5%) ❌
  2. pnpm (63.2%) ❌
  3. bun (63.0%) ❌
  4. ava (62.8%) ❌
  5. node (62.7%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
ℹ No proxy configured
📊 搜索结果:
  1. yarn (71.8%) ❌
  2. bun (68.5%) ❌
  3. mocha (67.3%) ❌
  4. node (66.7%) ❌
  5. turbo (66.4%) ✅
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
ℹ No proxy configured
📊 搜索结果:
  1. turbo (65.9%) ❌
  2. zustand (65.4%) ❌
  3. svelte (65.2%) ✅
  4. swc (65.1%) ❌
  5. drizzle (64.3%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 16.7%
  平均 Precision@5: 16.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 6/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: yarn (67.9%) 首个命中: turbo
  🔴 test framework       P@3:   0.0% | 首位: turbo (68.7%) 首个命中: ava
  🟡 code quality         P@3:  33.3% | 首位: yarn (65.2%) 首个命中: standard
  🔴 ui framework         P@3:   0.0% | 首位: rome (66.2%) 无命中
  🔴 state management     P@3:   0.0% | 首位: yarn (64.9%) 无命中
  🟡 package manager      P@3:  66.7% | 首位: yarn (68.0%) 首个命中: yarn
  🔴 javascript runtime   P@3:   0.0% | 首位: turbo (66.6%) 无命中
  🔴 database orm         P@3:   0.0% | 首位: yarn (64.5%) 无命中
  🔴 bundler              P@3:   0.0% | 首位: yarn (71.8%) 首个命中: turbo
  🟡 frontend framework   P@3:  33.3% | 首位: turbo (65.9%) 首个命中: svelte

🔍 关键洞察:
  最佳查询: "package manager" (66.7%)
  最差查询: "test framework" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# ollama/dengcao/Qwen3-Embedding-0.6B:f16

🚀 开始embedding测试...

[memory-vector-search] {
  ollamaBaseUrl: 'http://192.168.31.10:11434',
  ollamaModelId: 'dengcao/Qwen3-Embedding-0.6B:f16',
  type: 'ollama'
}
📦 添加模拟包数据...
ℹ No proxy configured
document dimension 1024
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
ℹ No proxy configured
📊 搜索结果:
  1. yarn (46.0%) ❌
  2. pnpm (46.0%) ❌
  3. parcel (46.0%) ✅
  4. turbo (42.1%) ✅
  5. mocha (41.9%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
ℹ No proxy configured
📊 搜索结果:
  1. mocha (57.7%) ✅
  2. jasmine (52.4%) ✅
  3. jotai (52.1%) ❌
  4. standard (47.2%) ❌
  5. prisma (46.5%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
ℹ No proxy configured
📊 搜索结果:
  1. standard (40.0%) ✅
  2. mocha (34.4%) ❌
  3. jotai (33.4%) ❌
  4. recoil (32.2%) ❌
  5. parcel (32.1%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
ℹ No proxy configured
📊 搜索结果:
  1. vue (44.8%) ✅
  2. qwik (43.1%) ✅
  3. react (42.7%) ✅
  4. svelte (41.6%) ✅
  5. standard (41.1%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
ℹ No proxy configured
📊 搜索结果:
  1. zustand (62.3%) ✅
  2. recoil (57.4%) ✅
  3. redux (57.1%) ✅
  4. react (43.1%) ❌
  5. vue (40.1%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
ℹ No proxy configured
📊 搜索结果:
  1. pnpm (50.2%) ✅
  2. yarn (45.9%) ✅
  3. node (39.2%) ❌
  4. prisma (38.1%) ❌
  5. recoil (37.5%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
ℹ No proxy configured
📊 搜索结果:
  1. jotai (45.3%) ❌
  2. node (45.3%) ✅
  3. jasmine (45.1%) ❌
  4. mocha (43.8%) ❌
  5. standard (42.2%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
ℹ No proxy configured
📊 搜索结果:
  1. prisma (63.1%) ✅
  2. kysely (58.6%) ✅
  3. drizzle (56.5%) ✅
  4. recoil (37.9%) ❌
  5. pnpm (37.1%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
ℹ No proxy configured
📊 搜索结果:
  1. pnpm (57.2%) ❌
  2. yarn (56.7%) ❌
  3. parcel (47.0%) ✅
  4. node (44.5%) ❌
  5. jotai (42.3%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
ℹ No proxy configured
📊 搜索结果:
  1. vue (48.3%) ✅
  2. svelte (47.0%) ✅
  3. react (45.5%) ❌
  4. qwik (43.9%) ✅
  5. prisma (42.0%) ❌
📈 Precision@3: 66.7% | Precision@5: 60.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 63.3%
  平均 Precision@5: 44.0%
  表现良好查询: 3/10 (≥66.7%)
  完全失败查询: 0/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: yarn (46.0%) 首个命中: parcel
  🟡 test framework       P@3:  66.7% | 首位: mocha (57.7%) 首个命中: mocha
  🟡 code quality         P@3:  33.3% | 首位: standard (40.0%) 首个命中: standard
  🟢 ui framework         P@3: 100.0% | 首位: vue (44.8%) 首个命中: vue
  🟢 state management     P@3: 100.0% | 首位: zustand (62.3%) 首个命中: zustand
  🟡 package manager      P@3:  66.7% | 首位: pnpm (50.2%) 首个命中: pnpm
  🟡 javascript runtime   P@3:  33.3% | 首位: jotai (45.3%) 首个命中: node
  🟢 database orm         P@3: 100.0% | 首位: prisma (63.1%) 首个命中: prisma
  🟡 bundler              P@3:  33.3% | 首位: pnpm (57.2%) 首个命中: parcel
  🟡 frontend framework   P@3:  66.7% | 首位: vue (48.3%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "ui framework" (100.0%)
  最差查询: "build tool" (33.3%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# ollama/dengcao/Qwen3-Embedding-0.6B:Q8_0

🚀 开始embedding测试...

[memory-vector-search] {
  ollamaBaseUrl: 'http://192.168.31.10:11434',
  ollamaModelId: 'dengcao/Qwen3-Embedding-0.6B:Q8_0',
  type: 'ollama'
}
📦 添加模拟包数据...
ℹ No proxy configured
document dimension 1024
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
ℹ No proxy configured
📊 搜索结果:
  1. pnpm (46.0%) ❌
  2. yarn (45.9%) ❌
  3. parcel (45.9%) ✅
  4. turbo (42.4%) ✅
  5. mocha (41.7%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
ℹ No proxy configured
📊 搜索结果:
  1. mocha (57.4%) ✅
  2. jotai (52.4%) ❌
  3. jasmine (52.2%) ✅
  4. standard (47.1%) ❌
  5. prisma (46.3%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
ℹ No proxy configured
📊 搜索结果:
  1. standard (39.9%) ✅
  2. mocha (34.3%) ❌
  3. jotai (33.4%) ❌
  4. parcel (32.1%) ❌
  5. recoil (32.1%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
ℹ No proxy configured
📊 搜索结果:
  1. vue (44.9%) ✅
  2. qwik (43.2%) ✅
  3. react (42.6%) ✅
  4. svelte (41.7%) ✅
  5. standard (40.9%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
ℹ No proxy configured
📊 搜索结果:
  1. zustand (62.1%) ✅
  2. redux (57.1%) ✅
  3. recoil (57.1%) ✅
  4. react (43.0%) ❌
  5. vue (40.1%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
ℹ No proxy configured
📊 搜索结果:
  1. pnpm (49.8%) ✅
  2. yarn (45.6%) ✅
  3. node (39.1%) ❌
  4. prisma (38.0%) ❌
  5. recoil (37.5%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
ℹ No proxy configured
📊 搜索结果:
  1. jotai (45.3%) ❌
  2. node (45.2%) ✅
  3. jasmine (45.1%) ❌
  4. mocha (43.8%) ❌
  5. standard (42.2%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
ℹ No proxy configured
📊 搜索结果:
  1. prisma (63.2%) ✅
  2. kysely (58.8%) ✅
  3. drizzle (56.6%) ✅
  4. recoil (37.8%) ❌
  5. pnpm (37.0%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
ℹ No proxy configured
📊 搜索结果:
  1. pnpm (56.9%) ❌
  2. yarn (56.4%) ❌
  3. parcel (47.1%) ✅
  4. node (44.4%) ❌
  5. jotai (42.3%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
ℹ No proxy configured
📊 搜索结果:
  1. vue (48.2%) ✅
  2. svelte (47.0%) ✅
  3. react (45.4%) ❌
  4. qwik (43.9%) ✅
  5. prisma (41.8%) ❌
📈 Precision@3: 66.7% | Precision@5: 60.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 63.3%
  平均 Precision@5: 44.0%
  表现良好查询: 3/10 (≥66.7%)
  完全失败查询: 0/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: pnpm (46.0%) 首个命中: parcel
  🟡 test framework       P@3:  66.7% | 首位: mocha (57.4%) 首个命中: mocha
  🟡 code quality         P@3:  33.3% | 首位: standard (39.9%) 首个命中: standard
  🟢 ui framework         P@3: 100.0% | 首位: vue (44.9%) 首个命中: vue
  🟢 state management     P@3: 100.0% | 首位: zustand (62.1%) 首个命中: zustand
  🟡 package manager      P@3:  66.7% | 首位: pnpm (49.8%) 首个命中: pnpm
  🟡 javascript runtime   P@3:  33.3% | 首位: jotai (45.3%) 首个命中: node
  🟢 database orm         P@3: 100.0% | 首位: prisma (63.2%) 首个命中: prisma
  🟡 bundler              P@3:  33.3% | 首位: pnpm (56.9%) 首个命中: parcel
  🟡 frontend framework   P@3:  66.7% | 首位: vue (48.2%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "ui framework" (100.0%)
  最差查询: "build tool" (33.3%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# ollama/nomic-embed-text:f16

🚀 开始embedding测试...

[memory-vector-search] {
  ollamaBaseUrl: 'http://192.168.31.10:11434',
  ollamaModelId: 'nomic-embed-text',
  type: 'ollama'
}
📦 添加模拟包数据...
ℹ No proxy configured
document dimension 768
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
ℹ No proxy configured
📊 搜索结果:
  1. qwik (56.2%) ❌
  2. standard (55.1%) ❌
  3. solid (55.0%) ❌
  4. turbo (54.1%) ✅
  5. jotai (54.1%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
ℹ No proxy configured
📊 搜索结果:
  1. react (54.4%) ❌
  2. standard (52.1%) ❌
  3. qwik (51.0%) ❌
  4. zustand (51.0%) ❌
  5. solid (49.9%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
ℹ No proxy configured
📊 搜索结果:
  1. qwik (55.7%) ❌
  2. standard (55.6%) ✅
  3. solid (52.2%) ❌
  4. react (49.1%) ❌
  5. jotai (48.7%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
ℹ No proxy configured
📊 搜索结果:
  1. qwik (57.9%) ✅
  2. vue (57.9%) ✅
  3. zustand (56.7%) ❌
  4. jotai (54.4%) ❌
  5. solid (54.2%) ✅
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
ℹ No proxy configured
📊 搜索结果:
  1. standard (58.4%) ❌
  2. ava (57.4%) ❌
  3. kysely (57.0%) ❌
  4. tap (55.6%) ❌
  5. biome (55.6%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
ℹ No proxy configured
📊 搜索结果:
  1. parcel (64.9%) ❌
  2. standard (62.6%) ❌
  3. react (62.4%) ❌
  4. kysely (61.1%) ❌
  5. vue (60.8%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
ℹ No proxy configured
📊 搜索结果:
  1. jotai (57.0%) ❌
  2. react (55.6%) ❌
  3. standard (54.2%) ❌
  4. qwik (53.3%) ❌
  5. recoil (52.6%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
ℹ No proxy configured
📊 搜索结果:
  1. solid (58.3%) ❌
  2. standard (58.2%) ❌
  3. biome (56.9%) ❌
  4. jasmine (56.7%) ❌
  5. ava (56.4%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
ℹ No proxy configured
📊 搜索结果:
  1. kysely (56.1%) ❌
  2. parcel (56.0%) ✅
  3. standard (56.0%) ❌
  4. swc (55.7%) ✅
  5. qwik (55.7%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
ℹ No proxy configured
📊 搜索结果:
  1. zustand (57.3%) ❌
  2. standard (55.1%) ❌
  3. vue (55.0%) ✅
  4. solid (54.7%) ✅
  5. react (54.4%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 16.7%
  平均 Precision@5: 18.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 6/10 (0%)

📋 详细结果:
  🔴 build tool           P@3:   0.0% | 首位: qwik (56.2%) 首个命中: turbo
  🔴 test framework       P@3:   0.0% | 首位: react (54.4%) 无命中
  🟡 code quality         P@3:  33.3% | 首位: qwik (55.7%) 首个命中: standard
  🟡 ui framework         P@3:  66.7% | 首位: qwik (57.9%) 首个命中: qwik
  🔴 state management     P@3:   0.0% | 首位: standard (58.4%) 无命中
  🔴 package manager      P@3:   0.0% | 首位: parcel (64.9%) 无命中
  🔴 javascript runtime   P@3:   0.0% | 首位: jotai (57.0%) 无命中
  🔴 database orm         P@3:   0.0% | 首位: solid (58.3%) 无命中
  🟡 bundler              P@3:  33.3% | 首位: kysely (56.1%) 首个命中: parcel
  🟡 frontend framework   P@3:  33.3% | 首位: zustand (57.3%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "ui framework" (66.7%)
  最差查询: "build tool" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# ollama/bge-m3:f16

🚀 开始embedding测试...

[memory-vector-search] {
  ollamaBaseUrl: 'http://192.168.31.10:11434',
  ollamaModelId: 'bge-m3:latest',
  type: 'ollama'
}
📦 添加模拟包数据...
ℹ No proxy configured
document dimension 1024
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
ℹ No proxy configured
📊 搜索结果:
  1. kysely (56.1%) ❌
  2. turbo (55.5%) ✅
  3. recoil (55.0%) ❌
  4. solid (53.6%) ❌
  5. tap (52.6%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
ℹ No proxy configured
📊 搜索结果:
  1. standard (55.3%) ❌
  2. kysely (55.3%) ❌
  3. turbo (54.4%) ❌
  4. react (54.3%) ❌
  5. parcel (53.2%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
ℹ No proxy configured
📊 搜索结果:
  1. standard (52.2%) ✅
  2. solid (50.8%) ❌
  3. kysely (50.0%) ❌
  4. biome (48.4%) ✅
  5. zustand (48.4%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
ℹ No proxy configured
📊 搜索结果:
  1. vue (56.7%) ✅
  2. kysely (51.4%) ❌
  3. standard (50.7%) ❌
  4. turbo (50.3%) ❌
  5. parcel (50.2%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
ℹ No proxy configured
📊 搜索结果:
  1. zustand (56.2%) ✅
  2. kysely (48.7%) ❌
  3. standard (48.3%) ❌
  4. solid (48.0%) ❌
  5. redux (45.8%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
ℹ No proxy configured
📊 搜索结果:
  1. parcel (54.4%) ❌
  2. kysely (53.3%) ❌
  3. pnpm (52.1%) ✅
  4. standard (51.8%) ❌
  5. prisma (51.4%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
ℹ No proxy configured
📊 搜索结果:
  1. kysely (53.3%) ❌
  2. jotai (53.0%) ❌
  3. zustand (51.5%) ❌
  4. recoil (49.5%) ❌
  5. turbo (49.3%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
ℹ No proxy configured
📊 搜索结果:
  1. biome (53.0%) ❌
  2. prisma (49.7%) ✅
  3. rome (48.0%) ❌
  4. kysely (47.9%) ✅
  5. drizzle (47.6%) ✅
📈 Precision@3: 33.3% | Precision@5: 60.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
ℹ No proxy configured
📊 搜索结果:
  1. solid (51.7%) ❌
  2. drizzle (50.9%) ❌
  3. turbo (50.2%) ✅
  4. vue (50.0%) ❌
  5. standard (49.9%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
ℹ No proxy configured
📊 搜索结果:
  1. vue (56.0%) ✅
  2. kysely (55.1%) ❌
  3. react (54.2%) ❌
  4. parcel (54.2%) ❌
  5. standard (54.2%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 26.7%
  平均 Precision@5: 24.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 2/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: kysely (56.1%) 首个命中: turbo
  🔴 test framework       P@3:   0.0% | 首位: standard (55.3%) 无命中
  🟡 code quality         P@3:  33.3% | 首位: standard (52.2%) 首个命中: standard
  🟡 ui framework         P@3:  33.3% | 首位: vue (56.7%) 首个命中: vue
  🟡 state management     P@3:  33.3% | 首位: zustand (56.2%) 首个命中: zustand
  🟡 package manager      P@3:  33.3% | 首位: parcel (54.4%) 首个命中: pnpm
  🔴 javascript runtime   P@3:   0.0% | 首位: kysely (53.3%) 无命中
  🟡 database orm         P@3:  33.3% | 首位: biome (53.0%) 首个命中: prisma
  🟡 bundler              P@3:  33.3% | 首位: solid (51.7%) 首个命中: turbo
  🟡 frontend framework   P@3:  33.3% | 首位: vue (56.0%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "build tool" (33.3%)
  最差查询: "test framework" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# ollama/dengcao/Dmeta-embedding-zh:F16

 开始embedding测试...

[memory-vector-search] {
  ollamaBaseUrl: 'http://192.168.31.10:11434',
  ollamaModelId: 'dengcao/Dmeta-embedding-zh:F16',
  type: 'ollama'
}
📦 添加模拟包数据...
ℹ No proxy configured
document dimension 768
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
ℹ No proxy configured
📊 搜索结果:
  1. solid (46.5%) ❌
  2. zustand (45.1%) ❌
  3. drizzle (44.9%) ❌
  4. react (43.0%) ❌
  5. standard (42.9%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
ℹ No proxy configured
📊 搜索结果:
  1. react (46.9%) ❌
  2. vue (46.4%) ❌
  3. standard (46.1%) ❌
  4. svelte (45.3%) ❌
  5. qwik (44.5%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
ℹ No proxy configured
📊 搜索结果:
  1. standard (51.6%) ✅
  2. qwik (45.6%) ❌
  3. vue (43.2%) ❌
  4. solid (42.9%) ❌
  5. biome (42.8%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
ℹ No proxy configured
📊 搜索结果:
  1. drizzle (49.4%) ❌
  2. react (49.3%) ✅
  3. prisma (49.2%) ❌
  4. vue (49.1%) ✅
  5. solid (48.9%) ✅
📈 Precision@3: 33.3% | Precision@5: 60.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
ℹ No proxy configured
📊 搜索结果:
  1. yarn (52.0%) ❌
  2. deno (49.3%) ❌
  3. pnpm (48.6%) ❌
  4. node (48.5%) ❌
  5. bun (48.0%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
ℹ No proxy configured
📊 搜索结果:
  1. pnpm (53.4%) ✅
  2. yarn (52.1%) ✅
  3. tap (50.4%) ❌
  4. node (49.3%) ❌
  5. deno (48.3%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
ℹ No proxy configured
📊 搜索结果:
  1. react (50.6%) ❌
  2. redux (47.4%) ❌
  3. vue (47.3%) ❌
  4. jasmine (47.0%) ❌
  5. turbo (45.8%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
ℹ No proxy configured
📊 搜索结果:
  1. yarn (50.4%) ❌
  2. biome (45.6%) ❌
  3. deno (45.2%) ❌
  4. bun (45.2%) ❌
  5. node (43.9%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
ℹ No proxy configured
📊 搜索结果:
  1. bun (51.8%) ❌
  2. yarn (47.4%) ❌
  3. drizzle (46.6%) ❌
  4. deno (45.9%) ❌
  5. pnpm (43.6%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
ℹ No proxy configured
📊 搜索结果:
  1. react (53.8%) ❌
  2. solid (53.0%) ✅
  3. vue (52.7%) ✅
  4. prisma (50.8%) ❌
  5. svelte (50.5%) ✅
📈 Precision@3: 66.7% | Precision@5: 60.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 20.0%
  平均 Precision@5: 20.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 6/10 (0%)

📋 详细结果:
  🔴 build tool           P@3:   0.0% | 首位: solid (46.5%) 无命中
  🔴 test framework       P@3:   0.0% | 首位: react (46.9%) 无命中
  🟡 code quality         P@3:  33.3% | 首位: standard (51.6%) 首个命中: standard
  🟡 ui framework         P@3:  33.3% | 首位: drizzle (49.4%) 首个命中: react
  🔴 state management     P@3:   0.0% | 首位: yarn (52.0%) 无命中
  🟡 package manager      P@3:  66.7% | 首位: pnpm (53.4%) 首个命中: pnpm
  🔴 javascript runtime   P@3:   0.0% | 首位: react (50.6%) 无命中
  🔴 database orm         P@3:   0.0% | 首位: yarn (50.4%) 无命中
  🔴 bundler              P@3:   0.0% | 首位: bun (51.8%) 无命中
  🟡 frontend framework   P@3:  66.7% | 首位: react (53.8%) 首个命中: solid

🔍 关键洞察:
  最佳查询: "package manager" (66.7%)
  最差查询: "build tool" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# ollama/granite-embedding:278m-fp16

🚀 开始embedding测试...

[memory-vector-search] {
  ollamaBaseUrl: 'http://192.168.31.10:11434',
  ollamaModelId: 'granite-embedding:278m-fp16',
  type: 'ollama'
}
📦 添加模拟包数据...
ℹ No proxy configured
document dimension 768
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
ℹ No proxy configured
📊 搜索结果:
  1. kysely (59.7%) ❌
  2. recoil (59.6%) ❌
  3. bun (59.2%) ❌
  4. mocha (58.8%) ❌
  5. deno (58.2%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
ℹ No proxy configured
📊 搜索结果:
  1. kysely (64.6%) ❌
  2. mocha (62.5%) ✅
  3. recoil (58.2%) ❌
  4. svelte (58.1%) ❌
  5. standard (58.1%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
ℹ No proxy configured
📊 搜索结果:
  1. kysely (58.1%) ❌
  2. standard (56.0%) ✅
  3. recoil (56.0%) ❌
  4. mocha (55.1%) ❌
  5. zustand (54.6%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
ℹ No proxy configured
📊 搜索结果:
  1. vue (61.3%) ✅
  2. kysely (60.3%) ❌
  3. qwik (59.2%) ✅
  4. rome (58.3%) ❌
  5. recoil (58.0%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
ℹ No proxy configured
📊 搜索结果:
  1. zustand (64.5%) ✅
  2. kysely (58.8%) ❌
  3. tap (58.3%) ❌
  4. recoil (58.1%) ✅
  5. react (58.0%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
ℹ No proxy configured
📊 搜索结果:
  1. parcel (63.4%) ❌
  2. recoil (63.1%) ❌
  3. prisma (62.3%) ❌
  4. kysely (62.2%) ❌
  5. tap (62.0%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
ℹ No proxy configured
📊 搜索结果:
  1. kysely (57.3%) ❌
  2. jasmine (56.4%) ❌
  3. mocha (55.0%) ❌
  4. recoil (54.9%) ❌
  5. vue (54.5%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
ℹ No proxy configured
📊 搜索结果:
  1. biome (59.1%) ❌
  2. rome (59.1%) ❌
  3. kysely (58.8%) ✅
  4. recoil (56.8%) ❌
  5. prisma (56.4%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
ℹ No proxy configured
📊 搜索结果:
  1. recoil (65.6%) ❌
  2. bun (64.9%) ❌
  3. kysely (64.4%) ❌
  4. svelte (64.2%) ❌
  5. drizzle (64.1%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
ℹ No proxy configured
📊 搜索结果:
  1. kysely (63.0%) ❌
  2. vue (61.6%) ✅
  3. prisma (61.4%) ❌
  4. standard (61.2%) ❌
  5. recoil (60.5%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 23.3%
  平均 Precision@5: 18.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 4/10 (0%)

📋 详细结果:
  🔴 build tool           P@3:   0.0% | 首位: kysely (59.7%) 无命中
  🟡 test framework       P@3:  33.3% | 首位: kysely (64.6%) 首个命中: mocha
  🟡 code quality         P@3:  33.3% | 首位: kysely (58.1%) 首个命中: standard
  🟡 ui framework         P@3:  66.7% | 首位: vue (61.3%) 首个命中: vue
  🟡 state management     P@3:  33.3% | 首位: zustand (64.5%) 首个命中: zustand
  🔴 package manager      P@3:   0.0% | 首位: parcel (63.4%) 无命中
  🔴 javascript runtime   P@3:   0.0% | 首位: kysely (57.3%) 无命中
  🟡 database orm         P@3:  33.3% | 首位: biome (59.1%) 首个命中: kysely
  🔴 bundler              P@3:   0.0% | 首位: recoil (65.6%) 无命中
  🟡 frontend framework   P@3:  33.3% | 首位: kysely (63.0%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "ui framework" (66.7%)
  最差查询: "build tool" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# ollama/snowflake-arctic-embed2:568m:f16

🚀 开始embedding测试...

[memory-vector-search] {
  ollamaBaseUrl: 'http://192.168.31.10:11434',
  ollamaModelId: 'snowflake-arctic-embed2:568m',
  type: 'ollama'
}
📦 添加模拟包数据...
ℹ No proxy configured
document dimension 1024
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
ℹ No proxy configured
📊 搜索结果:
  1. turbo (43.8%) ✅
  2. recoil (41.2%) ❌
  3. solid (40.6%) ❌
  4. biome (40.4%) ❌
  5. vue (39.3%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
ℹ No proxy configured
📊 搜索结果:
  1. standard (42.3%) ❌
  2. turbo (40.3%) ❌
  3. vue (39.4%) ❌
  4. kysely (38.2%) ❌
  5. qwik (37.8%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
ℹ No proxy configured
📊 搜索结果:
  1. qwik (43.2%) ❌
  2. standard (41.8%) ✅
  3. zustand (40.6%) ❌
  4. solid (39.9%) ❌
  5. swc (37.7%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
ℹ No proxy configured
📊 搜索结果:
  1. vue (49.7%) ✅
  2. jotai (42.6%) ❌
  3. swc (41.1%) ❌
  4. react (41.0%) ✅
  5. standard (40.8%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
ℹ No proxy configured
📊 搜索结果:
  1. zustand (47.6%) ✅
  2. qwik (36.1%) ❌
  3. swc (35.5%) ❌
  4. solid (35.2%) ❌
  5. ava (33.8%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
ℹ No proxy configured
📊 搜索结果:
  1. qwik (42.3%) ❌
  2. standard (41.6%) ❌
  3. vue (40.8%) ❌
  4. swc (40.7%) ❌
  5. turbo (40.5%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
ℹ No proxy configured
📊 搜索结果:
  1. jotai (45.0%) ❌
  2. jasmine (44.0%) ❌
  3. swc (43.0%) ❌
  4. qwik (42.8%) ❌
  5. vue (42.6%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
ℹ No proxy configured
📊 搜索结果:
  1. biome (41.5%) ❌
  2. qwik (38.8%) ❌
  3. vue (38.1%) ❌
  4. jasmine (37.6%) ❌
  5. drizzle (37.5%) ✅
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
ℹ No proxy configured
📊 搜索结果:
  1. drizzle (40.7%) ❌
  2. qwik (39.4%) ❌
  3. svelte (39.2%) ❌
  4. ava (38.9%) ❌
  5. swc (38.7%) ✅
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
ℹ No proxy configured
📊 搜索结果:
  1. vue (46.9%) ✅
  2. standard (46.0%) ❌
  3. react (44.5%) ❌
  4. qwik (42.6%) ✅
  5. swc (42.5%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 16.7%
  平均 Precision@5: 18.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 5/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: turbo (43.8%) 首个命中: turbo
  🔴 test framework       P@3:   0.0% | 首位: standard (42.3%) 无命中
  🟡 code quality         P@3:  33.3% | 首位: qwik (43.2%) 首个命中: standard
  🟡 ui framework         P@3:  33.3% | 首位: vue (49.7%) 首个命中: vue
  🟡 state management     P@3:  33.3% | 首位: zustand (47.6%) 首个命中: zustand
  🔴 package manager      P@3:   0.0% | 首位: qwik (42.3%) 无命中
  🔴 javascript runtime   P@3:   0.0% | 首位: jotai (45.0%) 无命中
  🔴 database orm         P@3:   0.0% | 首位: biome (41.5%) 首个命中: drizzle
  🔴 bundler              P@3:   0.0% | 首位: drizzle (40.7%) 首个命中: swc
  🟡 frontend framework   P@3:  33.3% | 首位: vue (46.9%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "build tool" (33.3%)
  最差查询: "test framework" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# ollama/unclemusclez/jina-embeddings-v2-base-code:f16

╭─   ~/workspace/autodev-codebase on   master !4 ?3       took  2m 59s  base
╰─❯ npx tsx src/examples/embedding-test-simple.ts
🚀 开始embedding测试...

[memory-vector-search] {
  ollamaBaseUrl: 'http://192.168.31.10:11434',
  ollamaModelId: 'unclemusclez/jina-embeddings-v2-base-code:latest',
  type: 'ollama'
}
📦 添加模拟包数据...
ℹ No proxy configured
document dimension 768
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
ℹ No proxy configured
📊 搜索结果:
  1. drizzle (46.0%) ❌
  2. qwik (40.4%) ❌
  3. rome (40.1%) ✅
  4. jotai (39.9%) ❌
  5. ava (39.1%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
ℹ No proxy configured
📊 搜索结果:
  1. jasmine (46.3%) ✅
  2. qwik (41.6%) ❌
  3. mocha (40.3%) ✅
  4. drizzle (40.1%) ❌
  5. jotai (37.9%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
ℹ No proxy configured
📊 搜索结果:
  1. drizzle (36.8%) ❌
  2. qwik (32.2%) ❌
  3. ava (29.4%) ❌
  4. kysely (28.5%) ❌
  5. jotai (27.3%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
ℹ No proxy configured
📊 搜索结果:
  1. qwik (28.3%) ✅
  2. jotai (27.0%) ❌
  3. kysely (24.8%) ❌
  4. ava (21.4%) ❌
  5. rome (21.0%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
ℹ No proxy configured
📊 搜索结果:
  1. qwik (21.3%) ❌
  2. drizzle (20.7%) ❌
  3. ava (17.9%) ❌
  4. jotai (17.0%) ✅
  5. tap (16.4%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
ℹ No proxy configured
📊 搜索结果:
  1. qwik (43.6%) ❌
  2. drizzle (43.4%) ❌
  3. kysely (43.0%) ❌
  4. ava (42.5%) ❌
  5. jotai (41.1%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
ℹ No proxy configured
📊 搜索结果:
  1. drizzle (34.9%) ❌
  2. qwik (33.8%) ❌
  3. jotai (32.4%) ❌
  4. turbo (32.1%) ❌
  5. svelte (31.9%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
ℹ No proxy configured
📊 搜索结果:
  1. prisma (34.9%) ✅
  2. qwik (28.6%) ❌
  3. drizzle (27.8%) ✅
  4. jotai (25.6%) ❌
  5. turbo (21.8%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
ℹ No proxy configured
📊 搜索结果:
  1. drizzle (49.4%) ❌
  2. ava (46.9%) ❌
  3. biome (46.6%) ❌
  4. bun (45.5%) ❌
  5. jotai (45.3%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
ℹ No proxy configured
📊 搜索结果:
  1. qwik (30.9%) ✅
  2. jotai (27.7%) ❌
  3. kysely (26.1%) ❌
  4. turbo (24.3%) ❌
  5. swc (24.2%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 23.3%
  平均 Precision@5: 16.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 5/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: drizzle (46.0%) 首个命中: rome
  🟡 test framework       P@3:  66.7% | 首位: jasmine (46.3%) 首个命中: jasmine
  🔴 code quality         P@3:   0.0% | 首位: drizzle (36.8%) 无命中
  🟡 ui framework         P@3:  33.3% | 首位: qwik (28.3%) 首个命中: qwik
  🔴 state management     P@3:   0.0% | 首位: qwik (21.3%) 首个命中: jotai
  🔴 package manager      P@3:   0.0% | 首位: qwik (43.6%) 无命中
  🔴 javascript runtime   P@3:   0.0% | 首位: drizzle (34.9%) 无命中
  🟡 database orm         P@3:  66.7% | 首位: prisma (34.9%) 首个命中: prisma
  🔴 bundler              P@3:   0.0% | 首位: drizzle (49.4%) 无命中
  🟡 frontend framework   P@3:  33.3% | 首位: qwik (30.9%) 首个命中: qwik

🔍 关键洞察:
  最佳查询: "test framework" (66.7%)
  最差查询: "code quality" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# ollama/dengcao/Qwen3-Embedding-8B:Q4_K_M

🚀 开始embedding测试...

[memory-vector-search] {
  ollamaBaseUrl: 'http://192.168.31.10:11434',
  ollamaModelId: 'dengcao/Qwen3-Embedding-8B:Q4_K_M',
  type: 'ollama'
}
📦 添加模拟包数据...
ℹ No proxy configured
document dimension 4096
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
ℹ No proxy configured
📊 搜索结果:
  1. node (51.7%) ❌
  2. yarn (46.2%) ❌
  3. pnpm (41.4%) ❌
  4. rome (37.0%) ✅
  5. svelte (36.2%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
ℹ No proxy configured
📊 搜索结果:
  1. node (44.8%) ❌
  2. jasmine (43.0%) ✅
  3. ava (41.6%) ✅
  4. mocha (41.3%) ✅
  5. rome (38.5%) ❌
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
ℹ No proxy configured
📊 搜索结果:
  1. rome (40.0%) ❌
  2. node (37.4%) ❌
  3. biome (37.3%) ✅
  4. yarn (33.5%) ❌
  5. ava (33.3%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
ℹ No proxy configured
📊 搜索结果:
  1. svelte (39.5%) ✅
  2. redux (39.3%) ❌
  3. vue (38.7%) ✅
  4. rome (35.3%) ❌
  5. react (34.8%) ✅
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
ℹ No proxy configured
📊 搜索结果:
  1. redux (53.3%) ✅
  2. zustand (51.3%) ✅
  3. recoil (47.3%) ✅
  4. jotai (44.4%) ✅
  5. svelte (38.5%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
ℹ No proxy configured
📊 搜索结果:
  1. pnpm (58.7%) ✅
  2. yarn (53.8%) ✅
  3. node (44.2%) ❌
  4. rome (43.3%) ❌
  5. deno (39.7%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
ℹ No proxy configured
📊 搜索结果:
  1. rome (42.1%) ❌
  2. node (41.4%) ✅
  3. deno (38.3%) ✅
  4. jasmine (37.4%) ❌
  5. svelte (37.2%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
ℹ No proxy configured
📊 搜索结果:
  1. drizzle (42.0%) ✅
  2. kysely (41.7%) ✅
  3. prisma (40.7%) ✅
  4. redux (33.9%) ❌
  5. rome (33.9%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
ℹ No proxy configured
📊 搜索结果:
  1. yarn (47.2%) ❌
  2. pnpm (42.3%) ❌
  3. node (40.6%) ❌
  4. bun (39.9%) ❌
  5. rome (38.9%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
ℹ No proxy configured
📊 搜索结果:
  1. vue (41.9%) ✅
  2. redux (41.6%) ❌
  3. svelte (40.8%) ✅
  4. node (39.1%) ❌
  5. rome (38.4%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 56.7%
  平均 Precision@5: 42.0%
  表现良好查询: 2/10 (≥66.7%)
  完全失败查询: 2/10 (0%)

📋 详细结果:
  🔴 build tool           P@3:   0.0% | 首位: node (51.7%) 首个命中: rome
  🟡 test framework       P@3:  66.7% | 首位: node (44.8%) 首个命中: jasmine
  🟡 code quality         P@3:  33.3% | 首位: rome (40.0%) 首个命中: biome
  🟡 ui framework         P@3:  66.7% | 首位: svelte (39.5%) 首个命中: svelte
  🟢 state management     P@3: 100.0% | 首位: redux (53.3%) 首个命中: redux
  🟡 package manager      P@3:  66.7% | 首位: pnpm (58.7%) 首个命中: pnpm
  🟡 javascript runtime   P@3:  66.7% | 首位: rome (42.1%) 首个命中: node
  🟢 database orm         P@3: 100.0% | 首位: drizzle (42.0%) 首个命中: drizzle
  🔴 bundler              P@3:   0.0% | 首位: yarn (47.2%) 无命中
  🟡 frontend framework   P@3:  66.7% | 首位: vue (41.9%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "state management" (100.0%)
  最差查询: "build tool" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# ollama/dengcao/Qwen3-Embedding-4B:Q8_0

🚀 开始embedding测试...

[memory-vector-search] {
  ollamaBaseUrl: 'http://192.168.31.10:11434',
  ollamaModelId: 'dengcao/Qwen3-Embedding-4B:Q8_0',
  type: 'ollama'
}
📦 添加模拟包数据...
ℹ No proxy configured
document dimension 2560
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
ℹ No proxy configured
📊 搜索结果:
  1. biome (54.7%) ❌
  2. yarn (53.4%) ❌
  3. rome (52.3%) ✅
  4. node (51.4%) ❌
  5. parcel (49.9%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
ℹ No proxy configured
📊 搜索结果:
  1. mocha (51.7%) ✅
  2. ava (50.3%) ✅
  3. jasmine (48.1%) ✅
  4. biome (48.0%) ❌
  5. rome (46.8%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
ℹ No proxy configured
📊 搜索结果:
  1. biome (50.4%) ✅
  2. rome (43.1%) ❌
  3. qwik (40.3%) ❌
  4. standard (40.3%) ✅
  5. node (39.6%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
ℹ No proxy configured
📊 搜索结果:
  1. vue (45.9%) ✅
  2. svelte (44.5%) ✅
  3. biome (43.2%) ❌
  4. react (42.7%) ✅
  5. rome (42.6%) ❌
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
ℹ No proxy configured
📊 搜索结果:
  1. zustand (59.3%) ✅
  2. redux (57.9%) ✅
  3. recoil (57.3%) ✅
  4. jotai (48.7%) ✅
  5. biome (46.4%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
ℹ No proxy configured
📊 搜索结果:
  1. pnpm (59.0%) ✅
  2. yarn (57.4%) ✅
  3. node (52.1%) ❌
  4. biome (51.9%) ❌
  5. rome (51.3%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
ℹ No proxy configured
📊 搜索结果:
  1. rome (55.5%) ❌
  2. node (52.8%) ✅
  3. biome (50.4%) ❌
  4. react (48.6%) ❌
  5. svelte (47.5%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
ℹ No proxy configured
📊 搜索结果:
  1. kysely (52.1%) ✅
  2. prisma (48.5%) ✅
  3. drizzle (45.7%) ✅
  4. biome (40.0%) ❌
  5. rome (38.3%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
ℹ No proxy configured
📊 搜索结果:
  1. node (51.2%) ❌
  2. yarn (50.0%) ❌
  3. biome (48.5%) ❌
  4. standard (46.3%) ❌
  5. pnpm (45.4%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
ℹ No proxy configured
📊 搜索结果:
  1. vue (51.3%) ✅
  2. svelte (50.4%) ✅
  3. react (47.5%) ❌
  4. solid (44.7%) ✅
  5. qwik (44.5%) ✅
📈 Precision@3: 66.7% | Precision@5: 80.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 60.0%
  平均 Precision@5: 48.0%
  表现良好查询: 3/10 (≥66.7%)
  完全失败查询: 1/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: biome (54.7%) 首个命中: rome
  🟢 test framework       P@3: 100.0% | 首位: mocha (51.7%) 首个命中: mocha
  🟡 code quality         P@3:  33.3% | 首位: biome (50.4%) 首个命中: biome
  🟡 ui framework         P@3:  66.7% | 首位: vue (45.9%) 首个命中: vue
  🟢 state management     P@3: 100.0% | 首位: zustand (59.3%) 首个命中: zustand
  🟡 package manager      P@3:  66.7% | 首位: pnpm (59.0%) 首个命中: pnpm
  🟡 javascript runtime   P@3:  33.3% | 首位: rome (55.5%) 首个命中: node
  🟢 database orm         P@3: 100.0% | 首位: kysely (52.1%) 首个命中: kysely
  🔴 bundler              P@3:   0.0% | 首位: node (51.2%) 无命中
  🟡 frontend framework   P@3:  66.7% | 首位: vue (51.3%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "test framework" (100.0%)
  最差查询: "bundler" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# lmstudio/taylor-jones/bge-code-v1-Q8_0-GGUF

🚀 开始embedding测试...

[memory-vector-search] {
  openaiApiKey: 'sk-USqYzFUmccukXK0jC392D995Aa4b4a2d9c49892c37E323B7',
  openaiBaseUrl: 'http://192.168.31.10:5000/v1',
  ollamaModelId: 'text-embedding-bge-code-v1',
  type: 'openai'
}
📦 添加模拟包数据...
document dimension 1536
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📊 搜索结果:
  1. rome (64.0%) ✅
  2. swc (63.8%) ✅
  3. parcel (63.3%) ✅
  4. ava (62.5%) ❌
  5. turbo (62.2%) ✅
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📊 搜索结果:
  1. mocha (65.7%) ✅
  2. ava (63.3%) ✅
  3. jasmine (62.5%) ✅
  4. tap (61.6%) ✅
  5. biome (58.3%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📊 搜索结果:
  1. standard (61.5%) ✅
  2. ava (60.9%) ❌
  3. mocha (60.8%) ❌
  4. biome (60.4%) ✅
  5. solid (59.3%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📊 搜索结果:
  1. recoil (58.6%) ❌
  2. vue (58.1%) ✅
  3. mocha (58.0%) ❌
  4. solid (56.8%) ✅
  5. react (56.6%) ✅
📈 Precision@3: 33.3% | Precision@5: 60.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📊 搜索结果:
  1. zustand (65.9%) ✅
  2. recoil (64.7%) ✅
  3. jotai (64.1%) ✅
  4. redux (63.5%) ✅
  5. solid (58.9%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📊 搜索结果:
  1. pnpm (64.5%) ✅
  2. parcel (62.8%) ❌
  3. mocha (61.3%) ❌
  4. bun (60.3%) ✅
  5. standard (60.1%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📊 搜索结果:
  1. jasmine (64.5%) ❌
  2. svelte (62.6%) ❌
  3. mocha (62.3%) ❌
  4. node (61.5%) ✅
  5. swc (61.2%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📊 搜索结果:
  1. kysely (62.5%) ✅
  2. prisma (60.3%) ✅
  3. drizzle (59.0%) ✅
  4. vue (54.1%) ❌
  5. biome (53.8%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📊 搜索结果:
  1. bun (68.7%) ❌
  2. parcel (64.0%) ✅
  3. mocha (63.1%) ❌
  4. yarn (63.0%) ❌
  5. standard (62.5%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📊 搜索结果:
  1. vue (63.9%) ✅
  2. svelte (63.4%) ✅
  3. react (62.7%) ❌
  4. parcel (62.1%) ❌
  5. solid (61.7%) ✅
📈 Precision@3: 66.7% | Precision@5: 60.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 60.0%
  平均 Precision@5: 54.0%
  表现良好查询: 4/10 (≥66.7%)
  完全失败查询: 1/10 (0%)

📋 详细结果:
  🟢 build tool           P@3: 100.0% | 首位: rome (64.0%) 首个命中: rome
  🟢 test framework       P@3: 100.0% | 首位: mocha (65.7%) 首个命中: mocha
  🟡 code quality         P@3:  33.3% | 首位: standard (61.5%) 首个命中: standard
  🟡 ui framework         P@3:  33.3% | 首位: recoil (58.6%) 首个命中: vue
  🟢 state management     P@3: 100.0% | 首位: zustand (65.9%) 首个命中: zustand
  🟡 package manager      P@3:  33.3% | 首位: pnpm (64.5%) 首个命中: pnpm
  🔴 javascript runtime   P@3:   0.0% | 首位: jasmine (64.5%) 首个命中: node
  🟢 database orm         P@3: 100.0% | 首位: kysely (62.5%) 首个命中: kysely
  🟡 bundler              P@3:  33.3% | 首位: bun (68.7%) 首个命中: parcel
  🟡 frontend framework   P@3:  66.7% | 首位: vue (63.9%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "build tool" (100.0%)
  最差查询: "javascript runtime" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

# lmstudio/nomic-ai/nomic-embed-text-v1.5-GGUF@Q4_K_M

🚀 开始embedding测试...

[memory-vector-search] {
  openaiBaseUrl: 'http://192.168.31.10:5000/v1',
  openaiApiKey: 'sk-USqYzFUmccukXK0jC392D995Aa4b4a2d9c49892c37E323B7',
  openaiModel: 'nomic-ai/nomic-embed-text-v1.5-GGUF@Q4_K_M',
  type: 'openai'
}
ℹ No proxy configured for OpenAI Compatible
📝 调试: OpenAI客户端不使用代理 (undici)
📦 添加模拟包数据...
📝 开始批量添加文档，数量: 27
📝 将分成 3 个批次处理，每批最多 10 个文档
📝 处理批次 1/3: 10 个文档
📝 内容示例: [ 'node_modules/parcel', 'node_modules/turbo', 'node_modules/rome' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 10
📝 批次 1 添加成功
📝 处理批次 2/3: 10 个文档
📝 内容示例: [ 'node_modules/vue', 'node_modules/react', 'node_modules/svelte' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 10
📝 批次 2 添加成功
📝 处理批次 3/3: 7 个文档
📝 内容示例: [ '/usr/local/bin/yarn', '/usr/local/bin/bun', '/usr/local/bin/deno' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 7
📝 批次 3 添加成功
📝 所有文档添加成功
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📝 开始搜索，查询: build tool
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. qwik (58.2%) ❌
  2. standard (57.3%) ❌
  3. kysely (56.9%) ❌
  4. solid (56.7%) ❌
  5. tap (56.0%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📝 开始搜索，查询: test framework
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. react (55.5%) ❌
  2. standard (55.5%) ❌
  3. qwik (53.3%) ❌
  4. zustand (52.7%) ❌
  5. ava (52.4%) ✅
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📝 开始搜索，查询: code quality
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. standard (58.4%) ✅
  2. qwik (56.6%) ❌
  3. solid (53.8%) ❌
  4. kysely (52.1%) ❌
  5. zustand (50.7%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📝 开始搜索，查询: ui framework
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. vue (60.7%) ✅
  2. qwik (60.5%) ✅
  3. zustand (58.6%) ❌
  4. jasmine (58.0%) ❌
  5. ava (57.3%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📝 开始搜索，查询: state management
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. standard (60.0%) ❌
  2. ava (58.8%) ❌
  3. kysely (58.6%) ❌
  4. biome (57.0%) ❌
  5. jasmine (56.7%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📝 开始搜索，查询: package manager
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. parcel (65.8%) ❌
  2. standard (63.9%) ❌
  3. react (62.6%) ❌
  4. kysely (62.3%) ❌
  5. jasmine (61.9%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📝 开始搜索，查询: javascript runtime
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. jotai (59.5%) ❌
  2. standard (57.8%) ❌
  3. react (57.1%) ❌
  4. kysely (55.7%) ❌
  5. qwik (55.6%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📝 开始搜索，查询: database orm
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. standard (60.8%) ❌
  2. jasmine (60.1%) ❌
  3. ava (59.3%) ❌
  4. solid (59.2%) ❌
  5. biome (58.8%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📝 开始搜索，查询: bundler
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. kysely (57.3%) ❌
  2. parcel (57.0%) ✅
  3. standard (56.3%) ❌
  4. vue (56.0%) ❌
  5. qwik (56.0%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📝 开始搜索，查询: frontend framework
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. zustand (58.8%) ❌
  2. standard (58.2%) ❌
  3. vue (57.0%) ✅
  4. solid (56.1%) ✅
  5. react (55.8%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 16.7%
  平均 Precision@5: 14.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 6/10 (0%)

📋 详细结果:
  🔴 build tool           P@3:   0.0% | 首位: qwik (58.2%) 无命中
  🔴 test framework       P@3:   0.0% | 首位: react (55.5%) 首个命中: ava
  🟡 code quality         P@3:  33.3% | 首位: standard (58.4%) 首个命中: standard
  🟡 ui framework         P@3:  66.7% | 首位: vue (60.7%) 首个命中: vue
  🔴 state management     P@3:   0.0% | 首位: standard (60.0%) 无命中
  🔴 package manager      P@3:   0.0% | 首位: parcel (65.8%) 无命中
  🔴 javascript runtime   P@3:   0.0% | 首位: jotai (59.5%) 无命中
  🔴 database orm         P@3:   0.0% | 首位: standard (60.8%) 无命中
  🟡 bundler              P@3:  33.3% | 首位: kysely (57.3%) 首个命中: parcel
  🟡 frontend framework   P@3:  33.3% | 首位: zustand (58.8%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "ui framework" (66.7%)
  最差查询: "build tool" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

🧹 正在清理网络连接池...
✅ 清理完成，程序即将退出

# lmstudio/wsxiaoys/jina-embeddings-v2-base-code-Q8_0-GGUF

🚀 开始embedding测试...

[memory-vector-search] {
  openaiBaseUrl: 'http://192.168.31.10:5000/v1',
  openaiApiKey: 'sk-USqYzFUmccukXK0jC392D995Aa4b4a2d9c49892c37E323B7',
  openaiModel: 'wsxiaoys/jina-embeddings-v2-base-code-Q8_0-GGUF',
  type: 'openai'
}
ℹ No proxy configured for OpenAI Compatible
📝 调试: OpenAI客户端不使用代理 (undici)
📦 添加模拟包数据...
📝 开始批量添加文档，数量: 27
📝 将分成 3 个批次处理，每批最多 10 个文档
📝 处理批次 1/3: 10 个文档
📝 内容示例: [ 'node_modules/parcel', 'node_modules/turbo', 'node_modules/rome' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 10
📝 批次 1 添加成功
📝 处理批次 2/3: 10 个文档
📝 内容示例: [ 'node_modules/vue', 'node_modules/react', 'node_modules/svelte' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 10
📝 批次 2 添加成功
📝 处理批次 3/3: 7 个文档
📝 内容示例: [ '/usr/local/bin/yarn', '/usr/local/bin/bun', '/usr/local/bin/deno' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 7
📝 批次 3 添加成功
📝 所有文档添加成功
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📝 开始搜索，查询: build tool
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. drizzle (46.1%) ❌
  2. qwik (40.7%) ❌
  3. rome (40.2%) ✅
  4. jotai (40.2%) ❌
  5. ava (39.4%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📝 开始搜索，查询: test framework
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. jasmine (46.8%) ✅
  2. qwik (41.9%) ❌
  3. mocha (40.7%) ✅
  4. drizzle (40.5%) ❌
  5. jotai (38.3%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📝 开始搜索，查询: code quality
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. drizzle (37.1%) ❌
  2. qwik (32.1%) ❌
  3. ava (29.6%) ❌
  4. kysely (28.5%) ❌
  5. jotai (27.4%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📝 开始搜索，查询: ui framework
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. qwik (28.5%) ✅
  2. jotai (27.2%) ❌
  3. kysely (24.9%) ❌
  4. ava (21.6%) ❌
  5. drizzle (21.3%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📝 开始搜索，查询: state management
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. qwik (21.4%) ❌
  2. drizzle (20.8%) ❌
  3. ava (18.1%) ❌
  4. jotai (17.2%) ✅
  5. tap (16.3%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📝 开始搜索，查询: package manager
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. qwik (43.8%) ❌
  2. drizzle (43.5%) ❌
  3. kysely (43.1%) ❌
  4. ava (42.7%) ❌
  5. jotai (41.3%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📝 开始搜索，查询: javascript runtime
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. drizzle (35.0%) ❌
  2. qwik (33.7%) ❌
  3. jotai (32.4%) ❌
  4. turbo (32.3%) ❌
  5. svelte (31.9%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📝 开始搜索，查询: database orm
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. prisma (35.1%) ✅
  2. qwik (28.7%) ❌
  3. drizzle (28.1%) ✅
  4. jotai (25.7%) ❌
  5. turbo (22.1%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📝 开始搜索，查询: bundler
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. drizzle (49.5%) ❌
  2. ava (47.1%) ❌
  3. biome (47.0%) ❌
  4. jotai (45.6%) ❌
  5. bun (45.5%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📝 开始搜索，查询: frontend framework
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. qwik (31.1%) ✅
  2. jotai (28.0%) ❌
  3. kysely (26.2%) ❌
  4. turbo (24.6%) ❌
  5. swc (24.4%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 23.3%
  平均 Precision@5: 16.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 5/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: drizzle (46.1%) 首个命中: rome
  🟡 test framework       P@3:  66.7% | 首位: jasmine (46.8%) 首个命中: jasmine
  🔴 code quality         P@3:   0.0% | 首位: drizzle (37.1%) 无命中
  🟡 ui framework         P@3:  33.3% | 首位: qwik (28.5%) 首个命中: qwik
  🔴 state management     P@3:   0.0% | 首位: qwik (21.4%) 首个命中: jotai
  🔴 package manager      P@3:   0.0% | 首位: qwik (43.8%) 无命中
  🔴 javascript runtime   P@3:   0.0% | 首位: drizzle (35.0%) 无命中
  🟡 database orm         P@3:  66.7% | 首位: prisma (35.1%) 首个命中: prisma
  🔴 bundler              P@3:   0.0% | 首位: drizzle (49.5%) 无命中
  🟡 frontend framework   P@3:  33.3% | 首位: qwik (31.1%) 首个命中: qwik

🔍 关键洞察:
  最佳查询: "test framework" (66.7%)
  最差查询: "code quality" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

🧹 正在清理网络连接池...
✅ 清理完成，程序即将退出

# lmstudio/awhiteside/CodeRankEmbed-Q8_0-GGUF

🚀 开始embedding测试...

[memory-vector-search] {
  openaiBaseUrl: 'http://192.168.31.10:5000/v1',
  openaiApiKey: 'sk-USqYzFUmccukXK0jC392D995Aa4b4a2d9c49892c37E323B7',
  type: 'openai'
}
✓ OpenAI Compatible using undici ProxyAgent: http://127.0.0.1:9090
📝 调试: OpenAI客户端将使用 undici ProxyAgent 代理
📦 添加模拟包数据...
📝 开始批量添加文档，数量: 27
📝 将分成 3 个批次处理，每批最多 10 个文档
📝 处理批次 1/3: 10 个文档
📝 内容示例: [ 'node_modules/parcel', 'node_modules/turbo', 'node_modules/rome' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 10
📝 批次 1 添加成功
📝 处理批次 2/3: 10 个文档
📝 内容示例: [ 'node_modules/vue', 'node_modules/react', 'node_modules/svelte' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 10
📝 批次 2 添加成功
📝 处理批次 3/3: 7 个文档
📝 内容示例: [ '/usr/local/bin/yarn', '/usr/local/bin/bun', '/usr/local/bin/deno' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 7
📝 批次 3 添加成功
📝 所有文档添加成功
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📝 开始搜索，查询: build tool
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. drizzle (46.1%) ❌
  2. qwik (40.7%) ❌
  3. rome (40.2%) ✅
  4. jotai (40.2%) ❌
  5. ava (39.4%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📝 开始搜索，查询: test framework
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. jasmine (46.8%) ✅
  2. qwik (41.9%) ❌
  3. mocha (40.7%) ✅
  4. drizzle (40.5%) ❌
  5. jotai (38.3%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📝 开始搜索，查询: code quality
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. drizzle (37.1%) ❌
  2. qwik (32.1%) ❌
  3. ava (29.6%) ❌
  4. kysely (28.5%) ❌
  5. jotai (27.4%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📝 开始搜索，查询: ui framework
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. qwik (28.5%) ✅
  2. jotai (27.2%) ❌
  3. kysely (24.9%) ❌
  4. ava (21.6%) ❌
  5. drizzle (21.3%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📝 开始搜索，查询: state management
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. qwik (21.4%) ❌
  2. drizzle (20.8%) ❌
  3. ava (18.1%) ❌
  4. jotai (17.2%) ✅
  5. tap (16.3%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📝 开始搜索，查询: package manager
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. qwik (43.8%) ❌
  2. drizzle (43.5%) ❌
  3. kysely (43.1%) ❌
  4. ava (42.7%) ❌
  5. jotai (41.3%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📝 开始搜索，查询: javascript runtime
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. drizzle (35.0%) ❌
  2. qwik (33.7%) ❌
  3. jotai (32.4%) ❌
  4. turbo (32.3%) ❌
  5. svelte (31.9%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📝 开始搜索，查询: database orm
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. prisma (35.1%) ✅
  2. qwik (28.7%) ❌
  3. drizzle (28.1%) ✅
  4. jotai (25.7%) ❌
  5. turbo (22.1%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📝 开始搜索，查询: bundler
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. drizzle (49.5%) ❌
  2. ava (47.1%) ❌
  3. biome (47.0%) ❌
  4. jotai (45.6%) ❌
  5. bun (45.5%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📝 开始搜索，查询: frontend framework
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. qwik (31.1%) ✅
  2. jotai (28.0%) ❌
  3. kysely (26.2%) ❌
  4. turbo (24.6%) ❌
  5. swc (24.4%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 23.3%
  平均 Precision@5: 16.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 5/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: drizzle (46.1%) 首个命中: rome
  🟡 test framework       P@3:  66.7% | 首位: jasmine (46.8%) 首个命中: jasmine
  🔴 code quality         P@3:   0.0% | 首位: drizzle (37.1%) 无命中
  🟡 ui framework         P@3:  33.3% | 首位: qwik (28.5%) 首个命中: qwik
  🔴 state management     P@3:   0.0% | 首位: qwik (21.4%) 首个命中: jotai
  🔴 package manager      P@3:   0.0% | 首位: qwik (43.8%) 无命中
  🔴 javascript runtime   P@3:   0.0% | 首位: drizzle (35.0%) 无命中
  🟡 database orm         P@3:  66.7% | 首位: prisma (35.1%) 首个命中: prisma
  🔴 bundler              P@3:   0.0% | 首位: drizzle (49.5%) 无命中
  🟡 frontend framework   P@3:  33.3% | 首位: qwik (31.1%) 首个命中: qwik

🔍 关键洞察:
  最佳查询: "test framework" (66.7%)
  最差查询: "code quality" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

🧹 正在清理网络连接池...
✅ 清理完成，程序即将退出

# ollama/hf.co/nomic-ai/nomic-embed-text-v2-moe-GGUF:f16

🚀 开始embedding测试...

[memory-vector-search] {
  ollamaModelId: 'hf.co/nomic-ai/nomic-embed-text-v2-moe-GGUF:f16',
  type: 'ollama'
}
📦 添加模拟包数据...
📝 开始批量添加文档，数量: 27
📝 将分成 3 个批次处理，每批最多 10 个文档
📝 处理批次 1/3: 10 个文档
📝 内容示例: [ 'node_modules/parcel', 'node_modules/turbo', 'node_modules/rome' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
✓ Using proxy: http://127.0.0.1:9090
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 10
📝 批次 1 添加成功
📝 处理批次 2/3: 10 个文档
📝 内容示例: [ 'node_modules/vue', 'node_modules/react', 'node_modules/svelte' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
✓ Using proxy: http://127.0.0.1:9090
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 10
📝 批次 2 添加成功
📝 处理批次 3/3: 7 个文档
📝 内容示例: [ '/usr/local/bin/yarn', '/usr/local/bin/bun', '/usr/local/bin/deno' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
✓ Using proxy: http://127.0.0.1:9090
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 7
📝 批次 3 添加成功
📝 所有文档添加成功
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📝 开始搜索，查询: build tool
✓ Using proxy: http://127.0.0.1:9090
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. kysely (30.6%) ❌
  2. bun (29.7%) ❌
  3. yarn (27.2%) ❌
  4. parcel (26.9%) ✅
  5. drizzle (26.1%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📝 开始搜索，查询: test framework
✓ Using proxy: http://127.0.0.1:9090
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. kysely (29.4%) ❌
  2. drizzle (26.0%) ❌
  3. tap (25.1%) ✅
  4. standard (25.0%) ❌
  5. react (24.0%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📝 开始搜索，查询: code quality
✓ Using proxy: http://127.0.0.1:9090
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. standard (28.5%) ✅
  2. kysely (27.8%) ❌
  3. jotai (26.6%) ❌
  4. solid (26.1%) ❌
  5. recoil (26.0%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📝 开始搜索，查询: ui framework
✓ Using proxy: http://127.0.0.1:9090
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. vue (32.2%) ✅
  2. bun (26.9%) ❌
  3. parcel (25.1%) ❌
  4. drizzle (25.0%) ❌
  5. standard (23.0%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📝 开始搜索，查询: state management
✓ Using proxy: http://127.0.0.1:9090
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. zustand (22.0%) ✅
  2. pnpm (21.5%) ❌
  3. bun (19.1%) ❌
  4. jasmine (18.1%) ❌
  5. biome (18.0%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📝 开始搜索，查询: package manager
✓ Using proxy: http://127.0.0.1:9090
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. pnpm (35.2%) ✅
  2. parcel (34.7%) ❌
  3. tap (28.8%) ❌
  4. bun (27.8%) ✅
  5. deno (27.7%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📝 开始搜索，查询: javascript runtime
✓ Using proxy: http://127.0.0.1:9090
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. jotai (37.1%) ❌
  2. jasmine (31.4%) ❌
  3. recoil (28.5%) ❌
  4. redux (27.1%) ❌
  5. zustand (25.9%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📝 开始搜索，查询: database orm
✓ Using proxy: http://127.0.0.1:9090
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. rome (31.4%) ❌
  2. biome (27.7%) ❌
  3. prisma (26.9%) ✅
  4. pnpm (26.2%) ❌
  5. parcel (24.1%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📝 开始搜索，查询: bundler
✓ Using proxy: http://127.0.0.1:9090
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. redux (27.4%) ❌
  2. parcel (26.9%) ✅
  3. solid (25.4%) ❌
  4. bun (25.3%) ❌
  5. kysely (24.8%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📝 开始搜索，查询: frontend framework
✓ Using proxy: http://127.0.0.1:9090
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. standard (30.0%) ❌
  2. parcel (28.8%) ❌
  3. solid (28.4%) ✅
  4. zustand (28.0%) ❌
  5. kysely (26.1%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 26.7%
  平均 Precision@5: 20.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 2/10 (0%)

📋 详细结果:
  🔴 build tool           P@3:   0.0% | 首位: kysely (30.6%) 首个命中: parcel
  🟡 test framework       P@3:  33.3% | 首位: kysely (29.4%) 首个命中: tap
  🟡 code quality         P@3:  33.3% | 首位: standard (28.5%) 首个命中: standard
  🟡 ui framework         P@3:  33.3% | 首位: vue (32.2%) 首个命中: vue
  🟡 state management     P@3:  33.3% | 首位: zustand (22.0%) 首个命中: zustand
  🟡 package manager      P@3:  33.3% | 首位: pnpm (35.2%) 首个命中: pnpm
  🔴 javascript runtime   P@3:   0.0% | 首位: jotai (37.1%) 无命中
  🟡 database orm         P@3:  33.3% | 首位: rome (31.4%) 首个命中: prisma
  🟡 bundler              P@3:  33.3% | 首位: redux (27.4%) 首个命中: parcel
  🟡 frontend framework   P@3:  33.3% | 首位: standard (30.0%) 首个命中: solid

🔍 关键洞察:
  最佳查询: "test framework" (33.3%)
  最差查询: "build tool" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

🧹 正在清理网络连接池...
✅ 清理完成，程序即将退出

# ollama/hf.co/nomic-ai/nomic-embed-code-GGUF:Q4_K_M

🚀 开始embedding测试...

[memory-vector-search] {
  ollamaModelId: 'hf.co/nomic-ai/nomic-embed-code-GGUF:Q4_K_M',
  type: 'ollama'
}
📦 添加模拟包数据...
📝 开始批量添加文档，数量: 27
📝 将分成 3 个批次处理，每批最多 10 个文档
📝 处理批次 1/3: 10 个文档
📝 内容示例: [ 'node_modules/parcel', 'node_modules/turbo', 'node_modules/rome' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
ℹ No proxy configured
📝 嵌入向量创建成功，维度: 3584
📝 返回的嵌入向量数量: 10
📝 批次 1 添加成功
📝 处理批次 2/3: 10 个文档
📝 内容示例: [ 'node_modules/vue', 'node_modules/react', 'node_modules/svelte' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
ℹ No proxy configured
📝 嵌入向量创建成功，维度: 3584
📝 返回的嵌入向量数量: 10
📝 批次 2 添加成功
📝 处理批次 3/3: 7 个文档
📝 内容示例: [ '/usr/local/bin/yarn', '/usr/local/bin/bun', '/usr/local/bin/deno' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
ℹ No proxy configured
📝 嵌入向量创建成功，维度: 3584
📝 返回的嵌入向量数量: 7
📝 批次 3 添加成功
📝 所有文档添加成功
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📝 开始搜索，查询: build tool
ℹ No proxy configured
📝 查询向量维度: 3584
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. biome (79.0%) ❌
  2. rome (78.5%) ✅
  3. swc (77.8%) ✅
  4. bun (77.4%) ❌
  5. tap (77.3%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📝 开始搜索，查询: test framework
ℹ No proxy configured
📝 查询向量维度: 3584
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. ava (80.4%) ✅
  2. mocha (79.9%) ✅
  3. jasmine (79.7%) ✅
  4. qwik (78.9%) ❌
  5. tap (78.8%) ✅
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📝 开始搜索，查询: code quality
ℹ No proxy configured
📝 查询向量维度: 3584
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. qwik (79.4%) ❌
  2. biome (78.2%) ✅
  3. rome (78.0%) ❌
  4. ava (77.7%) ❌
  5. swc (77.3%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📝 开始搜索，查询: ui framework
ℹ No proxy configured
📝 查询向量维度: 3584
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. qwik (80.1%) ✅
  2. biome (78.7%) ❌
  3. rome (78.6%) ❌
  4. swc (78.2%) ❌
  5. vue (78.1%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📝 开始搜索，查询: state management
ℹ No proxy configured
📝 查询向量维度: 3584
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. redux (80.5%) ✅
  2. recoil (79.7%) ✅
  3. zustand (79.5%) ✅
  4. jotai (79.0%) ✅
  5. rome (78.8%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📝 开始搜索，查询: package manager
ℹ No proxy configured
📝 查询向量维度: 3584
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. pnpm (81.6%) ✅
  2. biome (81.1%) ❌
  3. rome (81.0%) ❌
  4. parcel (80.6%) ❌
  5. swc (79.6%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📝 开始搜索，查询: javascript runtime
ℹ No proxy configured
📝 查询向量维度: 3584
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. rome (82.8%) ❌
  2. biome (80.6%) ❌
  3. node (79.5%) ✅
  4. swc (79.2%) ❌
  5. react (79.0%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📝 开始搜索，查询: database orm
ℹ No proxy configured
📝 查询向量维度: 3584
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. rome (80.5%) ❌
  2. biome (79.1%) ❌
  3. kysely (78.6%) ✅
  4. prisma (78.0%) ✅
  5. drizzle (78.0%) ✅
📈 Precision@3: 33.3% | Precision@5: 60.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📝 开始搜索，查询: bundler
ℹ No proxy configured
📝 查询向量维度: 3584
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. bun (86.0%) ❌
  2. biome (83.4%) ❌
  3. parcel (81.2%) ✅
  4. turbo (81.1%) ✅
  5. rome (81.0%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📝 开始搜索，查询: frontend framework
ℹ No proxy configured
📝 查询向量维度: 3584
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. qwik (78.6%) ✅
  2. vue (77.0%) ✅
  3. swc (77.0%) ❌
  4. rome (76.8%) ❌
  5. biome (76.6%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 53.3%
  平均 Precision@5: 44.0%
  表现良好查询: 2/10 (≥66.7%)
  完全失败查询: 0/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  66.7% | 首位: biome (79.0%) 首个命中: rome
  🟢 test framework       P@3: 100.0% | 首位: ava (80.4%) 首个命中: ava
  🟡 code quality         P@3:  33.3% | 首位: qwik (79.4%) 首个命中: biome
  🟡 ui framework         P@3:  33.3% | 首位: qwik (80.1%) 首个命中: qwik
  🟢 state management     P@3: 100.0% | 首位: redux (80.5%) 首个命中: redux
  🟡 package manager      P@3:  33.3% | 首位: pnpm (81.6%) 首个命中: pnpm
  🟡 javascript runtime   P@3:  33.3% | 首位: rome (82.8%) 首个命中: node
  🟡 database orm         P@3:  33.3% | 首位: rome (80.5%) 首个命中: kysely
  🟡 bundler              P@3:  33.3% | 首位: bun (86.0%) 首个命中: parcel
  🟡 frontend framework   P@3:  66.7% | 首位: qwik (78.6%) 首个命中: qwik

🔍 关键洞察:
  最佳查询: "test framework" (100.0%)
  最差查询: "code quality" (33.3%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

🧹 正在清理网络连接池...
✅ 清理完成，程序即将退出

# ollama/dengcao/bge-reranker-v2-m3

🚀 开始embedding测试...

[memory-vector-search] { ollamaModelId: 'dengcao/bge-reranker-v2-m3', type: 'ollama' }
📦 添加模拟包数据...
📝 开始批量添加文档，数量: 27
📝 将分成 3 个批次处理，每批最多 10 个文档
📝 处理批次 1/3: 10 个文档
📝 内容示例: [ 'node_modules/parcel', 'node_modules/turbo', 'node_modules/rome' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
ℹ No proxy configured
📝 嵌入向量创建成功，维度: 1024
📝 返回的嵌入向量数量: 10
📝 批次 1 添加成功
📝 处理批次 2/3: 10 个文档
📝 内容示例: [ 'node_modules/vue', 'node_modules/react', 'node_modules/svelte' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
ℹ No proxy configured
📝 嵌入向量创建成功，维度: 1024
📝 返回的嵌入向量数量: 10
📝 批次 2 添加成功
📝 处理批次 3/3: 7 个文档
📝 内容示例: [ '/usr/local/bin/yarn', '/usr/local/bin/bun', '/usr/local/bin/deno' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
ℹ No proxy configured
📝 嵌入向量创建成功，维度: 1024
📝 返回的嵌入向量数量: 7
📝 批次 3 添加成功
📝 所有文档添加成功
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📝 开始搜索，查询: build tool
ℹ No proxy configured
📝 查询向量维度: 1024
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. jotai (99.2%) ❌
  2. rome (99.2%) ✅
  3. jasmine (98.9%) ❌
  4. drizzle (98.8%) ❌
  5. mocha (98.6%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📝 开始搜索，查询: test framework
ℹ No proxy configured
📝 查询向量维度: 1024
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. rome (97.9%) ❌
  2. jotai (97.8%) ❌
  3. jasmine (97.4%) ✅
  4. drizzle (97.2%) ❌
  5. mocha (96.9%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📝 开始搜索，查询: code quality
ℹ No proxy configured
📝 查询向量维度: 1024
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. zustand (99.7%) ❌
  2. qwik (99.6%) ❌
  3. ava (99.6%) ❌
  4. redux (99.6%) ❌
  5. drizzle (99.6%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📝 开始搜索，查询: ui framework
ℹ No proxy configured
📝 查询向量维度: 1024
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. jotai (98.6%) ❌
  2. rome (98.6%) ❌
  3. jasmine (98.2%) ❌
  4. drizzle (98.1%) ❌
  5. mocha (97.8%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📝 开始搜索，查询: state management
ℹ No proxy configured
📝 查询向量维度: 1024
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. jotai (99.1%) ✅
  2. rome (99.1%) ❌
  3. jasmine (98.7%) ❌
  4. drizzle (98.7%) ❌
  5. mocha (98.5%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📝 开始搜索，查询: package manager
ℹ No proxy configured
📝 查询向量维度: 1024
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. jotai (99.6%) ❌
  2. rome (99.6%) ❌
  3. drizzle (99.6%) ❌
  4. jasmine (99.5%) ❌
  5. mocha (99.5%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📝 开始搜索，查询: javascript runtime
ℹ No proxy configured
📝 查询向量维度: 1024
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. jotai (99.7%) ❌
  2. rome (99.6%) ❌
  3. jasmine (99.6%) ❌
  4. drizzle (99.6%) ❌
  5. mocha (99.4%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📝 开始搜索，查询: database orm
ℹ No proxy configured
📝 查询向量维度: 1024
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. jotai (99.6%) ❌
  2. rome (99.6%) ❌
  3. jasmine (99.4%) ❌
  4. drizzle (99.4%) ✅
  5. mocha (99.2%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📝 开始搜索，查询: bundler
ℹ No proxy configured
📝 查询向量维度: 1024
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. jotai (99.5%) ❌
  2. rome (99.5%) ❌
  3. drizzle (99.3%) ❌
  4. jasmine (99.2%) ❌
  5. mocha (99.1%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📝 开始搜索，查询: frontend framework
ℹ No proxy configured
📝 查询向量维度: 1024
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. rome (99.7%) ❌
  2. jotai (99.7%) ❌
  3. drizzle (99.6%) ❌
  4. jasmine (99.5%) ❌
  5. mocha (99.4%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 10.0%
  平均 Precision@5: 10.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 7/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: jotai (99.2%) 首个命中: rome
  🟡 test framework       P@3:  33.3% | 首位: rome (97.9%) 首个命中: jasmine
  🔴 code quality         P@3:   0.0% | 首位: zustand (99.7%) 无命中
  🔴 ui framework         P@3:   0.0% | 首位: jotai (98.6%) 无命中
  🟡 state management     P@3:  33.3% | 首位: jotai (99.1%) 首个命中: jotai
  🔴 package manager      P@3:   0.0% | 首位: jotai (99.6%) 无命中
  🔴 javascript runtime   P@3:   0.0% | 首位: jotai (99.7%) 无命中
  🔴 database orm         P@3:   0.0% | 首位: jotai (99.6%) 首个命中: drizzle
  🔴 bundler              P@3:   0.0% | 首位: jotai (99.5%) 无命中
  🔴 frontend framework   P@3:   0.0% | 首位: rome (99.7%) 无命中

🔍 关键洞察:
  最佳查询: "build tool" (33.3%)
  最差查询: "code quality" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

🧹 正在清理网络连接池...
✅ 清理完成，程序即将退出

# jina-embeddings-v4

🚀 开始embedding测试...

[memory-vector-search] {
  provider: 'openai-compatible',
  apiKey: 'jina_9c69850dfc7442c189152fa6f2e9eeffamfT5zJm28du0A9T9ldrh-loHFEM',
  baseUrl: 'https://api.jina.ai/v1',
  model: 'jina-embeddings-v4',
  dimension: 1024
}
📝 调试: OpenAI客户端不使用代理 (undici)
📦 添加模拟包数据...
📝 开始批量添加文档，数量: 27
📝 将分成 3 个批次处理，每批最多 10 个文档
📝 处理批次 1/3: 10 个文档
📝 内容示例: [ 'node_modules/parcel', 'node_modules/turbo', 'node_modules/rome' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 2048
📝 返回的嵌入向量数量: 10
📝 批次 1 添加成功
📝 处理批次 2/3: 10 个文档
📝 内容示例: [ 'node_modules/vue', 'node_modules/react', 'node_modules/svelte' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 2048
📝 返回的嵌入向量数量: 10
📝 批次 2 添加成功
📝 处理批次 3/3: 7 个文档
📝 内容示例: [ '/usr/local/bin/yarn', '/usr/local/bin/bun', '/usr/local/bin/deno' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 2048
📝 返回的嵌入向量数量: 7
📝 批次 3 添加成功
📝 所有文档添加成功
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📝 开始搜索，查询: build tool
📝 查询向量维度: 2048
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. turbo (70.0%) ✅
  2. biome (70.0%) ❌
  3. parcel (69.8%) ✅
  4. swc (69.0%) ✅
  5. tap (68.9%) ❌
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📝 开始搜索，查询: test framework
📝 查询向量维度: 2048
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. tap (67.2%) ✅
  2. biome (66.6%) ❌
  3. ava (66.5%) ✅
  4. mocha (66.0%) ✅
  5. turbo (65.8%) ❌
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📝 开始搜索，查询: code quality
📝 查询向量维度: 2048
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. standard (65.2%) ✅
  2. biome (62.3%) ✅
  3. tap (62.1%) ❌
  4. rome (62.0%) ❌
  5. swc (61.4%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📝 开始搜索，查询: ui framework
📝 查询向量维度: 2048
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. biome (66.4%) ❌
  2. solid (64.9%) ✅
  3. qwik (64.7%) ✅
  4. turbo (64.5%) ❌
  5. tap (64.3%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📝 开始搜索，查询: state management
📝 查询向量维度: 2048
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. biome (63.6%) ❌
  2. turbo (62.6%) ❌
  3. tap (62.5%) ❌
  4. solid (62.3%) ❌
  5. rome (62.0%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📝 开始搜索，查询: package manager
📝 查询向量维度: 2048
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. parcel (73.3%) ❌
  2. biome (73.3%) ❌
  3. tap (73.1%) ❌
  4. pnpm (72.4%) ✅
  5. rome (72.3%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📝 开始搜索，查询: javascript runtime
📝 查询向量维度: 2048
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. swc (68.6%) ❌
  2. jasmine (68.5%) ❌
  3. node (68.4%) ✅
  4. turbo (68.4%) ❌
  5. tap (68.3%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📝 开始搜索，查询: database orm
📝 查询向量维度: 2048
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. biome (66.7%) ❌
  2. rome (65.3%) ❌
  3. turbo (65.1%) ❌
  4. tap (64.7%) ❌
  5. prisma (64.6%) ✅
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📝 开始搜索，查询: bundler
📝 查询向量维度: 2048
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. parcel (72.5%) ✅
  2. turbo (72.5%) ✅
  3. bun (72.2%) ❌
  4. biome (71.4%) ❌
  5. swc (71.0%) ✅
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📝 开始搜索，查询: frontend framework
📝 查询向量维度: 2048
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. biome (68.2%) ❌
  2. parcel (67.3%) ❌
  3. turbo (67.1%) ❌
  4. solid (67.0%) ✅
  5. qwik (66.7%) ✅
📈 Precision@3: 0.0% | Precision@5: 40.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 36.7%
  平均 Precision@5: 36.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 4/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  66.7% | 首位: turbo (70.0%) 首个命中: turbo
  🟡 test framework       P@3:  66.7% | 首位: tap (67.2%) 首个命中: tap
  🟡 code quality         P@3:  66.7% | 首位: standard (65.2%) 首个命中: standard
  🟡 ui framework         P@3:  66.7% | 首位: biome (66.4%) 首个命中: solid
  🔴 state management     P@3:   0.0% | 首位: biome (63.6%) 无命中
  🔴 package manager      P@3:   0.0% | 首位: parcel (73.3%) 首个命中: pnpm
  🟡 javascript runtime   P@3:  33.3% | 首位: swc (68.6%) 首个命中: node
  🔴 database orm         P@3:   0.0% | 首位: biome (66.7%) 首个命中: prisma
  🟡 bundler              P@3:  66.7% | 首位: parcel (72.5%) 首个命中: parcel
  🔴 frontend framework   P@3:   0.0% | 首位: biome (68.2%) 首个命中: solid

🔍 关键洞察:
  最佳查询: "build tool" (66.7%)
  最差查询: "state management" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

🧹 正在清理网络连接池...
✅ 清理完成，程序即将退出

# jina-embeddings-v2-base-code
🚀 开始embedding测试...

[memory-vector-search] {
  provider: 'jina',
  apiKey: 'jina_9c69850dfc7442c189152fa6f2e9eeffamfT5zJm28du0A9T9ldrh-loHFEM',
  model: 'jina-embeddings-v2-base-code',
  dimension: 768
}
📦 添加模拟包数据...
📝 开始批量添加文档，数量: 27
📝 将分成 3 个批次处理，每批最多 10 个文档
📝 处理批次 1/3: 10 个文档
📝 内容示例: [ 'node_modules/parcel', 'node_modules/turbo', 'node_modules/rome' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 10
📝 批次 1 添加成功
📝 处理批次 2/3: 10 个文档
📝 内容示例: [ 'node_modules/vue', 'node_modules/react', 'node_modules/svelte' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 10
📝 批次 2 添加成功
📝 处理批次 3/3: 7 个文档
📝 内容示例: [ '/usr/local/bin/yarn', '/usr/local/bin/bun', '/usr/local/bin/deno' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 7
📝 批次 3 添加成功
📝 所有文档添加成功
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📝 开始搜索，查询: build tool
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. drizzle (46.3%) ❌
  2. qwik (40.6%) ❌
  3. jotai (40.4%) ❌
  4. rome (40.2%) ✅
  5. ava (39.3%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📝 开始搜索，查询: test framework
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. jasmine (46.8%) ✅
  2. qwik (41.8%) ❌
  3. mocha (40.7%) ✅
  4. drizzle (40.4%) ❌
  5. jotai (38.3%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📝 开始搜索，查询: code quality
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. drizzle (37.0%) ❌
  2. qwik (32.3%) ❌
  3. ava (29.2%) ❌
  4. kysely (28.5%) ❌
  5. jotai (27.5%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📝 开始搜索，查询: ui framework
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. qwik (28.5%) ✅
  2. jotai (27.2%) ❌
  3. kysely (25.0%) ❌
  4. ava (21.4%) ❌
  5. rome (21.1%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📝 开始搜索，查询: state management
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. qwik (21.7%) ❌
  2. drizzle (21.3%) ❌
  3. ava (18.1%) ❌
  4. jotai (17.6%) ✅
  5. tap (17.0%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📝 开始搜索，查询: package manager
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. qwik (43.6%) ❌
  2. drizzle (43.4%) ❌
  3. kysely (43.3%) ❌
  4. ava (42.6%) ❌
  5. jotai (41.5%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📝 开始搜索，查询: javascript runtime
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. drizzle (35.4%) ❌
  2. qwik (34.0%) ❌
  3. jotai (32.7%) ❌
  4. svelte (32.3%) ❌
  5. turbo (32.3%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📝 开始搜索，查询: database orm
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. prisma (35.3%) ✅
  2. qwik (28.7%) ❌
  3. drizzle (28.1%) ✅
  4. jotai (25.7%) ❌
  5. turbo (22.0%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📝 开始搜索，查询: bundler
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. drizzle (49.8%) ❌
  2. ava (47.2%) ❌
  3. biome (47.0%) ❌
  4. jotai (45.9%) ❌
  5. bun (45.7%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📝 开始搜索，查询: frontend framework
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. qwik (31.2%) ✅
  2. jotai (28.2%) ❌
  3. kysely (26.5%) ❌
  4. turbo (24.8%) ❌
  5. swc (24.6%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 20.0%
  平均 Precision@5: 16.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 6/10 (0%)

📋 详细结果:
  🔴 build tool           P@3:   0.0% | 首位: drizzle (46.3%) 首个命中: rome
  🟡 test framework       P@3:  66.7% | 首位: jasmine (46.8%) 首个命中: jasmine
  🔴 code quality         P@3:   0.0% | 首位: drizzle (37.0%) 无命中
  🟡 ui framework         P@3:  33.3% | 首位: qwik (28.5%) 首个命中: qwik
  🔴 state management     P@3:   0.0% | 首位: qwik (21.7%) 首个命中: jotai
  🔴 package manager      P@3:   0.0% | 首位: qwik (43.6%) 无命中
  🔴 javascript runtime   P@3:   0.0% | 首位: drizzle (35.4%) 无命中
  🟡 database orm         P@3:  66.7% | 首位: prisma (35.3%) 首个命中: prisma
  🔴 bundler              P@3:   0.0% | 首位: drizzle (49.8%) 无命中
  🟡 frontend framework   P@3:  33.3% | 首位: qwik (31.2%) 首个命中: qwik

🔍 关键洞察:
  最佳查询: "test framework" (66.7%)
  最差查询: "build tool" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

🧹 正在清理网络连接池...
✅ 清理完成，程序即将退出

# ollama/embeddinggemma

🚀 开始embedding测试...

[memory-vector-search] {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: 'embeddinggemma',
  dimension: 768
}
📦 添加模拟包数据...
📝 开始批量添加文档，数量: 27
📝 将分成 3 个批次处理，每批最多 10 个文档
📝 处理批次 1/3: 10 个文档
📝 内容示例: [ 'node_modules/parcel', 'node_modules/turbo', 'node_modules/rome' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 10
📝 批次 1 添加成功
📝 处理批次 2/3: 10 个文档
📝 内容示例: [ 'node_modules/vue', 'node_modules/react', 'node_modules/svelte' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 10
📝 批次 2 添加成功
📝 处理批次 3/3: 7 个文档
📝 内容示例: [ '/usr/local/bin/yarn', '/usr/local/bin/bun', '/usr/local/bin/deno' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 768
📝 返回的嵌入向量数量: 7
📝 批次 3 添加成功
📝 所有文档添加成功
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📝 开始搜索，查询: build tool
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. bun (76.9%) ❌
  2. solid (76.0%) ❌
  3. node (75.8%) ❌
  4. turbo (75.5%) ✅
  5. jasmine (75.2%) ❌
📈 Precision@3: 0.0% | Precision@5: 20.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📝 开始搜索，查询: test framework
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. react (81.4%) ❌
  2. tap (81.3%) ✅
  3. parcel (81.3%) ❌
  4. turbo (81.1%) ❌
  5. mocha (81.0%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📝 开始搜索，查询: code quality
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. standard (80.3%) ✅
  2. solid (79.8%) ❌
  3. parcel (79.8%) ❌
  4. turbo (79.6%) ❌
  5. mocha (79.3%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📝 开始搜索，查询: ui framework
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. vue (84.1%) ✅
  2. tap (83.7%) ❌
  3. redux (83.7%) ❌
  4. react (83.7%) ✅
  5. turbo (83.3%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📝 开始搜索，查询: state management
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. zustand (74.6%) ✅
  2. parcel (71.8%) ❌
  3. yarn (71.0%) ❌
  4. solid (71.0%) ❌
  5. redux (70.9%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📝 开始搜索，查询: package manager
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. parcel (78.6%) ❌
  2. redux (77.8%) ❌
  3. turbo (77.4%) ❌
  4. mocha (77.3%) ❌
  5. jasmine (77.1%) ❌
📈 Precision@3: 0.0% | Precision@5: 0.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📝 开始搜索，查询: javascript runtime
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. jasmine (82.6%) ❌
  2. react (81.7%) ❌
  3. node (81.1%) ✅
  4. yarn (80.8%) ❌
  5. turbo (80.7%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📝 开始搜索，查询: database orm
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. prisma (78.2%) ✅
  2. parcel (78.2%) ❌
  3. turbo (78.1%) ❌
  4. mocha (77.8%) ❌
  5. redux (77.8%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📝 开始搜索，查询: bundler
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. parcel (83.3%) ✅
  2. solid (82.8%) ❌
  3. turbo (82.2%) ✅
  4. bun (81.9%) ❌
  5. mocha (81.7%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📝 开始搜索，查询: frontend framework
📝 查询向量维度: 768
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. react (85.6%) ❌
  2. redux (84.6%) ❌
  3. parcel (84.6%) ❌
  4. turbo (84.4%) ❌
  5. solid (84.3%) ✅
📈 Precision@3: 0.0% | Precision@5: 20.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 26.7%
  平均 Precision@5: 26.0%
  表现良好查询: 0/10 (≥66.7%)
  完全失败查询: 3/10 (0%)

📋 详细结果:
  🔴 build tool           P@3:   0.0% | 首位: bun (76.9%) 首个命中: turbo
  🟡 test framework       P@3:  33.3% | 首位: react (81.4%) 首个命中: tap
  🟡 code quality         P@3:  33.3% | 首位: standard (80.3%) 首个命中: standard
  🟡 ui framework         P@3:  33.3% | 首位: vue (84.1%) 首个命中: vue
  🟡 state management     P@3:  33.3% | 首位: zustand (74.6%) 首个命中: zustand
  🔴 package manager      P@3:   0.0% | 首位: parcel (78.6%) 无命中
  🟡 javascript runtime   P@3:  33.3% | 首位: jasmine (82.6%) 首个命中: node
  🟡 database orm         P@3:  33.3% | 首位: prisma (78.2%) 首个命中: prisma
  🟡 bundler              P@3:  66.7% | 首位: parcel (83.3%) 首个命中: parcel
  🔴 frontend framework   P@3:   0.0% | 首位: react (85.6%) 首个命中: solid

🔍 关键洞察:
  最佳查询: "bundler" (66.7%)
  最差查询: "build tool" (0.0%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

🧹 正在清理网络连接池...
✅ 清理完成，程序即将退出

# jina/jina-code-embeddings-1.5b
🚀 开始embedding测试...

[memory-vector-search] {
  provider: 'jina',
  apiKey: 'jina_9c69850dfc7442c189152fa6f2e9eeffamfT5zJm28du0A9T9ldrh-loHFEM',
  model: 'jina-code-embeddings-1.5b',
  dimension: 1536
}
📦 添加模拟包数据...
📝 开始批量添加文档，数量: 27
📝 将分成 3 个批次处理，每批最多 10 个文档
📝 处理批次 1/3: 10 个文档
📝 内容示例: [ 'node_modules/parcel', 'node_modules/turbo', 'node_modules/rome' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 1536
📝 返回的嵌入向量数量: 10
📝 批次 1 添加成功
📝 处理批次 2/3: 10 个文档
📝 内容示例: [ 'node_modules/vue', 'node_modules/react', 'node_modules/svelte' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 1536
📝 返回的嵌入向量数量: 10
📝 批次 2 添加成功
📝 处理批次 3/3: 7 个文档
📝 内容示例: [ '/usr/local/bin/yarn', '/usr/local/bin/bun', '/usr/local/bin/deno' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 1536
📝 返回的嵌入向量数量: 7
📝 批次 3 添加成功
📝 所有文档添加成功
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📝 开始搜索，查询: build tool
📝 查询向量维度: 1536
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. bun (28.2%) ❌
  2. node (28.1%) ❌
  3. swc (26.9%) ✅
  4. turbo (25.9%) ✅
  5. deno (24.7%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📝 开始搜索，查询: test framework
📝 查询向量维度: 1536
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. mocha (27.8%) ✅
  2. jasmine (23.4%) ✅
  3. turbo (19.5%) ❌
  4. ava (17.2%) ✅
  5. standard (16.1%) ❌
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📝 开始搜索，查询: code quality
📝 查询向量维度: 1536
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. standard (28.8%) ✅
  2. turbo (25.7%) ❌
  3. kysely (24.9%) ❌
  4. rome (24.8%) ❌
  5. mocha (22.4%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📝 开始搜索，查询: ui framework
📝 查询向量维度: 1536
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. vue (28.6%) ✅
  2. react (26.9%) ✅
  3. qwik (25.1%) ✅
  4. svelte (23.8%) ✅
  5. mocha (23.5%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📝 开始搜索，查询: state management
📝 查询向量维度: 1536
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. zustand (30.5%) ✅
  2. redux (24.1%) ✅
  3. recoil (22.1%) ✅
  4. jotai (19.8%) ✅
  5. turbo (19.3%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📝 开始搜索，查询: package manager
📝 查询向量维度: 1536
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. pnpm (30.2%) ✅
  2. bun (25.3%) ✅
  3. yarn (23.7%) ✅
  4. mocha (22.6%) ❌
  5. node (21.9%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📝 开始搜索，查询: javascript runtime
📝 查询向量维度: 1536
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. node (30.5%) ✅
  2. rome (27.3%) ❌
  3. swc (27.0%) ❌
  4. jasmine (26.8%) ❌
  5. deno (26.2%) ✅
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📝 开始搜索，查询: database orm
📝 查询向量维度: 1536
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. kysely (28.3%) ✅
  2. prisma (23.8%) ✅
  3. drizzle (21.3%) ✅
  4. turbo (11.7%) ❌
  5. recoil (10.2%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📝 开始搜索，查询: bundler
📝 查询向量维度: 1536
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. bun (34.0%) ❌
  2. parcel (25.5%) ✅
  3. mocha (24.2%) ❌
  4. jasmine (24.1%) ❌
  5. yarn (23.0%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📝 开始搜索，查询: frontend framework
📝 查询向量维度: 1536
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. react (25.8%) ❌
  2. vue (25.6%) ✅
  3. qwik (22.8%) ✅
  4. turbo (21.4%) ❌
  5. solid (21.1%) ✅
📈 Precision@3: 66.7% | Precision@5: 60.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 66.7%
  平均 Precision@5: 52.0%
  表现良好查询: 4/10 (≥66.7%)
  完全失败查询: 0/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  33.3% | 首位: bun (28.2%) 首个命中: swc
  🟡 test framework       P@3:  66.7% | 首位: mocha (27.8%) 首个命中: mocha
  🟡 code quality         P@3:  33.3% | 首位: standard (28.8%) 首个命中: standard
  🟢 ui framework         P@3: 100.0% | 首位: vue (28.6%) 首个命中: vue
  🟢 state management     P@3: 100.0% | 首位: zustand (30.5%) 首个命中: zustand
  🟢 package manager      P@3: 100.0% | 首位: pnpm (30.2%) 首个命中: pnpm
  🟡 javascript runtime   P@3:  33.3% | 首位: node (30.5%) 首个命中: node
  🟢 database orm         P@3: 100.0% | 首位: kysely (28.3%) 首个命中: kysely
  🟡 bundler              P@3:  33.3% | 首位: bun (34.0%) 首个命中: parcel
  🟡 frontend framework   P@3:  66.7% | 首位: react (25.8%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "ui framework" (100.0%)
  最差查询: "build tool" (33.3%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

🧹 正在清理网络连接池...
✅ 清理完成，程序即将退出

# jina-code-embeddings-0.5b
🚀 开始embedding测试...

[memory-vector-search] {
  provider: 'jina',
  apiKey: 'jina_9c69850dfc7442c189152fa6f2e9eeffamfT5zJm28du0A9T9ldrh-loHFEM',
  model: 'jina-code-embeddings-0.5b',
  dimension: 896
}
📦 添加模拟包数据...
📝 开始批量添加文档，数量: 27
📝 将分成 3 个批次处理，每批最多 10 个文档
📝 处理批次 1/3: 10 个文档
📝 内容示例: [ 'node_modules/parcel', 'node_modules/turbo', 'node_modules/rome' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 896
📝 返回的嵌入向量数量: 10
📝 批次 1 添加成功
📝 处理批次 2/3: 10 个文档
📝 内容示例: [ 'node_modules/vue', 'node_modules/react', 'node_modules/svelte' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 896
📝 返回的嵌入向量数量: 10
📝 批次 2 添加成功
📝 处理批次 3/3: 7 个文档
📝 内容示例: [ '/usr/local/bin/yarn', '/usr/local/bin/bun', '/usr/local/bin/deno' ]
📝 调用embedder.createEmbeddings...
📝 准备发送网络请求，等待响应...
📝 嵌入向量创建成功，维度: 896
📝 返回的嵌入向量数量: 7
📝 批次 3 添加成功
📝 所有文档添加成功
✅ 已添加 27 个包

🔍 查询: "build tool"
📋 期望结果: parcel, turbo, rome, swc
📝 开始搜索，查询: build tool
📝 查询向量维度: 896
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. turbo (28.2%) ✅
  2. bun (25.8%) ❌
  3. rome (24.4%) ✅
  4. node (23.5%) ❌
  5. standard (23.4%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "test framework"
📋 期望结果: mocha, jasmine, ava, tap
📝 开始搜索，查询: test framework
📝 查询向量维度: 896
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. jasmine (23.3%) ✅
  2. ava (21.8%) ✅
  3. standard (20.9%) ❌
  4. turbo (20.1%) ❌
  5. tap (19.7%) ✅
📈 Precision@3: 66.7% | Precision@5: 60.0%
---
🔍 查询: "code quality"
📋 期望结果: standard, biome
📝 开始搜索，查询: code quality
📝 查询向量维度: 896
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. standard (29.2%) ✅
  2. rome (27.0%) ❌
  3. recoil (19.9%) ❌
  4. turbo (18.4%) ❌
  5. swc (17.9%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "ui framework"
📋 期望结果: vue, svelte, solid, qwik, react
📝 开始搜索，查询: ui framework
📝 查询向量维度: 896
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. vue (24.1%) ✅
  2. qwik (24.0%) ✅
  3. redux (23.5%) ❌
  4. svelte (20.1%) ✅
  5. react (19.1%) ✅
📈 Precision@3: 66.7% | Precision@5: 80.0%
---
🔍 查询: "state management"
📋 期望结果: redux, zustand, jotai, recoil
📝 开始搜索，查询: state management
📝 查询向量维度: 896
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. zustand (34.5%) ✅
  2. redux (31.2%) ✅
  3. recoil (27.7%) ✅
  4. jotai (24.7%) ✅
  5. kysely (22.2%) ❌
📈 Precision@3: 100.0% | Precision@5: 80.0%
---
🔍 查询: "package manager"
📋 期望结果: pnpm, yarn, bun
📝 开始搜索，查询: package manager
📝 查询向量维度: 896
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. pnpm (32.3%) ✅
  2. node (26.3%) ❌
  3. yarn (25.6%) ✅
  4. standard (23.6%) ❌
  5. parcel (22.6%) ❌
📈 Precision@3: 66.7% | Precision@5: 40.0%
---
🔍 查询: "javascript runtime"
📋 期望结果: deno, node, bun
📝 开始搜索，查询: javascript runtime
📝 查询向量维度: 896
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. turbo (34.0%) ❌
  2. node (29.7%) ✅
  3. vue (28.8%) ❌
  4. svelte (28.2%) ❌
  5. standard (27.0%) ❌
📈 Precision@3: 33.3% | Precision@5: 20.0%
---
🔍 查询: "database orm"
📋 期望结果: prisma, drizzle, kysely
📝 开始搜索，查询: database orm
📝 查询向量维度: 896
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. kysely (27.1%) ✅
  2. drizzle (26.3%) ✅
  3. prisma (25.8%) ✅
  4. bun (18.3%) ❌
  5. recoil (17.2%) ❌
📈 Precision@3: 100.0% | Precision@5: 60.0%
---
🔍 查询: "bundler"
📋 期望结果: parcel, turbo, swc
📝 开始搜索，查询: bundler
📝 查询向量维度: 896
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. bun (38.7%) ❌
  2. turbo (31.1%) ✅
  3. yarn (28.0%) ❌
  4. parcel (25.6%) ✅
  5. biome (23.5%) ❌
📈 Precision@3: 33.3% | Precision@5: 40.0%
---
🔍 查询: "frontend framework"
📋 期望结果: vue, svelte, solid, qwik
📝 开始搜索，查询: frontend framework
📝 查询向量维度: 896
📝 搜索完成，返回结果数量: 5
📊 搜索结果:
  1. vue (26.1%) ✅
  2. redux (25.5%) ❌
  3. qwik (23.4%) ✅
  4. turbo (22.9%) ❌
  5. svelte (22.1%) ✅
📈 Precision@3: 66.7% | Precision@5: 60.0%
---

🎯 测试汇总报告
============================================================
📊 总体表现:
  平均 Precision@3: 63.3%
  平均 Precision@5: 50.0%
  表现良好查询: 2/10 (≥66.7%)
  完全失败查询: 0/10 (0%)

📋 详细结果:
  🟡 build tool           P@3:  66.7% | 首位: turbo (28.2%) 首个命中: turbo
  🟡 test framework       P@3:  66.7% | 首位: jasmine (23.3%) 首个命中: jasmine
  🟡 code quality         P@3:  33.3% | 首位: standard (29.2%) 首个命中: standard
  🟡 ui framework         P@3:  66.7% | 首位: vue (24.1%) 首个命中: vue
  🟢 state management     P@3: 100.0% | 首位: zustand (34.5%) 首个命中: zustand
  🟡 package manager      P@3:  66.7% | 首位: pnpm (32.3%) 首个命中: pnpm
  🟡 javascript runtime   P@3:  33.3% | 首位: turbo (34.0%) 首个命中: node
  🟢 database orm         P@3: 100.0% | 首位: kysely (27.1%) 首个命中: kysely
  🟡 bundler              P@3:  33.3% | 首位: bun (38.7%) 首个命中: turbo
  🟡 frontend framework   P@3:  66.7% | 首位: vue (26.1%) 首个命中: vue

🔍 关键洞察:
  最佳查询: "state management" (100.0%)
  最差查询: "code quality" (33.3%)
  模型对抽象命名包的理解能力有限
  字面相似性对结果影响显著

🧹 正在清理网络连接池...
✅ 清理完成，程序即将退出
