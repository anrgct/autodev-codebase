# 把你的 RAG 方案升级成类 INTRA：从“检索-重排-生成”到“注意力即检索”
INTRA: https://arxiv.org/html/2605.05806v2

## 1. 你目前的方案（推测）
1. **Embedding**：用 LLM（decoder-only，如 LLaMA/Qwen）的某一层隐藏状态对文档做池化（或取特殊 token），得到密集向量，存入向量库。
2. **检索**：query 同样编码为向量，通过相似度（如余弦）召回 top-k 文档。
3. **Rerank**：利用 LLM 在 (query, doc) 上的交叉编码或注意力分布对 top-k 重排序，选出 top-n。
4. **生成**：将选中的文档原文拼接到 prompt 中，再次送入 LLM 完成生成。

**痛点**：Embedding、Rerank、生成三个步骤使用的表示空间彼此割裂，文档在生成时仍需重新编码，多跳场景下更难补全缺失证据。

---

## 2. 升级目标：让模型用自己的注意力直接做检索
核心思想来自 INTRA：**用同一个 decoder 的 cross-attention 对预编码的 token 级向量进行打分，选出的 token 状态直接作为生成时的 key-value 上下文。**  
你的 LLM 是 decoder-only，虽然没有独立的 encoder，但我们可以构造一个近似方案，让它自己既是“编码器”又是“解码器”。

---

## 3. 升级后的流程（一步到位版本）
```
语料预处理：
  - 将每个文档 chunk 送入 LLM，存储最后一层隐藏状态（token 级 key 序列），做 8-bit 量化。
  - 同时计算并存储与模型各层投影对齐后的查询侧权重（见下文）。

查询时：
  a. 输入 = query + <retrieval_tokens>
  b. 前向传播，取 retrieval token 在某几层的注意力输出，变换后与所有 chunk 的 key 计算 MaxSim，选出 top-n chunk。
  c. 将选中 chunk 的同一份 token 级 key 序列作为额外的 key-value 拼接到自注意力层中（或转换为跨注意力形式），再次前向生成答案。
  d. 训练阶段只更新 retrieval token 和层聚合权重（总参数 < 200K）。
```

---

## 4. 关键技术细节与伪代码

### 4.1 预编码：保存 token 级 key 序列
```python
from transformers import AutoModelForCausalLM, AutoTokenizer
import torch

model = AutoModelForCausalLM.from_pretrained("your-llm", torch_dtype=torch.float16)
tokenizer = AutoTokenizer.from_pretrained("your-llm")

def encode_chunk(text):
    inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=512)
    with torch.no_grad():
        # 取最后一层隐藏状态（或中间某层）
        outputs = model(**inputs, output_hidden_states=True, return_dict=True)
        last_hidden = outputs.hidden_states[-1]  # (1, seq_len, hidden_dim)
    # 如果需要，吸收 key 投影矩阵，但为了后续所有层复用，保存未投影的隐藏状态
    return last_hidden.squeeze(0).cpu()  # (seq_len, hidden_dim)
```

### 4.2 吸收 key 投影，让所有层共享同一份 key（RQWK 技巧）
对于 decoder-only 模型，每一层的 self-attention 有独立的 key 投影矩阵 \(W_k^l\)。为了让所有层都能用同一份预编码状态 \(H\) 做检索，我们把投影“挪”到查询侧。

数学上：
\[
(q^l W_q^l)(K^l)^\top = q^l (W_q^l W_k^{l\top}) H^\top
\]
因此可以预计算 \(W_q^l W_k^{l\top}\) 并存储，检索时对查询状态做一次线性变换，然后直接与 \(H\) 求内积。

```python
# 预计算每层的查询侧对齐矩阵
aligned_query_proj = {}
for l in range(num_layers):
    W_q = model.model.layers[l].self_attn.q_proj.weight  # (hidden_dim, num_heads * head_dim)
    W_k = model.model.layers[l].self_attn.k_proj.weight
    aligned_query_proj[l] = W_q @ W_k.T  # (hidden_dim, hidden_dim)

# 检索时，对 retrieval token 的隐藏状态 h (hidden_dim) 做变换
def compute_scores_per_layer(h, layer_idx, chunk_keys):
    h_proj = h @ aligned_query_proj[layer_idx]  # (num_heads * head_dim)
    # 将 h_proj 拆分成多头 (num_heads, head_dim)，这里省略
    # 每个头与 chunk_keys 计算 MaxSim
    return max_sim_scores  # (num_chunks,)
```

### 4.3 训练 Retrieval Token
在 tokenizer 中添加 2~5 个特殊 token，仅训练它们的嵌入权重。
```python
retrieval_token_ids = tokenizer.add_tokens(["<RETR1>", "<RETR2>", "<RETR3>"])
model.resize_token_embeddings(len(tokenizer))
# 冻结除 retrieval token 嵌入外的所有参数
for name, param in model.named_parameters():
    if "embed_tokens" not in name:  # 或更精确地指定新 token 对应的部分
        param.requires_grad = False
```
输入构造：`query_tokens + retrieval_tokens`  
前向传播后，取最后一层（或加权多层）这些 token 的隐藏状态，按 4.2 的方法计算所有 chunk 的得分。  
损失函数：选中的 top-n chunk 与真实证据的交叉熵（Soft CrossEntropy）。

### 4.4 一次性生成
用选中的 chunk 的原始隐藏状态 \(H_{chunk}\) 作为额外的 key-value 插入到模型层中。
- 对于 decoder-only 模型，需要通过修改注意力实现，将 chunk 的 key-value 拼接到序列的 key-value 之前，并确保因果掩码正确（chunk 部分为完整的上下文，不限制 token 对它的注意力）。
- 更轻量做法：将 chunk 的 key-value 存储为 FP16，生成时直接 load 到显存，与输入序列的 key-value 拼接。

```python
def generate_with_chunks(query_ids, chunk_keys_list, chunk_values_list):
    inputs_embeds = model.get_input_embeddings()(query_ids)
    # 自定义 attention forward，在各层将 chunk 的 k,v 拼接到开头
    # 这部分需要修改 transformers 源码或使用 Hook
    outputs = model.generate(inputs_embeds=inputs_embeds, max_new_tokens=50, ...)
    return tokenizer.decode(outputs[0])
```

---

## 5. 分阶段实施建议

### 阶段一：验证可行性（无训练）
- 直接用一行代码把 retrieval token 用已有的 prompt token（比如固定句式）代替，手动选取 top-k 文档。
- 验证“编码一次，生成时复用”是否节省时间，检查拼接后的生成质量。

### 阶段二：加入 retrieval token 学习
- 准备一个小型标注数据集（问题 + oracle 证据 chunk），按 4.3 训练 retrieval token（仅嵌入向量），用 MaxSim 选 top-n。
- 观察检索召回率是否超过你现有的 embed+rerank 方案。

### 阶段三：完整闭环
- 实现生成时直接使用选中 chunk 的隐藏状态，跳过文档 tokenization 和重复编码。
- 评估端到端准确率和推理速度。

---

## 6. 资源估算与优化
- **存储**：假设每个 chunk 512 tokens，hidden_dim=4096，8-bit 量化后每个 chunk 约占 512×4096×2 ≈ 4MB。1 万文档（500 万 token）约需 40GB 存储，对于企业级应用是可接受的。
- **检索速度**：第一次前向（query+retrieval tokens）后，对所有 chunk 计算的 MaxSim 是矩阵乘法，可用分段加载或离线索引加速（例如预先按 [CLS] token 做粗筛）。
- **训练成本**：仅更新十几个 token 的嵌入，在单卡上几十分钟即可收敛。

---

## 7. 为什么你的旧方案不如这个？
- 旧方案中，embedding 是基于静态的句子级表示，rerank 只是微调了排序，但最终生成时文档依然被模型“重新理解”，多跳时的信息拼装能力弱。
- 新方案中，检索打分直接发生在生成器将来要使用的同一个 token 级表示空间中，模型能用自己的注意力感知到“还需要找什么”，多跳需求自然体现在一次检索中。

---

## 8. 小贴士
- 如果不想修改注意力实现，也可以把选中的 token 序列直接拼成文本，用传统方式生成，但这样就折损了“状态复用”的优势。可先测试文本拼接与状态拼接的效果差距，若差距不大，可能说明你的任务对表示一致性要求不高。
- 尽量使用支持长上下文的模型（如 32k），避免拼接过多 chunk 超限。
- 可以从 INTRA 的开源替代（如果有社区复现）参考代码，不过现在 DIY 也是完全可行的。

---

**这份升级指南的核心就一句话：把“检索-重排-重新编码”变成“用注意力直接挑 token，挑完直接当记忆用”。** 你已经踩在了正确的方向上，按住这个思路落地，大概率能突破当前瓶颈。
