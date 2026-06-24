#include <thread>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include "common/common.h"
#include "llama-vocab.h"
#include "llama.h"
#include "gguf.h"

#include "addonGlobals.h"
#include "AddonModel.h"
#include "AddonModelLora.h"
#include "AddonGrammarEvaluationState.h"
#include "AddonContext.h"

static uint64_t calculateBatchMemorySize(int32_t n_tokens_alloc, int32_t embd, int32_t n_seq_max) {
    uint64_t totalSize = 0;

    if (embd) {
        totalSize += sizeof(float) * n_tokens_alloc * embd;
    } else {
        totalSize += sizeof(llama_token) * n_tokens_alloc;
    }

    totalSize += sizeof(llama_pos) * n_tokens_alloc;
    totalSize += sizeof(int32_t) * n_tokens_alloc;
    totalSize += sizeof(llama_seq_id *) * (n_tokens_alloc + 1);

    totalSize += sizeof(llama_seq_id) * n_seq_max * n_tokens_alloc;

    totalSize += sizeof(int8_t) * n_tokens_alloc;

    return totalSize;
}

class AddonContextDecodeBatchWorker : public Napi::AsyncWorker {
    public:
        AddonContext* ctx;

        AddonContextDecodeBatchWorker(const Napi::Env& env, AddonContext* ctx)
            : Napi::AsyncWorker(env, "AddonContextDecodeBatchWorker"),
              ctx(ctx),
              deferred(Napi::Promise::Deferred::New(env)) {
            ctx->Ref();
        }
        ~AddonContextDecodeBatchWorker() {
            ctx->Unref();
        }

        Napi::Promise GetPromise() {
            return deferred.Promise();
        }

    protected:
        Napi::Promise::Deferred deferred;

        void Execute() {
            try {
                // Perform the evaluation using llama_decode.
                int r = llama_decode(ctx->ctx, ctx->batch);

                if (r != 0) {
                    if (r == 1) {
                        SetError("could not find a KV slot for the batch (try reducing the size of the batch or increase the context)");
                    } else {
                        SetError("Eval has failed");
                    }

                    return;
                }

                llama_synchronize(ctx->ctx);
            } catch (const std::exception& e) {
                SetError(e.what());
            } catch(...) {
                SetError("Unknown error when calling \"llama_decode\"");
            }
        }
        void OnOK() {
            // Accumulate per-token embeddings for all tokens in this batch.
            // The llama.cpp decode() patch extracts ALL token rows (not just
            // logits-enabled tokens) into embd.data when pooling_type is NONE.
            // We read the raw embd buffer and index by batch.pos[i] to map
            // batch token index to absolute context position.
            if (ctx->ctx != nullptr && ctx->model != nullptr && ctx->has_batch && ctx->batch.n_tokens > 0) {
                try {
                const auto pooling_type = llama_pooling_type(ctx->ctx);
                if (pooling_type == LLAMA_POOLING_TYPE_NONE) {
                    const int n_embd = llama_model_n_embd(ctx->model->model);
                    if (ctx->_accEmbdDim == 0) {
                        ctx->_accEmbdDim = n_embd;
                        ctx->_accEmbd.resize(llama_n_ctx(ctx->ctx) * n_embd, 0.0f);
                    }
                    // llama_get_embeddings_raw() returns embd.data which now contains
                    // all token rows in batch order (see llama-context.cpp decode() patch).
                    const float * embd_raw = llama_get_embeddings_raw(ctx->ctx);
                    if (embd_raw != nullptr) {
                        for (int32_t i = 0; i < ctx->batch.n_tokens; i++) {
                            const int32_t pos = ctx->batch.pos[i];
                            if (pos < 0 || pos >= llama_n_ctx(ctx->ctx)) continue;
                            memcpy(ctx->_accEmbd.data() + pos * n_embd, embd_raw + i * n_embd, n_embd * sizeof(float));
                            if (pos + 1 > ctx->_accEmbdCount) {
                                ctx->_accEmbdCount = pos + 1;
                            }
                        }
                    }
                }
                } catch (...) {
                    // Ignore accumulation errors — fall back to original GetEmbedding logic
                }
            }

            deferred.Resolve(Env().Undefined());
        }
        void OnError(const Napi::Error& err) {
            deferred.Reject(err.Value());
        }
};

class AddonContextLoadContextWorker : public Napi::AsyncWorker {
    public:
        AddonContext* context;

        AddonContextLoadContextWorker(const Napi::Env& env, AddonContext* context)
            : Napi::AsyncWorker(env, "AddonContextLoadContextWorker"),
              context(context),
              deferred(Napi::Promise::Deferred::New(env)) {
            context->Ref();
        }
        ~AddonContextLoadContextWorker() {
            context->Unref();
        }

        Napi::Promise GetPromise() {
            return deferred.Promise();
        }

    protected:
        Napi::Promise::Deferred deferred;

        void Execute() {
            try {
                context->ctx = llama_init_from_model(context->model->model, context->context_params);

                context->contextLoaded = context->ctx != nullptr && context->ctx != NULL;
            } catch (const std::exception& e) {
                SetError(e.what());
            } catch(...) {
                SetError("Unknown error when calling \"llama_init_from_model\"");
            }
        }
        void OnOK() {
            if (context->contextLoaded) {
                uint64_t contextMemorySize = llama_state_get_size(context->ctx);
                adjustNapiExternalMemoryAdd(Env(), contextMemorySize);
                context->loadedContextMemorySize = contextMemorySize;
            }

            deferred.Resolve(Napi::Boolean::New(Env(), context->contextLoaded));
        }
        void OnError(const Napi::Error& err) {
            deferred.Reject(err.Value());
        }
};
class AddonContextUnloadContextWorker : public Napi::AsyncWorker {
    public:
        AddonContext* context;

        AddonContextUnloadContextWorker(const Napi::Env& env, AddonContext* context)
            : Napi::AsyncWorker(env, "AddonContextUnloadContextWorker"),
              context(context),
              deferred(Napi::Promise::Deferred::New(env)) {
            context->Ref();
        }
        ~AddonContextUnloadContextWorker() {
            context->Unref();
        }

        Napi::Promise GetPromise() {
            return deferred.Promise();
        }

    protected:
        Napi::Promise::Deferred deferred;

        void Execute() {
            try {
                llama_free(context->ctx);
                context->contextLoaded = false;

                try {
                    if (context->has_batch) {
                        llama_batch_free(context->batch);
                        context->has_batch = false;
                        context->batch_n_tokens = 0;
                    }

                    context->dispose();
                } catch (const std::exception& e) {
                    SetError(e.what());
                } catch(...) {
                    SetError("Unknown error when calling \"llama_batch_free\"");
                }
            } catch (const std::exception& e) {
                SetError(e.what());
            } catch(...) {
                SetError("Unknown error when calling \"llama_free\"");
            }
        }
        void OnOK() {
            adjustNapiExternalMemorySubtract(Env(), context->loadedContextMemorySize);
            context->loadedContextMemorySize = 0;

            adjustNapiExternalMemorySubtract(Env(), context->batchMemorySize);
            context->batchMemorySize = 0;

            deferred.Resolve(Env().Undefined());
        }
        void OnError(const Napi::Error& err) {
            deferred.Reject(err.Value());
        }
};


class AddonContextSampleTokenWorker : public Napi::AsyncWorker {
    public:
        AddonContext* ctx;
        AddonSampler* sampler;
        bool arrayResult = false;
        bool returnProbabilities = false;
        bool returnConfidence = false;
        float tokenConfidence = -1;
        bool has_probabilities = false;
        size_t probabilities_size;
        llama_token * probabilities_tokens;
        float * probabilities_probs;
        int32_t batchLogitIndex;
        llama_token result;
        bool no_output = false;

        AddonContextSampleTokenWorker(const Napi::CallbackInfo& info, AddonContext* ctx)
            : Napi::AsyncWorker(info.Env(), "AddonContextSampleTokenWorker"),
              ctx(ctx),
              deferred(Napi::Promise::Deferred::New(info.Env())) {
            ctx->Ref();

            batchLogitIndex = info[0].As<Napi::Number>().Int32Value();
            sampler = Napi::ObjectWrap<AddonSampler>::Unwrap(info[1].As<Napi::Object>());
            arrayResult = info.Length() > 2 && info[2].IsBoolean();
            returnProbabilities = arrayResult ? info[2].As<Napi::Boolean>().Value() : false;
            returnConfidence = arrayResult && info.Length() > 3 && info[3].IsBoolean() ? info[3].As<Napi::Boolean>().Value() : false;
            sampler->Ref();
        }
        ~AddonContextSampleTokenWorker() {
            ctx->Unref();
            sampler->Unref();

            if (has_probabilities) {
                delete[] probabilities_tokens;
                delete[] probabilities_probs;
            }
        }

        Napi::Promise GetPromise() {
            return deferred.Promise();
        }

    protected:
        Napi::Promise::Deferred deferred;

        void Execute() {
            try {
                SampleToken();
            } catch (const std::exception& e) {
                SetError(e.what());
            } catch(...) {
                SetError("Unknown error when calling \"SampleToken\"");
            }
        }

        void SampleToken() {
            if (llama_get_logits(ctx->ctx) == nullptr) {
                SetError("This model does not support token generation");
                return;
            }

            sampler->rebuildChainIfNeeded();

            const auto * logits = llama_get_logits_ith(ctx->ctx, batchLogitIndex);
            const int n_vocab = llama_vocab_n_tokens(ctx->model->vocab);

            auto & candidates = sampler->tokenCandidates;
            for (llama_token token_id = 0; token_id < n_vocab; token_id++) {
                candidates[token_id] = llama_token_data{token_id, logits[token_id], 0.0f};
            }

            llama_token_data_array cur_p = {
                /* .data       = */ candidates.data(),
                /* .size       = */ candidates.size(),
                /* .selected   = */ -1,
                /* .sorted     = */ false,
            };

            llama_sampler_apply(sampler->chain, &cur_p);

            if (!(cur_p.selected >= 0 && cur_p.selected < (int32_t)cur_p.size)) {
                no_output = true;
                return;
            }

            auto new_token_id = cur_p.data[cur_p.selected].id;

            if (returnProbabilities || returnConfidence) {
                if (!cur_p.sorted) {
                    std::sort(cur_p.data, cur_p.data + cur_p.size, [](const llama_token_data & a, const llama_token_data & b) {
                        return a.logit > b.logit;
                    });
                    cur_p.sorted = true;

                    for (size_t i = 0; i < cur_p.size; i++) {
                        if (cur_p.data[i].id == new_token_id) {
                            cur_p.selected = i;
                            break;
                        }
                    }
                }
            }

            if (returnProbabilities) {
                probabilities_size = cur_p.size;
                probabilities_tokens = new llama_token[probabilities_size];
                probabilities_probs = new float[probabilities_size];
                float maxLogit = cur_p.size > 0 ? cur_p.data[0].logit : -INFINITY;

                for (size_t i = 0; i < cur_p.size; i++) {
                    auto logit = cur_p.data[i].logit;

                    probabilities_tokens[i] = cur_p.data[i].id;
                    probabilities_probs[i] = logit;

                    if (logit > maxLogit) {
                        maxLogit = logit;
                    }
                }

                if (probabilities_size > 0 && maxLogit != -INFINITY) {
                    float sum = 0.0f;
                    for (size_t i = 0; i < probabilities_size; i++) {
                        float prob = expf(probabilities_probs[i] - maxLogit);
                        probabilities_probs[i] = prob;
                        sum += prob;
                    }

                    for (size_t i = 0; i < probabilities_size; i++) {
                        probabilities_probs[i] /= sum;
                    }
                }

                has_probabilities = true;
            }

            if (returnConfidence) {
                if (has_probabilities && cur_p.selected < probabilities_size) {
                    tokenConfidence = probabilities_probs[cur_p.selected];
                } else {
                    float maxLogit = cur_p.data[0].logit;
                    float sum = 0.0f;
                    for (size_t i = 0; i < cur_p.size; i++) {
                        auto logit = cur_p.data[i].logit;

                        if (logit > maxLogit) {
                            maxLogit = logit;
                        }
                    }

                    for (size_t i = 0; i < cur_p.size; i++) {
                        sum += expf(cur_p.data[i].logit - maxLogit);
                    }

                    tokenConfidence = expf(cur_p.data[cur_p.selected].logit - maxLogit) / sum;
                }
            }

            try {
                sampler->acceptToken(new_token_id);
                result = new_token_id;
            } catch (const std::exception& e) {
                SetError(std::string("Failed to accept token in sampler: ") + e.what());
            } catch(...) {
                SetError("Unknown error when calling \"acceptToken\"");
            }
        }
        void OnOK() {
            Napi::Number resultToken;
            if (no_output) {
                resultToken = Napi::Number::New(Env(), -1);
            } else {
                resultToken = Napi::Number::New(Env(), static_cast<uint32_t>(result));
            }

            if (!arrayResult) {
                deferred.Resolve(resultToken);
                return;
            }

            Napi::Array resultArray = Napi::Array::New(Env(), 2);
            resultArray.Set(Napi::Number::New(Env(), 0), resultToken);

            if (has_probabilities) {
                Napi::Array probabilities = Napi::Array::New(Env(), probabilities_size * 2);
                for (size_t i = 0; i < probabilities_size; i++) {
                    probabilities.Set(i * 2, Napi::Number::New(Env(), probabilities_tokens[i]));
                    probabilities.Set(i * 2 + 1, Napi::Number::New(Env(), probabilities_probs[i]));
                }
                resultArray.Set(1, probabilities);
            }

            if (returnConfidence && tokenConfidence != -1) {
                resultArray.Set(2, Napi::Number::New(Env(), tokenConfidence));
            }

            deferred.Resolve(resultArray);
        }
        void OnError(const Napi::Error& err) {
            deferred.Reject(err.Value());
        }
};

AddonContext::AddonContext(const Napi::CallbackInfo& info) : Napi::ObjectWrap<AddonContext>(info) {
    model = Napi::ObjectWrap<AddonModel>::Unwrap(info[0].As<Napi::Object>());
    model->Ref();

    context_params = llama_context_default_params();
    context_params.n_ctx = 4096;
    context_params.n_threads = std::max((int32_t)std::thread::hardware_concurrency(), 1);
    context_params.n_threads_batch = context_params.n_threads;
    context_params.no_perf = true;
    context_params.swa_full = false;

    if (info.Length() > 1 && info[1].IsObject()) {
        Napi::Object options = info[1].As<Napi::Object>();

        if (options.Has("contextSize")) {
            context_params.n_ctx = options.Get("contextSize").As<Napi::Number>().Uint32Value();
        }

        if (options.Has("batchSize")) {
            context_params.n_batch = options.Get("batchSize").As<Napi::Number>().Uint32Value();
            context_params.n_ubatch = context_params.n_batch; // the batch queue is managed in the JS side, so there's no need for managing it on the C++ side
        }

        if (options.Has("sequences")) {
            context_params.n_seq_max = options.Get("sequences").As<Napi::Number>().Uint32Value();
        }

        if (options.Has("embeddings")) {
            context_params.embeddings = options.Get("embeddings").As<Napi::Boolean>().Value();
        }

        if (options.Has("embdLayer")) {
            context_params.embd_layer = options.Get("embdLayer").As<Napi::Number>().Int32Value();
        }

        if (options.Has("ranking") && options.Get("ranking").As<Napi::Boolean>().Value()) {
            context_params.pooling_type = LLAMA_POOLING_TYPE_RANK;
        }

        if (options.Has("flashAttention")) {
            bool flashAttention = options.Get("flashAttention").As<Napi::Boolean>().Value();
            context_params.flash_attn_type = flashAttention ? LLAMA_FLASH_ATTN_TYPE_ENABLED : LLAMA_FLASH_ATTN_TYPE_DISABLED;
        }

        if (options.Has("threads")) {
            const auto n_threads = options.Get("threads").As<Napi::Number>().Int32Value();
            const auto resolved_n_threads = n_threads == 0 ? std::max((int32_t)std::thread::hardware_concurrency(), context_params.n_threads) : n_threads;

            context_params.n_threads = resolved_n_threads;
            context_params.n_threads_batch = resolved_n_threads;
        }

        if (options.Has("performanceTracking")) {
            context_params.no_perf = !(options.Get("performanceTracking").As<Napi::Boolean>().Value());
        }

        if (options.Has("kvCacheKeyType") && options.Get("kvCacheKeyType").IsNumber()) {
            auto keyType = options.Get("kvCacheKeyType").As<Napi::Number>().Int32Value();
            if (keyType >= 0 && keyType < GGML_TYPE_COUNT) {
                context_params.type_k = static_cast<ggml_type>(keyType);
            }
        }

        if (options.Has("kvCacheValueType") && options.Get("kvCacheValueType").IsNumber()) {
            auto valueType = options.Get("kvCacheValueType").As<Napi::Number>().Int32Value();
            if (valueType >= 0 && valueType < GGML_TYPE_COUNT) {
                context_params.type_v = static_cast<ggml_type>(valueType);
            }
        }

        if (options.Has("swaFullCache")) {
            context_params.swa_full = options.Get("swaFullCache").As<Napi::Boolean>().Value();
        }

        if (options.Has("kvUnified")) {
            context_params.kv_unified = options.Get("kvUnified").As<Napi::Boolean>().Value();
        }

        // ---- QRRanker: kq_soft_max collection ----
        if (options.Has("collectKqSoftMax") && options.Get("collectKqSoftMax").As<Napi::Boolean>().Value()) {
            collectKqSoftMax = true;
            context_params.cb_eval = AddonContext::cbEval;
            context_params.cb_eval_user_data = this;
            // Force disable flash attention - fused ops don't expose kq_soft_max
            context_params.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;
        }
    }
}

// ---- QRRanker: cb_eval callback (no NAPI, called synchronously during llama_decode) ----
bool AddonContext::cbEval(ggml_tensor *t, bool ask, void *user_data) {
    auto *ctx = static_cast<AddonContext *>(user_data);

    if (!ctx->collectKqSoftMax) {
        return true;
    }

    // Only intercept kq_soft_max tensors
    if (std::strncmp(t->name, "kq_soft_max-", 12) != 0) {
        return true;
    }

    const int il = std::atoi(t->name + 12);
    // QRRanker only needs attention weights from the QR head layers.
    // Layer range is dynamically configurable via SetKqSoftMaxLayerRange.
    // Default: [17, 25) for original QRRanker model (25 layers, QR heads in 17-24).
    if (il < ctx->kqLayerStart || il >= ctx->kqLayerEnd) {
        return true;
    }

    if (ask) {
        // Update shape metadata: nKv reflects the full context width (consistent
        // across micro-batches), not per-micro-batch tensor width. This ensures
        // the JS side sees a single stable nKv and the buffer uses a uniform stride.
        // See docs/plans/260523-qrranker-ubatch-overflow-fix.md
        ctx->kqN_Kv = ctx->context_params.n_ctx;
        ctx->kqN_Tokens = (int)t->ne[1];
        ctx->kqN_Head = (int)t->ne[2];
        return true;
    }

    // ask == false: copy (or accumulate) data from backend to CPU
    const int n_head = (int)t->ne[2];
    const int n_tokens_mb = (int)t->ne[1];  // tokens in this micro-batch
    const int n_kv = (int)t->ne[0];
    const size_t float_size = sizeof(float);

    auto &buf = ctx->kqSoftMaxData[il];

    if (ctx->kqQueryStart >= 0 && ctx->kqQueryEnd > ctx->kqQueryStart) {
        // Slice + accumulate: only copy query token rows across micro-batches.
        // This avoids the V8 ArrayBuffer 4GB limit and supports multi-micro-batch eval.
        const int n_query = ctx->kqQueryEnd - ctx->kqQueryStart;
        const int batch_start = ctx->kqCurrentBatchTokenStart;
        const int mb_query_start = std::max(0, ctx->kqQueryStart - batch_start);
        const int mb_query_end   = std::min(n_tokens_mb, ctx->kqQueryEnd - batch_start);

        if (mb_query_start < mb_query_end) {
            // This micro-batch covers part of the query range
            const int n_query_in_mb = mb_query_end - mb_query_start;
            const int n_query_full   = ctx->kqQueryEnd - ctx->kqQueryStart;
            // Use the full context width as the consistent buffer stride
            // so that all micro-batches write to the same column layout.
            // The per-micro-batch tensor may have n_kv < buf_n_kv (grows as
            // more tokens are cached); we only copy n_kv actual KV positions
            // per row and leave the rest as the zero-initialized margin.
            const int buf_n_kv = ctx->kqN_Kv;

            // Initialize or resize buf for full query range with consistent stride
            if (buf.empty()) {
                buf.resize(n_head * n_query_full * buf_n_kv, 0.0f);
            }

            // Copy query rows from this micro-batch and accumulate into buf.
            // Copy row-by-row because the tensor's n_kv (t->ne[0]) may differ
            // from buf_n_kv across micro-batches.
            std::vector<float> tmp_head(n_query_in_mb * n_kv);
            for (int h = 0; h < n_head; h++) {
                // Read the entire [h, mb_query_start..mb_query_end, :] block
                const size_t src_offset = (size_t)h * t->nb[2] + (size_t)mb_query_start * t->nb[1];
                const size_t block_size = (size_t)n_query_in_mb * n_kv * float_size;
                ggml_backend_tensor_get(t, tmp_head.data(), src_offset, block_size);
                // Accumulate into buf (layout: [head][n_query_full][buf_n_kv])
                const int query_dst_start = batch_start + mb_query_start - ctx->kqQueryStart;
                for (int q = 0; q < n_query_in_mb; q++) {
                    const size_t dst_row = ((size_t)h * n_query_full + (size_t)(query_dst_start + q)) * buf_n_kv;
                    const size_t src_row = (size_t)q * n_kv;
                    for (int kv = 0; kv < n_kv; kv++) {
                        buf[dst_row + kv] += tmp_head[src_row + kv];
                    }
                }
            }
        }

        // Update shape: nTokens = nQueryTokens (same as before)
        ctx->kqN_Tokens = n_query;
        ctx->kqN_Head = n_head;
    } else {
        // Full tensor copy (backward compatible when query slicing is not enabled)
        const size_t nbytes = ggml_nbytes(t);
        buf.resize(nbytes / float_size);
        ggml_backend_tensor_get(t, buf.data(), 0, nbytes);
    }

    return true;
}

// ---- QRRanker: NAPI getters for collected kq_soft_max data ----
Napi::Value AddonContext::GetKqSoftMax(const Napi::CallbackInfo& info) {
    int layer = info[0].As<Napi::Number>().Int32Value();

    auto it = kqSoftMaxData.find(layer);
    if (it == kqSoftMaxData.end()) {
        return Env().Undefined();
    }

    const auto &data = it->second;
    Napi::Float32Array result = Napi::Float32Array::New(Env(), data.size());
    std::copy(data.begin(), data.end(), result.Data());
    return result;
}

Napi::Value AddonContext::GetKqSoftMaxShape(const Napi::CallbackInfo& info) {
    auto obj = Napi::Object::New(Env());
    obj.Set("nKv", Napi::Number::New(Env(), kqN_Kv));
    obj.Set("nTokens", Napi::Number::New(Env(), kqN_Tokens));
    obj.Set("nHead", Napi::Number::New(Env(), kqN_Head));
    obj.Set("nLayers", Napi::Number::New(Env(), (double)kqSoftMaxData.size()));

    auto layers = Napi::Array::New(Env());
    size_t idx = 0;
    for (const auto &[layer, _] : kqSoftMaxData) {
        layers[idx++] = Napi::Number::New(Env(), layer);
    }
    obj.Set("layers", layers);
    return obj;
}

Napi::Value AddonContext::SetCollectKqSoftMax(const Napi::CallbackInfo& info) {
    collectKqSoftMax = info[0].As<Napi::Boolean>().Value();
    return Env().Undefined();
}

Napi::Value AddonContext::SetKqSoftMaxQueryRange(const Napi::CallbackInfo& info) {
    kqQueryStart = info[0].As<Napi::Number>().Int32Value();
    kqQueryEnd = info[1].As<Napi::Number>().Int32Value();
    // Reset accumulation state for new decode
    kqCurrentBatchTokenStart = 0;
    kqSoftMaxData.clear();
    kqN_Kv = 0;
    kqN_Tokens = 0;
    kqN_Head = 0;
    return Env().Undefined();
}

Napi::Value AddonContext::SetKqSoftMaxLayerRange(const Napi::CallbackInfo& info) {
    kqLayerStart = info[0].As<Napi::Number>().Int32Value();
    kqLayerEnd = info[1].As<Napi::Number>().Int32Value();
    // Reset collected data since layer filter has changed
    kqCurrentBatchTokenStart = 0;
    kqSoftMaxData.clear();
    kqN_Kv = 0;
    kqN_Tokens = 0;
    kqN_Head = 0;
    return Env().Undefined();
}

AddonContext::~AddonContext() {
    dispose();
}

void AddonContext::dispose() {
    if (disposed) {
        return;
    }

    disposed = true;
    if (contextLoaded) {
        contextLoaded = false;
        llama_free(ctx);

        adjustNapiExternalMemorySubtract(Env(), loadedContextMemorySize);
        loadedContextMemorySize = 0;
    }

    model->Unref();

    disposeBatch();
}
void AddonContext::disposeBatch() {
    if (!has_batch) {
        return;
    }

    llama_batch_free(batch);
    has_batch = false;
    batch_n_tokens = 0;

    adjustNapiExternalMemorySubtract(Env(), batchMemorySize);
    batchMemorySize = 0;
}

Napi::Value AddonContext::Init(const Napi::CallbackInfo& info) {
    if (disposed) {
        Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    AddonContextLoadContextWorker* worker = new AddonContextLoadContextWorker(this->Env(), this);
    worker->Queue();
    return worker->GetPromise();
}
Napi::Value AddonContext::Dispose(const Napi::CallbackInfo& info) {
    if (disposed) {
        return info.Env().Undefined();
    }

    if (contextLoaded) {
        contextLoaded = false;

        AddonContextUnloadContextWorker* worker = new AddonContextUnloadContextWorker(this->Env(), this);
        worker->Queue();
        return worker->GetPromise();
    } else {
        dispose();

        Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(info.Env());
        deferred.Resolve(info.Env().Undefined());
        return deferred.Promise();
    }
}

Napi::Value AddonContext::GetContextSize(const Napi::CallbackInfo& info) {
    if (disposed) {
        Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    return Napi::Number::From(info.Env(), llama_n_ctx(ctx));
}
Napi::Value AddonContext::InitBatch(const Napi::CallbackInfo& info) {
    if (disposed) {
        Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    if (has_batch) {
        llama_batch_free(batch);
    }

    int32_t n_tokens = info[0].As<Napi::Number>().Int32Value();

    batch = llama_batch_init(n_tokens, 0, 1);
    has_batch = true;
    batch_n_tokens = n_tokens;

    uint64_t newBatchMemorySize = calculateBatchMemorySize(n_tokens, llama_model_n_embd(model->model), context_params.n_batch);
    if (newBatchMemorySize > batchMemorySize) {
        adjustNapiExternalMemoryAdd(Env(), newBatchMemorySize - batchMemorySize);
        batchMemorySize = newBatchMemorySize;
    } else if (newBatchMemorySize < batchMemorySize) {
        adjustNapiExternalMemorySubtract(Env(), batchMemorySize - newBatchMemorySize);
        batchMemorySize = newBatchMemorySize;
    }

    return info.Env().Undefined();
}
Napi::Value AddonContext::DisposeBatch(const Napi::CallbackInfo& info) {
    if (disposed) {
        Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    disposeBatch();

    return info.Env().Undefined();
}
Napi::Value AddonContext::AddToBatch(const Napi::CallbackInfo& info) {
    if (!has_batch) {
        Napi::Error::New(info.Env(), "No batch is initialized").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    int32_t sequenceId = info[0].As<Napi::Number>().Int32Value();
    int32_t firstTokenContextIndex = info[1].As<Napi::Number>().Int32Value();
    Napi::Uint32Array tokens = info[2].As<Napi::Uint32Array>();
    Napi::Uint32Array tokenLogitIndexes = info[3].As<Napi::Uint32Array>();

    if (collectKqSoftMax && batch.n_tokens == 0) {
        kqCurrentBatchTokenStart = firstTokenContextIndex;
    }

    auto tokensLength = tokens.ElementLength();
    auto tokenLogitIndexesLength = tokenLogitIndexes.ElementLength();
    GGML_ASSERT(batch.n_tokens + tokensLength <= batch_n_tokens);

    Napi::Uint32Array resLogitIndexes = Napi::Uint32Array::New(info.Env(), tokenLogitIndexesLength);

    for (size_t i = 0, l = 0; i < tokensLength; i++) {
        if (l < tokenLogitIndexesLength && l < tokenLogitIndexesLength && tokenLogitIndexes[l] == i) {
            common_batch_add(batch, static_cast<llama_token>(tokens[i]), firstTokenContextIndex + i, { sequenceId }, true);
            resLogitIndexes[l] = batch.n_tokens - 1;
            l++;
        } else {
            common_batch_add(batch, static_cast<llama_token>(tokens[i]), firstTokenContextIndex + i, { sequenceId }, false);
        }
    }

    	return resLogitIndexes;
    }
    Napi::Value AddonContext::InitBatchEmbd(const Napi::CallbackInfo& info) {
    	if (disposed) {
    		Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
    		return info.Env().Undefined();
    	}

    	if (has_batch) {
    		llama_batch_free(batch);
    	}

    	int32_t n_tokens = info[0].As<Napi::Number>().Int32Value();
    	int32_t n_embd = llama_model_n_embd(model->model);

    	batch = llama_batch_init(n_tokens, n_embd, 1);
    	has_batch = true;
    	batch_n_tokens = n_tokens;

    	uint64_t newBatchMemorySize = calculateBatchMemorySize(n_tokens, n_embd, context_params.n_batch);
    	if (newBatchMemorySize > batchMemorySize) {
    		adjustNapiExternalMemoryAdd(Env(), newBatchMemorySize - batchMemorySize);
    		batchMemorySize = newBatchMemorySize;
    	} else if (newBatchMemorySize < batchMemorySize) {
    		adjustNapiExternalMemorySubtract(Env(), batchMemorySize - newBatchMemorySize);
    		batchMemorySize = newBatchMemorySize;
    	}

    	return info.Env().Undefined();
    }
    Napi::Value AddonContext::AddToBatchEmbd(const Napi::CallbackInfo& info) {
    	if (!has_batch) {
    		Napi::Error::New(info.Env(), "No batch is initialized").ThrowAsJavaScriptException();
    		return info.Env().Undefined();
    	}

    	int32_t sequenceId = info[0].As<Napi::Number>().Int32Value();
    	int32_t firstPos = info[1].As<Napi::Number>().Int32Value();
    	Napi::Float32Array embdFlat = info[2].As<Napi::Float32Array>();
    	int32_t nTokens = info[3].As<Napi::Number>().Int32Value();
    	Napi::Uint32Array tokenLogitIndexes = info[4].As<Napi::Uint32Array>();

    	if (collectKqSoftMax && batch.n_tokens == 0) {
    		kqCurrentBatchTokenStart = firstPos;
    	}

    	int32_t n_embd = llama_model_n_embd(model->model);
    	size_t totalFloats = (size_t)nTokens * n_embd;
    	GGML_ASSERT(embdFlat.ElementLength() >= totalFloats);
    	GGML_ASSERT(batch.n_tokens + nTokens <= batch_n_tokens);

    	auto tokenLogitIndexesLength = tokenLogitIndexes.ElementLength();
    	Napi::Uint32Array resLogitIndexes = Napi::Uint32Array::New(info.Env(), tokenLogitIndexesLength);

    	size_t l = 0;
	for (int32_t i = 0; i < nTokens; i++) {
		// Copy embedding row from flat input to batch.embd
		size_t dstOffset = (size_t)(batch.n_tokens + i) * n_embd;
		size_t srcOffset = (size_t)i * n_embd;
		for (int32_t j = 0; j < n_embd; j++) {
			batch.embd[dstOffset + j] = embdFlat[srcOffset + j];
		}

		// Set position
		batch.pos[batch.n_tokens + i] = firstPos + i;

		// Set sequence ID (allocates 1-element array, llama_batch_free will free it)
		batch.seq_id[batch.n_tokens + i] = (llama_seq_id *)malloc(sizeof(llama_seq_id));
		batch.seq_id[batch.n_tokens + i][0] = sequenceId;
		batch.n_seq_id[batch.n_tokens + i] = 1;

		// Set logits flag
		bool wantLogit = false;
		if (l < tokenLogitIndexesLength && tokenLogitIndexes[l] == i) {
			wantLogit = true;
			resLogitIndexes[l] = batch.n_tokens + i;
			l++;
		}
		batch.logits[batch.n_tokens + i] = wantLogit;
	}

    	batch.n_tokens += nTokens;

    	return resLogitIndexes;
    }
    Napi::Value AddonContext::GetTokenEmbeddings(const Napi::CallbackInfo& info) {
	if (disposed) {
		Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
		return info.Env().Undefined();
	}

	Napi::Uint32Array tokenIds = info[0].As<Napi::Uint32Array>();
	uint32_t nTokens = tokenIds.ElementLength();
	int32_t n_embd = llama_model_n_embd(model->model);

	if (nTokens == 0) {
		return Napi::Float32Array::New(info.Env(), 0);
	}

	// Use gguf API for reliable file offset (avoids manual header parsing bugs)
	gguf_init_params ggufParams = { true, nullptr };
	gguf_context * gctx = gguf_init_from_file(model->modelPath.c_str(), ggufParams);
	if (!gctx) {
		Napi::Error::New(info.Env(), "Failed to parse GGUF file").ThrowAsJavaScriptException();
		return info.Env().Undefined();
	}

	int tensorIdx = gguf_find_tensor(gctx, "token_embd.weight");
	if (tensorIdx < 0) {
		gguf_free(gctx);
		Napi::Error::New(info.Env(), "token_embd.weight not found").ThrowAsJavaScriptException();
		return info.Env().Undefined();
	}

	// Reliable offsets from gguf API
	size_t dataOffset = gguf_get_data_offset(gctx);
	uint64_t foundOffset = gguf_get_tensor_offset(gctx, tensorIdx);
	uint32_t foundType = gguf_get_tensor_type(gctx, tensorIdx);

	// Manually parse tensor info for dimensions (gguf API doesn't expose ne[])
	// Re-open the file and seek past KV section to tensor info
	FILE * fp = fopen(model->modelPath.c_str(), "rb");
	if (!fp) { gguf_free(gctx); Napi::Error::New(info.Env(), "Failed to open GGUF").ThrowAsJavaScriptException(); return info.Env().Undefined(); }

	auto ru32 = [&]()->uint32_t{uint8_t b[4];fread(b,1,4,fp);return(uint32_t)b[0]|((uint32_t)b[1]<<8)|((uint32_t)b[2]<<16)|((uint32_t)b[3]<<24);};
	auto ru64 = [&]()->uint64_t{uint8_t b[8];fread(b,1,8,fp);return(uint64_t)b[0]|((uint64_t)b[1]<<8)|((uint64_t)b[2]<<16)|((uint64_t)b[3]<<24)|((uint64_t)b[4]<<32)|((uint64_t)b[5]<<40)|((uint64_t)b[6]<<48)|((uint64_t)b[7]<<56);};

	fseek(fp, 0, SEEK_SET);
	ru32(); ru32(); // magic, version
	uint64_t nTensors = ru64();
	uint64_t nKv = ru64();

	// Skip KV pairs (use extended sizes array for types up to 12)
	for (uint64_t i = 0; i < nKv; i++) {
		uint64_t kl = ru64(); fseek(fp, (long)kl, SEEK_CUR);
		uint32_t vt = ru32();
		if (vt == 9) {
			uint32_t et = ru32(); uint64_t ne = ru64();
			int esizes[] = {1,1,2,2,4,4,4,1,0,0,8,8,8}; // types 0-12
			int es = (et <= 12) ? esizes[et] : 4;
			if (et == 8) { for (uint64_t j = 0; j < ne; j++) { uint64_t sl = ru64(); fseek(fp, (long)sl, SEEK_CUR); } }
			else { fseek(fp, (long)(ne * es), SEEK_CUR); }
		} else if (vt == 8) {
			uint64_t sl = ru64(); fseek(fp, (long)sl, SEEK_CUR);
		} else {
			int vsizes[] = {1,1,2,2,4,4,4,1,0,0,8,8,8};
			int vs = (vt <= 12) ? vsizes[vt] : 4;
			fseek(fp, (long)vs, SEEK_CUR);
		}
	}

	// Scan tensor infos to find token_embd.weight dimensions
	int64_t foundNEmbd = 0, foundVocabSize = 0;
	for (uint64_t i = 0; i < nTensors; i++) {
		uint64_t nl = ru64();
		std::vector<char> nb(nl + 1);
		fread(nb.data(), 1, (size_t)nl, fp); nb[nl] = '\0';
		uint32_t nd = ru32();
		std::vector<uint64_t> dims(nd);
		for (uint32_t j = 0; j < nd; j++) dims[j] = ru64();
		ru32(); ru64(); // type, offset (already have from gguf API)
		if (strcmp(nb.data(), "token_embd.weight") == 0) {
			foundNEmbd = (int64_t)dims[0];
			foundVocabSize = (int64_t)dims[1];
			break;
		}
	}

	gguf_free(gctx);

	if (foundNEmbd == 0) {
		fclose(fp);
		Napi::Error::New(info.Env(), "token_embd.weight dimensions not found").ThrowAsJavaScriptException();
		return info.Env().Undefined();
	}

	// Determine row size based on tensor type
	size_t rowSizeBytes = 0;
	bool isF16 = false, isBF16 = false, isQ8_0 = false;
	const uint32_t QK8_0 = 32;

	switch (foundType) {
		case 0: // F32
			rowSizeBytes = (size_t)foundNEmbd * 4; break;
		case 1: // F16
			rowSizeBytes = (size_t)foundNEmbd * 2; isF16 = true; break;
		case 30: // BF16
			rowSizeBytes = (size_t)foundNEmbd * 2; isBF16 = true; break;
		case 8: // Q8_0
			rowSizeBytes = (size_t)(((foundNEmbd + 31) / 32) * 34); isQ8_0 = true; break;
		default:
			fclose(fp);
			Napi::Error::New(info.Env(), std::string("Unsupported token_embd.weight type (") + std::to_string(foundType) + ")").ThrowAsJavaScriptException();
			return info.Env().Undefined();
	}

	Napi::Float32Array result = Napi::Float32Array::New(info.Env(), nTokens * n_embd);

	// FP16 half → float
	auto fp16ToF32 = [](uint16_t h) -> float {
		int s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
		if (e == 0) return (float)s * powf(2.0f, -14.0f) * ((float)m / 1024.0f);
		if (e == 31) return m == 0 ? (float)s * INFINITY : NAN;
		return (float)s * powf(2.0f, (float)(e - 15)) * (1.0f + (float)m / 1024.0f);
	};

	// BF16 → float
	auto bf16ToF32 = [](uint16_t v) -> float {
		uint32_t b = ((uint32_t)v) << 16; float f; memcpy(&f, &b, sizeof(f)); return f;
	};

	std::vector<uint8_t> rowBuf(rowSizeBytes);
	for (uint32_t i = 0; i < nTokens; i++) {
		uint32_t tid = tokenIds[i];
		if ((int64_t)tid >= foundVocabSize) {
			for (int32_t j = 0; j < n_embd; j++) result[i * n_embd + j] = 0.0f;
			continue;
		}

		long fileOff = (long)dataOffset + (long)foundOffset + (long)((size_t)tid * rowSizeBytes);
		fseek(fp, fileOff, SEEK_SET);
		fread(rowBuf.data(), 1, rowSizeBytes, fp);

		int32_t copyLen = std::min(n_embd, (int32_t)foundNEmbd);

		if (isQ8_0) {
			int64_t bpr = (foundNEmbd + 31) / 32;
			for (int64_t blk = 0; blk < bpr; blk++) {
				size_t bo = (size_t)blk * 34;
				uint16_t sp = *(uint16_t*)(rowBuf.data() + bo);
				float scale = fp16ToF32(sp);  // try fp16 first; fall back to bf16 if NaN
				if (std::isnan(scale) || std::isinf(scale)) scale = bf16ToF32(sp);
				int8_t * qp = (int8_t*)(rowBuf.data() + bo + 2);
				int32_t bs = (int32_t)blk * 32;
				for (int32_t j = 0; j < 32 && (bs + j) < copyLen; j++)
					result[i * n_embd + bs + j] = (float)qp[j] * scale;
			}
		} else if (isF16) {
			uint16_t * p = (uint16_t*)rowBuf.data();
			for (int32_t j = 0; j < copyLen; j++) result[i * n_embd + j] = fp16ToF32(p[j]);
		} else if (isBF16) {
			uint16_t * p = (uint16_t*)rowBuf.data();
			for (int32_t j = 0; j < copyLen; j++) result[i * n_embd + j] = bf16ToF32(p[j]);
		} else {
			float * p = (float*)rowBuf.data();
			for (int32_t j = 0; j < copyLen; j++) result[i * n_embd + j] = p[j];
		}
		for (int32_t j = copyLen; j < n_embd; j++) result[i * n_embd + j] = 0.0f;
	}

	fclose(fp);
	return result;
}

Napi::Value AddonContext::DisposeSequence(const Napi::CallbackInfo& info) {
	if (disposed) {
		Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
		return info.Env().Undefined();
	}

	int32_t sequenceId = info[0].As<Napi::Number>().Int32Value();
	bool ok = llama_memory_seq_rm(llama_get_memory(ctx), sequenceId, -1, -1);
	if (!ok) {
		Napi::Error::New(info.Env(), "Failed to dispose sequence").ThrowAsJavaScriptException();
		return info.Env().Undefined();
	}
	return info.Env().Undefined();
}

Napi::Value AddonContext::RemoveTokenCellsFromSequence(const Napi::CallbackInfo& info) {
    if (disposed) {
        Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    int32_t sequenceId = info[0].As<Napi::Number>().Int32Value();
    int32_t startPos = info[1].As<Napi::Number>().Int32Value();
    int32_t endPos = info[2].As<Napi::Number>().Int32Value();

    bool result = llama_memory_seq_rm(llama_get_memory(ctx), sequenceId, startPos, endPos);

    return Napi::Boolean::New(info.Env(), result);
}
Napi::Value AddonContext::ShiftSequenceTokenCells(const Napi::CallbackInfo& info) {
    if (disposed) {
        Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    int32_t sequenceId = info[0].As<Napi::Number>().Int32Value();
    int32_t startPos = info[1].As<Napi::Number>().Int32Value();
    int32_t endPos = info[2].As<Napi::Number>().Int32Value();
    int32_t shiftDelta = info[3].As<Napi::Number>().Int32Value();

    llama_memory_seq_add(llama_get_memory(ctx), sequenceId, startPos, endPos, shiftDelta);

    return info.Env().Undefined();
}
Napi::Value AddonContext::GetSequenceKvCacheMinPosition(const Napi::CallbackInfo& info) {
    if (disposed) {
        Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    int32_t sequenceId = info[0].As<Napi::Number>().Int32Value();


    const auto minPosition = llama_memory_seq_pos_min(llama_get_memory(ctx), sequenceId);

    return Napi::Number::New(info.Env(), minPosition);
}
Napi::Value AddonContext::GetSequenceKvCacheMaxPosition(const Napi::CallbackInfo& info) {
    if (disposed) {
        Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    int32_t sequenceId = info[0].As<Napi::Number>().Int32Value();


    const auto maxPosition = llama_memory_seq_pos_max(llama_get_memory(ctx), sequenceId);

    return Napi::Number::New(info.Env(), maxPosition);
}
Napi::Value AddonContext::DecodeBatch(const Napi::CallbackInfo& info) {
    AddonContextDecodeBatchWorker* worker = new AddonContextDecodeBatchWorker(info.Env(), this);
    worker->Queue();
    return worker->GetPromise();
}
Napi::Value AddonContext::SampleToken(const Napi::CallbackInfo& info) {
    AddonContextSampleTokenWorker* worker = new AddonContextSampleTokenWorker(info, this);
    worker->Queue();
    return worker->GetPromise();
}

// Debug: dump raw logits at batch token index i. Returns Float32Array of n_vocab logits.
Napi::Value AddonContext::GetLogitsRow(const Napi::CallbackInfo& info) {
    if (disposed) {
        Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    int32_t batchTokenIndex = info[0].As<Napi::Number>().Int32Value();
    const int n_vocab = llama_vocab_n_tokens(model->vocab);
    const auto * logits = llama_get_logits_ith(ctx, batchTokenIndex);
    if (logits == nullptr) {
        Napi::Error::New(info.Env(), "llama_get_logits_ith returned null").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }
    Napi::Float32Array result = Napi::Float32Array::New(info.Env(), n_vocab);
    for (int i = 0; i < n_vocab; i++) {
        result[i] = logits[i];
    }
    return result;
}

Napi::Value AddonContext::GetEmbedding(const Napi::CallbackInfo& info) {
    if (disposed) {
        Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    int32_t inputTokensLength = info[0].As<Napi::Number>().Int32Value();
    int32_t maxVectorSize = (info.Length() > 1 && info[1].IsNumber()) ? info[1].As<Napi::Number>().Int32Value() : 0;

    if (inputTokensLength <= 0) {
        Napi::Error::New(info.Env(), "Invalid input tokens length").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    // Check accumulation buffer first (populated by DecodeBatch across multi-batch decodes).
    // The llama.cpp decode() patch ensures embd.data contains ALL token rows (not just
    // logits-enabled ones), and DecodeBatch::OnOK copies them to _accEmbd indexed by
    // context position (batch.pos[i]).
    if (!_accEmbd.empty() && inputTokensLength - 1 < _accEmbdCount) {
        const float * emb = _accEmbd.data() + (inputTokensLength - 1) * _accEmbdDim;
        size_t resultSize = maxVectorSize == 0 ? _accEmbdDim : std::min(_accEmbdDim, maxVectorSize);
        Napi::Float64Array result = Napi::Float64Array::New(info.Env(), resultSize);
        for (size_t i = 0; i < resultSize; i++) {
            result[i] = emb[i];
        }
        return result;
    }

    // Fall back to original logic (single-batch decode, or pooling_type != NONE)
    const int n_embd = llama_model_n_embd(model->model);
    const enum llama_pooling_type pooling_type = llama_pooling_type(ctx);
    const auto* embeddings = pooling_type == LLAMA_POOLING_TYPE_NONE ? NULL : llama_get_embeddings_seq(ctx, 0);
    if (embeddings == NULL) {
        embeddings = llama_get_embeddings_ith(ctx, inputTokensLength - 1);
    }

    if (embeddings == NULL) {
        Napi::Error::New(info.Env(), std::string("Failed to get embeddings for token ") + std::to_string(inputTokensLength - 1)).ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    size_t resultSize = maxVectorSize == 0 ? n_embd : std::min(n_embd, maxVectorSize);
    Napi::Float64Array result = Napi::Float64Array::New(info.Env(), resultSize);
    for (size_t i = 0; i < resultSize; i++) {
        result[i] = embeddings[i];
    }

    return result;
}

Napi::Value AddonContext::ClearAccumulatedEmbeddings(const Napi::CallbackInfo& info) {
    _accEmbd.clear();
    _accEmbdCount = 0;
    _accEmbdDim = 0;
    return info.Env().Undefined();
}

Napi::Value AddonContext::GetStateSize(const Napi::CallbackInfo& info) {
    if (disposed) {
        Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    return Napi::Number::From(info.Env(), llama_state_get_size(ctx));
}

Napi::Value AddonContext::GetThreads(const Napi::CallbackInfo& info) {
    if (disposed) {
        Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    return Napi::Number::From(info.Env(), llama_n_threads(ctx));
}

Napi::Value AddonContext::SetThreads(const Napi::CallbackInfo& info) {
    if (disposed) {
        Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    const auto threads = info[0].As<Napi::Number>().Int32Value();
    const auto resolvedThreads = threads == 0
        ? (int32_t)std::thread::hardware_concurrency()
        : threads;

    if (llama_n_threads(ctx) != resolvedThreads) {
        llama_set_n_threads(ctx, resolvedThreads, resolvedThreads);
    }

    return info.Env().Undefined();
}

class AddonContextSaveSequenceStateToFileWorker : public Napi::AsyncWorker {
    public:
        AddonContext* context;
        std::string filepath;
        llama_seq_id sequenceId;
        std::vector<llama_token> tokens;
        size_t savedFileSize = 0;

        AddonContextSaveSequenceStateToFileWorker(const Napi::CallbackInfo& info, AddonContext* context)
            : Napi::AsyncWorker(info.Env(), "AddonContextSaveSequenceStateToFileWorker"),
              context(context),
              deferred(Napi::Promise::Deferred::New(info.Env())) {
            context->Ref();

            filepath = info[0].As<Napi::String>().Utf8Value();
            sequenceId = info[1].As<Napi::Number>().Int32Value();
            Napi::Uint32Array inputTokens = info[2].As<Napi::Uint32Array>();

            tokens.resize(inputTokens.ElementLength());
            for (size_t i = 0; i < tokens.size(); i++) {
                tokens[i] = inputTokens[i];
            }
        }
        ~AddonContextSaveSequenceStateToFileWorker() {
            context->Unref();
        }

        Napi::Promise GetPromise() {
            return deferred.Promise();
        }

    protected:
        Napi::Promise::Deferred deferred;

        void Execute() {
            try {
                savedFileSize = llama_state_seq_save_file(context->ctx, filepath.c_str(), sequenceId, tokens.data(), tokens.size());
                if (savedFileSize == 0) {
                    SetError("Failed to save state to file");
                    return;
                }
            } catch (const std::exception& e) {
                SetError(e.what());
            } catch(...) {
                SetError("Unknown error when calling \"llama_state_seq_save_file\"");
            }
        }
        void OnOK() {
            deferred.Resolve(Napi::Number::New(Env(), savedFileSize));
        }
        void OnError(const Napi::Error& err) {
            deferred.Reject(err.Value());
        }
};
Napi::Value AddonContext::SaveSequenceStateToFile(const Napi::CallbackInfo& info) {
    if (disposed) {
        Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    AddonContextSaveSequenceStateToFileWorker* worker = new AddonContextSaveSequenceStateToFileWorker(info, this);
    worker->Queue();
    return worker->GetPromise();
}

class AddonContextLoadSequenceStateFromFileWorker : public Napi::AsyncWorker {
    public:
        AddonContext* context;
        std::string filepath;
        llama_seq_id sequenceId;
        size_t maxContextSize;
        std::vector<llama_token> tokens;

        AddonContextLoadSequenceStateFromFileWorker(const Napi::CallbackInfo& info, AddonContext* context)
            : Napi::AsyncWorker(info.Env(), "AddonContextLoadSequenceStateFromFileWorker"),
              context(context),
              deferred(Napi::Promise::Deferred::New(info.Env())) {
            context->Ref();

            filepath = info[0].As<Napi::String>().Utf8Value();
            sequenceId = info[1].As<Napi::Number>().Int32Value();
            maxContextSize = info[2].As<Napi::Number>().Uint32Value();

            tokens.resize(maxContextSize);
        }
        ~AddonContextLoadSequenceStateFromFileWorker() {
            context->Unref();
        }

        Napi::Promise GetPromise() {
            return deferred.Promise();
        }

    protected:
        Napi::Promise::Deferred deferred;

        void Execute() {
            try {
                size_t tokenCount = 0;
                const size_t fileSize = llama_state_seq_load_file(context->ctx, filepath.c_str(), sequenceId, tokens.data(), tokens.size(), &tokenCount);
                if (fileSize == 0) {
                    SetError("Failed to load state from file. Current context sequence size may be smaller that the state of the file");
                    return;
                }

                tokens.resize(tokenCount);
            } catch (const std::exception& e) {
                SetError(e.what());
            } catch(...) {
                SetError("Unknown error when calling \"llama_state_seq_load_file\"");
            }
        }
        void OnOK() {
            size_t tokenCount = tokens.size();
            Napi::Uint32Array result = Napi::Uint32Array::New(Env(), tokenCount);

            for (size_t i = 0; i < tokenCount; i++) {
                result[i] = tokens[i];
            }

            deferred.Resolve(result);
        }
        void OnError(const Napi::Error& err) {
            deferred.Reject(err.Value());
        }
};
Napi::Value AddonContext::LoadSequenceStateFromFile(const Napi::CallbackInfo& info) {
    if (disposed) {
        Napi::Error::New(info.Env(), "Context is disposed").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    AddonContextLoadSequenceStateFromFileWorker* worker = new AddonContextLoadSequenceStateFromFileWorker(info, this);
    worker->Queue();
    return worker->GetPromise();
}

Napi::Value AddonContext::PrintTimings(const Napi::CallbackInfo& info) {
    llama_perf_context_print(ctx);
    llama_perf_context_reset(ctx);
    return info.Env().Undefined();
}

Napi::Value AddonContext::EnsureDraftContextIsCompatibleForSpeculative(const Napi::CallbackInfo& info) {
    constexpr auto vocabSizeMaxDifference = 128; // SPEC_VOCAB_MAX_SIZE_DIFFERENCE
    constexpr auto vocabCheckStartTokenId = 5; // SPEC_VOCAB_CHECK_START_TOKEN_ID

    const AddonContext * draftContext = Napi::ObjectWrap<AddonContext>::Unwrap(info[0].As<Napi::Object>());
    const auto currentCtx = ctx;
    const auto draftCtx = draftContext->ctx;
    const auto currentModel = model->model;
    const auto draftModel = draftContext->model->model;
    const auto currentVocab = model->vocab;
    const auto draftVocab = draftContext->model->vocab;

    if (llama_vocab_type(currentVocab) != llama_vocab_type(draftVocab)) {
        Napi::Error::New(info.Env(), "Speculative draft model vocabulary type must match the target model vocabulary type").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    if (llama_vocab_get_add_bos(currentVocab) != llama_vocab_get_add_bos(draftVocab) ||
        llama_vocab_get_add_eos(currentVocab) != llama_vocab_get_add_eos(draftVocab) ||
        llama_vocab_bos(currentVocab) != llama_vocab_bos(draftVocab) ||
        llama_vocab_eos(currentVocab) != llama_vocab_eos(draftVocab)
    ) {
        Napi::Error::New(info.Env(), "Speculative draft model special tokens must match the target model special tokens").ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    const int currentModelVocabSize = llama_vocab_n_tokens(currentVocab);
    const int draftModelVocabSize = llama_vocab_n_tokens(draftVocab);

    const int vocabDiff = std::abs(currentModelVocabSize - draftModelVocabSize);

    if (vocabDiff > vocabSizeMaxDifference) {
        Napi::Error::New(
            info.Env(),
            std::string("Speculative draft model vocabulary must closely match the target model vocabulary size (vocabulary size difference: ") +
            std::to_string(vocabDiff) + std::string(", max allowed: ") + std::to_string(vocabSizeMaxDifference) + std::string(")")
        ).ThrowAsJavaScriptException();
        return info.Env().Undefined();
    }

    const int minVocabSize = std::min(currentModelVocabSize, draftModelVocabSize);
    for (int i = vocabCheckStartTokenId; i < minVocabSize; ++i) {
        const char * currentTokenText = llama_vocab_get_text(currentVocab, i);
        const char * draftTokenText = llama_vocab_get_text(draftVocab, i);
        if (std::strcmp(currentTokenText, draftTokenText) != 0) {
            Napi::Error::New(
                info.Env(),
                std::string("Speculative draft model vocabulary must match the target model vocabulary, but token ") +
                std::to_string(i) + std::string(" content differs. Target: \"") + std::string(currentTokenText) +
                std::string("\", Draft: \"") + std::string(draftTokenText) + std::string("")
            ).ThrowAsJavaScriptException();
            return info.Env().Undefined();
        }
    }

    return info.Env().Undefined();
}

Napi::Value AddonContext::SetLoras(const Napi::CallbackInfo& info) {
    Napi::Array loraArray = info[0].As<Napi::Array>();
    Napi::Array scaleArray = info[1].As<Napi::Array>();

    std::vector<llama_adapter_lora *> loras;
    std::vector<float> scales;

    loras.reserve(loraArray.Length());
    scales.reserve(scaleArray.Length());

    for (size_t i = 0; i < loraArray.Length() && i < scaleArray.Length(); i++) {
        AddonModelLora* lora = Napi::ObjectWrap<AddonModelLora>::Unwrap(loraArray.Get(i).As<Napi::Object>());
        float scale = scaleArray.Get(i).As<Napi::Number>().FloatValue();

        loras.push_back(lora->lora_adapter);
        scales.push_back(scale);
    }

    llama_set_adapters_lora(ctx, loras.data(), loras.size(), scales.data());

    return info.Env().Undefined();
}

class RestoreCheckpointWorker : public Napi::AsyncWorker {
    public:
        AddonContext* context;
        AddonContextSequenceCheckpoint* checkpoint;
        std::size_t maxPosIndex;
        bool restoreSuccess = false;

        RestoreCheckpointWorker(const Napi::CallbackInfo& info, AddonContext* context, AddonContextSequenceCheckpoint* checkpoint, std::size_t maxPosIndex)
            : Napi::AsyncWorker(info.Env(), "RestoreCheckpointWorker"),
              context(context),
              checkpoint(checkpoint),
              maxPosIndex(maxPosIndex),
              deferred(Napi::Promise::Deferred::New(info.Env())) {
            context->Ref();
            checkpoint->Ref();
        }
        ~RestoreCheckpointWorker() {
            context->Unref();
            checkpoint->Unref();
        }

        Napi::Promise GetPromise() {
            return deferred.Promise();
        }

    protected:
        Napi::Promise::Deferred deferred;

        void Execute() {
            try {
                std::lock_guard<std::mutex> lock(checkpoint->dataMutex);

                std::size_t dataSize = checkpoint->data.size();
                std::size_t restoreSize = llama_state_seq_set_data_ext(context->ctx, checkpoint->data.data(), dataSize, checkpoint->sequenceId, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY);
                if (restoreSize == dataSize) {
                    restoreSuccess = (
                        llama_memory_seq_rm(llama_get_memory(context->ctx), checkpoint->sequenceId, maxPosIndex + 1, -1) &&
                        llama_memory_seq_pos_max(llama_get_memory(context->ctx), checkpoint->sequenceId) == maxPosIndex
                    );
                }
            } catch (const std::exception& e) {
                SetError(e.what());
            } catch(...) {
                SetError("Unknown error when calling \"llama_state_seq_set_data_ext\"");
            }
        }
        void OnOK() {
            deferred.Resolve(Napi::Boolean::New(Env(), restoreSuccess));
        }
        void OnError(const Napi::Error& err) {
            deferred.Reject(err.Value());
        }
};

Napi::Value AddonContext::RestoreCheckpoint(const Napi::CallbackInfo& info) {
    AddonContextSequenceCheckpoint* checkpoint = Napi::ObjectWrap<AddonContextSequenceCheckpoint>::Unwrap(info[0].As<Napi::Object>());
    std::size_t maxPosIndex = info[1].As<Napi::Number>().Int32Value();

    RestoreCheckpointWorker* worker = new RestoreCheckpointWorker(info, this, checkpoint, maxPosIndex);
    worker->Queue();
    return worker->GetPromise();
}

void AddonContext::init(Napi::Object exports) {
    exports.Set(
        "AddonContext",
        DefineClass(
            exports.Env(),
            "AddonContext",
            {
                InstanceMethod("init", &AddonContext::Init),
                InstanceMethod("getContextSize", &AddonContext::GetContextSize),
     			InstanceMethod("initBatch", &AddonContext::InitBatch),
     			InstanceMethod("initBatchEmbd", &AddonContext::InitBatchEmbd),
     			InstanceMethod("addToBatch", &AddonContext::AddToBatch),
     			InstanceMethod("addToBatchEmbd", &AddonContext::AddToBatchEmbd),
     			InstanceMethod("getTokenEmbeddings", &AddonContext::GetTokenEmbeddings),
     			InstanceMethod("disposeSequence", &AddonContext::DisposeSequence),
                InstanceMethod("removeTokenCellsFromSequence", &AddonContext::RemoveTokenCellsFromSequence),
                InstanceMethod("shiftSequenceTokenCells", &AddonContext::ShiftSequenceTokenCells),
                InstanceMethod("getSequenceKvCacheMinPosition", &AddonContext::GetSequenceKvCacheMinPosition),
                InstanceMethod("getSequenceKvCacheMaxPosition", &AddonContext::GetSequenceKvCacheMaxPosition),
                InstanceMethod("decodeBatch", &AddonContext::DecodeBatch),
                InstanceMethod("sampleToken", &AddonContext::SampleToken),
                InstanceMethod("getLogitsRow", &AddonContext::GetLogitsRow),
                InstanceMethod("getEmbedding", &AddonContext::GetEmbedding),
                InstanceMethod("clearAccumulatedEmbeddings", &AddonContext::ClearAccumulatedEmbeddings),
                InstanceMethod("getStateSize", &AddonContext::GetStateSize),
                InstanceMethod("getThreads", &AddonContext::GetThreads),
                InstanceMethod("setThreads", &AddonContext::SetThreads),
                InstanceMethod("printTimings", &AddonContext::PrintTimings),
                InstanceMethod("ensureDraftContextIsCompatibleForSpeculative", &AddonContext::EnsureDraftContextIsCompatibleForSpeculative),
                InstanceMethod("saveSequenceStateToFile", &AddonContext::SaveSequenceStateToFile),
                InstanceMethod("loadSequenceStateFromFile", &AddonContext::LoadSequenceStateFromFile),
                InstanceMethod("setLoras", &AddonContext::SetLoras),
                InstanceMethod("restoreCheckpoint", &AddonContext::RestoreCheckpoint),
                InstanceMethod("dispose", &AddonContext::Dispose),
                // QRRanker: kq_soft_max accessors
                InstanceMethod("getKqSoftMax", &AddonContext::GetKqSoftMax),
                InstanceMethod("getKqSoftMaxShape", &AddonContext::GetKqSoftMaxShape),
                InstanceMethod("setCollectKqSoftMax", &AddonContext::SetCollectKqSoftMax),
                InstanceMethod("setKqSoftMaxQueryRange", &AddonContext::SetKqSoftMaxQueryRange),
                InstanceMethod("setKqSoftMaxLayerRange", &AddonContext::SetKqSoftMaxLayerRange),
            }
        )
    );
}

AddonContextSequenceCheckpoint::AddonContextSequenceCheckpoint(const Napi::CallbackInfo& info) : Napi::ObjectWrap<AddonContextSequenceCheckpoint>(info) {

}
AddonContextSequenceCheckpoint::~AddonContextSequenceCheckpoint() {
    dispose();
}

class AddonContextSequenceCheckpointInitWorker : public Napi::AsyncWorker {
    public:
    AddonContextSequenceCheckpoint* checkpoint;
        AddonContext* context;

        AddonContextSequenceCheckpointInitWorker(const Napi::CallbackInfo& info, AddonContextSequenceCheckpoint* checkpoint, AddonContext* context)
            : Napi::AsyncWorker(info.Env(), "AddonContextSequenceCheckpointInitWorker"),
            checkpoint(checkpoint),
              context(context),
              deferred(Napi::Promise::Deferred::New(info.Env())) {
            checkpoint->Ref();
            context->Ref();
        }
        ~AddonContextSequenceCheckpointInitWorker() {
            checkpoint->Unref();
            context->Unref();
        }

        Napi::Promise GetPromise() {
            return deferred.Promise();
        }

    protected:
        Napi::Promise::Deferred deferred;

        void Execute() {
            try {
                checkpoint->minPos = llama_memory_seq_pos_min(llama_get_memory(context->ctx), checkpoint->sequenceId);
                checkpoint->maxPos = llama_memory_seq_pos_max(llama_get_memory(context->ctx), checkpoint->sequenceId);
                const size_t checkpointSize = llama_state_seq_get_size_ext(context->ctx, checkpoint->sequenceId, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY);

                checkpoint->data.resize(checkpointSize, 0);
                llama_state_seq_get_data_ext(context->ctx, checkpoint->data.data(), checkpointSize, checkpoint->sequenceId, LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY);
            } catch (const std::exception& e) {
                SetError(e.what());
            } catch(...) {
                SetError("Unknown error when calling \"llama_state_seq_get_data_ext\"");
            }
        }
        void OnOK() {
            deferred.Resolve(Env().Undefined());
        }
        void OnError(const Napi::Error& err) {
            deferred.Reject(err.Value());
        }
};

Napi::Value AddonContextSequenceCheckpoint::Init(const Napi::CallbackInfo& info) {
    AddonContext * context = Napi::ObjectWrap<AddonContext>::Unwrap(info[0].As<Napi::Object>());
    sequenceId = info[1].As<Napi::Number>().Int32Value();

    AddonContextSequenceCheckpointInitWorker* worker = new AddonContextSequenceCheckpointInitWorker(info, this, context);
    worker->Queue();
    return worker->GetPromise();
}

Napi::Value AddonContextSequenceCheckpoint::Dispose(const Napi::CallbackInfo& info) {
    dispose();
    return info.Env().Undefined();
}

void AddonContextSequenceCheckpoint::dispose() {
    std::lock_guard<std::mutex> lock(dataMutex);
    data.clear();
    data.resize(0);
}

Napi::Value AddonContextSequenceCheckpoint::GetSize(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), data.size());
}

Napi::Value AddonContextSequenceCheckpoint::GetMinPos(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), minPos);
}

Napi::Value AddonContextSequenceCheckpoint::GetMaxPos(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), maxPos);
}

void AddonContextSequenceCheckpoint::init(Napi::Object exports) {
    exports.Set(
        "AddonContextSequenceCheckpoint",
        DefineClass(
            exports.Env(),
            "AddonContextSequenceCheckpoint",
            {
                InstanceMethod("init", &AddonContextSequenceCheckpoint::Init),
                InstanceMethod("dispose", &AddonContextSequenceCheckpoint::Dispose),

                InstanceAccessor("size", &AddonContextSequenceCheckpoint::GetSize, nullptr),
                InstanceAccessor("minPos", &AddonContextSequenceCheckpoint::GetMinPos, nullptr),
                InstanceAccessor("maxPos", &AddonContextSequenceCheckpoint::GetMaxPos, nullptr),
            }
        )
    );
}
