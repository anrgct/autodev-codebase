#pragma once

#include <cstring>
#include <mutex>
#include <unordered_map>
#include <vector>

#include "llama.h"
#include "napi.h"
#include "addonGlobals.h"
#include "AddonSampler.h"

class AddonContext : public Napi::ObjectWrap<AddonContext> {
    public:
        AddonModel* model;
        llama_context_params context_params;
        llama_context* ctx;
        llama_batch batch;
        uint64_t batchMemorySize = 0;
        bool has_batch = false;
        int32_t batch_n_tokens = 0;
        int n_cur = 0;

        uint64_t loadedContextMemorySize = 0;
        bool contextLoaded = false;

        bool disposed = false;

        // ---- QRRanker: kq_soft_max attention tensor collection ----
        // Enable collection during decode (set via constructor option or SetCollectKqSoftMax)
        bool collectKqSoftMax = false;

        // Collected kq_soft_max data: layer_index -> float array
        // When query range is set, only stores query tokens (not full tensor).
        // Layout: [head][nQueryTokens][nKv] (row-major), nQueryTokens = nTokens when filtered.
        // When query range is unset (-1), stores the full tensor [head][nTokens][nKv].
        std::unordered_map<int, std::vector<float>> kqSoftMaxData;

        // Tensor shape metadata (set from first intercepted kq_soft_max tensor)
        int kqN_Kv = 0;
        int kqN_Tokens = 0;   // May be reduced to nQueryTokens when query range is set
        int kqN_Head = 0;

        // Query token range for slice-based collection (set before decode).
        // When set, cbEval only copies query token rows instead of the full tensor,
        // avoiding the V8 ArrayBuffer 4GB limit for long inputs.
        // See docs/plans/260523-qrranker-ubatch-overflow-fix.md
        int kqQueryStart = -1;
        int kqQueryEnd = -1;

        // Current JS decode batch start in absolute sequence token positions.
        // node-llama-cpp splits long inputs before llama_decode; AddToBatch gets
        // the true first token index, so cbEval should not infer it from tensor shape.
        int kqCurrentBatchTokenStart = 0;

        // Accumulated per-token embeddings across multiple JS decode batches.
        // Cleared by clearAccumulatedEmbeddings() at the start of each evaluate session.
        // Indexed by context position: _accEmbd[pos * _accEmbdDim .. (pos+1) * _accEmbdDim - 1].
        std::vector<float> _accEmbd;
        int32_t _accEmbdCount = 0;
        int32_t _accEmbdDim = 0;

        // C callback for llama_context_params.cb_eval (no NAPI dependency)
        static bool cbEval(ggml_tensor *t, bool ask, void *user_data);
        // ------------------------------------------------------------

        AddonContext(const Napi::CallbackInfo& info);
        ~AddonContext();

        void dispose();
        void disposeBatch();

        Napi::Value Init(const Napi::CallbackInfo& info);
        Napi::Value Dispose(const Napi::CallbackInfo& info);

        Napi::Value GetContextSize(const Napi::CallbackInfo& info);
        Napi::Value InitBatch(const Napi::CallbackInfo& info);
        Napi::Value DisposeBatch(const Napi::CallbackInfo& info);
        Napi::Value AddToBatch(const Napi::CallbackInfo& info);
        Napi::Value DisposeSequence(const Napi::CallbackInfo& info);
        Napi::Value RemoveTokenCellsFromSequence(const Napi::CallbackInfo& info);
        Napi::Value ShiftSequenceTokenCells(const Napi::CallbackInfo& info);
        Napi::Value GetSequenceKvCacheMinPosition(const Napi::CallbackInfo& info);
        Napi::Value GetSequenceKvCacheMaxPosition(const Napi::CallbackInfo& info);
        Napi::Value DecodeBatch(const Napi::CallbackInfo& info);
        Napi::Value SampleToken(const Napi::CallbackInfo& info);

        Napi::Value GetEmbedding(const Napi::CallbackInfo& info);
        Napi::Value ClearAccumulatedEmbeddings(const Napi::CallbackInfo& info);
        Napi::Value GetStateSize(const Napi::CallbackInfo& info);
        Napi::Value GetThreads(const Napi::CallbackInfo& info);
        Napi::Value SetThreads(const Napi::CallbackInfo& info);

        Napi::Value SaveSequenceStateToFile(const Napi::CallbackInfo& info);
        Napi::Value LoadSequenceStateFromFile(const Napi::CallbackInfo& info);

        Napi::Value PrintTimings(const Napi::CallbackInfo& info);
        Napi::Value EnsureDraftContextIsCompatibleForSpeculative(const Napi::CallbackInfo& info);

        Napi::Value SetLoras(const Napi::CallbackInfo& info);
        Napi::Value RestoreCheckpoint(const Napi::CallbackInfo& info);

        // QRRanker: kq_soft_max accessors
        Napi::Value GetKqSoftMax(const Napi::CallbackInfo& info);
        Napi::Value GetKqSoftMaxShape(const Napi::CallbackInfo& info);
        Napi::Value SetCollectKqSoftMax(const Napi::CallbackInfo& info);
        Napi::Value SetKqSoftMaxQueryRange(const Napi::CallbackInfo& info);

        static void init(Napi::Object exports);
};

class AddonContextSequenceCheckpoint : public Napi::ObjectWrap<AddonContextSequenceCheckpoint> {
    public:
        std::mutex dataMutex;
        std::vector<uint8_t> data;
        llama_seq_id sequenceId = 0;
        std::size_t minPos = 0;
        std::size_t maxPos = 0;

        AddonContextSequenceCheckpoint(const Napi::CallbackInfo& info);
        ~AddonContextSequenceCheckpoint();

        Napi::Value Init(const Napi::CallbackInfo& info);
        Napi::Value Dispose(const Napi::CallbackInfo& info);

        void dispose();

        Napi::Value GetSize(const Napi::CallbackInfo& info);
        Napi::Value GetMinPos(const Napi::CallbackInfo& info);
        Napi::Value GetMaxPos(const Napi::CallbackInfo& info);

        static void init(Napi::Object exports);
};
