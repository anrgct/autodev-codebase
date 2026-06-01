import { EventRelay } from "lifecycle-utils";
import { Token } from "../../types.js";
import { TokenMeter } from "../TokenMeter.js";
import { LlamaModel } from "../LlamaModel/LlamaModel.js";
import { GgmlType } from "../../gguf/types/GgufTensorInfoTypes.js";
import { ContextShiftOptions, ContextTokensDeleteRange, ControlledEvaluateIndexOutput, ControlledEvaluateInputItem, EvaluationPriority, SequenceEvaluateMetadataOptions, SequenceEvaluateOptions, SequenceEvaluateOutput } from "./types.js";
import { TokenPredictor } from "./TokenPredictor.js";
export declare const internalCheckpoints: {
    speculative: {
        name: string;
        maxCheckpoints: number;
    };
    chatSequenceStart: {
        name: string;
        maxCheckpoints: number;
    };
    chatGrammarEnd: {
        name: string;
        maxCheckpoints: number;
    };
};
export declare class LlamaContext {
    readonly onDispose: EventRelay<void>;
    private constructor();
    dispose(): Promise<void>;
    /** @hidden */
    [Symbol.asyncDispose](): Promise<void>;
    get disposed(): boolean;
    get model(): LlamaModel;
    get contextSize(): number;
    get batchSize(): number;
    get flashAttention(): boolean;
    get kvCacheKeyType(): GgmlType;
    get kvCacheValueType(): GgmlType;
    /**
     * The actual size of the state in the memory in bytes.
     * This value is provided by `llama.cpp` and doesn't include all the memory overhead of the context.
     */
    get stateSize(): number;
    /** The number of threads currently used to evaluate tokens */
    get currentThreads(): number;
    /**
     * The number of threads that are preferred to be used to evaluate tokens.
     *
     * The actual number of threads used may be lower when other evaluations are running in parallel.
     */
    get idealThreads(): number;
    getAllocatedContextSize(): number;
    get totalSequences(): number;
    get sequencesLeft(): number;
    /**
     * Before calling this method, make sure to call `sequencesLeft` to check if there are any sequences left.
     * When there are no sequences left, this method will throw an error.
     */
    getSequence(options?: {
        contextShift?: ContextShiftOptions;
        /**
         * Token predictor to use for the sequence.
         * Don't share the same token predictor between multiple sequences.
         *
         * Using a token predictor doesn't affect the generation output itself -
         * it only allows for greater parallelization of the token evaluation to speed up the generation.
         *
         * > **Note:** that if a token predictor is too resource intensive,
         * > it can slow down the generation process due to the overhead of running the predictor.
         * >
         * > Testing the effectiveness of a token predictor on the target machine is recommended before using it in production.
         *
         * Automatically disposed when disposing the sequence.
         * @see [Using Token Predictors](https://node-llama-cpp.withcat.ai/guide/token-prediction)
         */
        tokenPredictor?: TokenPredictor;
        /**
         * The maximum number of checkpoint to keep for the sequence when needed.
         *
         * When reusing a prefix evaluation state is not possible for the context sequence
         * (like in contexts from recurrent and hybrid models,
         * or with models that use SWA (Sliding Window Attention) when the `swaFullCache` option is not enabled on the context),
         * storing checkpoints allows reusing the context state at certain points in the sequence
         * to speed up the evaluation when erasing parts of the context state that come after those points.
         * Those checkpoints will automatically be used when trying to erase parts of the context state that
         * come after a checkpointed state, and be freed from memory when no longer relevant.
         *
         * Those checkpoints are relatively lightweight compared to saving the entire state,
         * but taking too many checkpoints can increase memory usage.
         * Checkpoints are stored in the RAM (not VRAM).
         *
         * See {@link LlamaContextSequence.takeCheckpoint} for more details on how checkpoints are taken and used.
         */
        checkpoints?: {
            /**
             * The maximum number of checkpoints to keep for the sequence when needed.
             *
             * Defaults to `32`.
             */
            max?: number;
            /**
             * Take a checkpoint every `interval` tokens when the sequence needs taking checkpoints.
             *
             * Defaults to `8192`.
             */
            interval?: number | false;
            /**
             * The maximum memory in bytes to use for checkpoints for the sequence when needed.
             *
             * When taking a checkpoint causes the checkpoints pool memory to exceed this value,
             * older checkpoints will be pruned until the total checkpoints memory usage is under this limit,
             * while ensuring that at least one checkpoint is kept.
             *
             * Defaults to `null` (no memory limit).
             */
            maxMemory?: number | null;
        };
    }): LlamaContextSequence;
    dispatchPendingBatch(): void;
    /**
     * Print the timings of token evaluation since that last print for this context.
     *
     * Requires the `performanceTracking` option to be enabled.
     *
     * > **Note:** it prints on the `LlamaLogLevel.info` level, so if you set the level of your `Llama` instance higher than that,
     * it won't print anything.
     */
    printTimings(): Promise<void>;
    /**
     * QRRanker: Get collected kq_soft_max attention tensor data for a specific layer.
     * Returns a Float32Array containing the attention weights, or undefined if not collected.
     * Layer index is 0-based.
     */
    getKqSoftMax(layer: number): Float32Array | undefined;
    /**
     * QRRanker: Get shape metadata of all collected kq_soft_max tensors.
     * Returns the tensor dimensions and list of layers that were collected.
     */
    getKqSoftMaxShape(): { nKv: number; nTokens: number; nHead: number; nLayers: number; layers: number[] };
    /**
     * QRRanker: Set query token range for slice-based kq_soft_max collection.
     * Must be called before decode. When set, cbEval only copies query token rows
     * instead of the full nTokens × nKv × nHead tensor, avoiding V8 ArrayBuffer 4GB limit.
     */
    setKqSoftMaxQueryRange(queryStart: number, queryEnd: number): void;
    /**
     * QRRanker: Set layer range for kq_soft_max tensor collection in cbEval.
     * Must be called before decode when using a model with a different number
     * of layers than the original QRRanker model (25 layers). Scales the QR head
     * layer range [17, 25) proportionally to the target model's total layers.
     * Default: start=17, end=25.
     */
    setKqSoftMaxLayerRange(layerStart: number, layerEnd: number): void;
}
export declare class LlamaContextSequence {
    readonly onDispose: EventRelay<void>;
    private constructor();
    dispose(): void;
    /** @hidden */
    [Symbol.dispose](): void;
    get disposed(): boolean;
    get context(): LlamaContext;
    get model(): LlamaModel;
    /** The maximum number of tokens that the sequence state can hold */
    get contextSize(): number;
    /** The index where the next evaluated token will be placed in the context */
    get nextTokenIndex(): number;
    /** The current context state tokens */
    get contextTokens(): Token[];
    get tokenMeter(): TokenMeter;
    /**
     * The token predictor used when creating this sequence.
     */
    get tokenPredictor(): TokenPredictor | undefined;
    /**
     * Get the index of the first token in the KV cache.
     *
     * If you remove any tokens from the state that come before this index,
     * no cached prefix tokens evaluation state will be used for the next evaluation.
     *
     * For example, if `stateCellsStartIndex` is `10` and you remove the range `{start: 11, end: 16}`
     * then the cached state for range `0-10` will be used in the next evaluation,
     * but if you remove the range `{start: 10, end: 16}` (or `{start: 9, end: 16}`) then the cached state will not be used at all
     * and will be re-evaluated in the next evaluation.
     *
     * This index can be greater than `0` only when SWA (Sliding Window Attention) is used (only on supported models).
     *
     * When SWA is used, this index will usually be `Math.max(-1, .nextTokenIndex - .model.fileInsights.swaSize)` or larger.
     *
     * When the KV cache is empty, this index will be `-1`.
     *
     * You can disable SWA by setting the `swaFullCache` option to `true` when creating a context.
     */
    get stateCellsStartIndex(): number;
    /**
     * Statistics of token predictions using the sequence's `tokenPredictor`.
     *
     * The statistics change only when token prediction is used in this sequence.
     *
     * `validated` + `refuted` = total number of evaluated predictions.
     *
     * Prefer using `validated` and `refuted` to evaluate the effectiveness of token prediction.
     */
    get tokenPredictions(): {
        /** Number of token predictions that were actually used (tokens that were validated and then consumed) */
        used: number;
        /** Number of token predictions that were not used (tokens that were validated and were not consumed) */
        unused: number;
        /** Number of token predictions that were validated successfully */
        validated: number;
        /** Number of token predictions that were refuted */
        refuted: number;
    };
    get isLoadedToMemory(): boolean;
    compareContextTokens(tokens: Token[]): {
        firstDifferentIndex: number;
    };
    /**
     * Erase parts of the context state to align it with the given tokens.
     *
     * If the given tokens do not align with the current context state, the context state will be erased to align with the given tokens.
     *
     * To find the first different token index between the context state and the given tokens, access the `nextTokenIndex` property.
     *
     * If `allowShift` is `true` (the default), shifting tokens may happen to align the context state with the given tokens,
     * which incurs token evaluation of the shifted tokens.
     */
    adaptStateToTokens(tokens: Token[], allowShift?: boolean): Promise<void>;
    /**
     * Clear the history of the sequence.
     */
    clearHistory(): Promise<void>;
    /**
     * Erase context tokens in the provided ranges to free up space for new tokens to be generated.
     * The start of each range is inclusive, and the end of each range is exclusive.
     * For example, the range `{start: 0, end: 1}` will remove the token at the `0` index only.
     */
    eraseContextTokenRanges(ranges: ContextTokensDeleteRange[]): Promise<void>;
    /**
     * Evaluate the provided tokens into the context sequence, and continue generating new tokens on iterator iterations.
     *
     * This method uses the token predictor (when provided) to generate new tokens faster.
     */
    evaluate(tokens: Token[], options?: SequenceEvaluateOptions): AsyncGenerator<Token, void, void | Token | Token[]>;
    /**
     * Like {@link evaluate `.evaluate(...)`}, but with additional metadata for each generated token.
     *
     * Configure the additional metadata options to choose which metadata to include.
     */
    evaluateWithMetadata<const Metadata extends SequenceEvaluateMetadataOptions>(tokens: Token[], metadata: Metadata, options?: SequenceEvaluateOptions): AsyncGenerator<SequenceEvaluateOutput<Metadata>, void, void | Token | Token[]>;
    /**
     * Evaluate the provided tokens into the context sequence without generating new tokens.
     */
    evaluateWithoutGeneratingNewTokens(tokens: Token[], options?: {
        /**
         * When a lot of tokens are queued for the next batch, more than the configured `batchSize`, the tokens for each sequence will be
         * evaluated based on the strategy chosen for the context.
         * By default, the `"maximumParallelism"` strategy is used, which will try to evaluate as many sequences in parallel as possible,
         * but at some point, it'll have to choose which sequences to evaluate more tokens of, so it'll prioritize the sequences with the
         * highest evaluation priority.
         * Also, a custom strategy can be used to prioritize the sequences differently, but generally, the higher the evaluation priority
         * is, the more likely and more tokens will be evaluated for that sequence in the next queued batch.
         */
        evaluationPriority?: EvaluationPriority;
        /** Override the sequence context shift options for this evaluation */
        contextShift?: ContextShiftOptions;
    }): Promise<void>;
    /**
     * Evaluate the provided tokens into the context sequence with custom options for each token.
     *
     * This method allows for more precise control of the generation process.
     *
     * A next token will be generated for a given token only if any of the `generateNext` options for it are used.
     *
     * To generate more tokens after this method finishes,
     * use it again with token(s) you selected to add to the context from the previous evaluation.
     *
     * This method doesn't use the token predictor (when provided) since it cannot predict which tokens are actually needed.
     * Use the `evaluate` method when you need to use token prediction.
     * @returns An array where for each token in the input array, there can be an output item at the same index in the output array.
     * For indexes that have no output, there won't be any value at the corresponding index in the output array.
     *
     * It's recommended to iterate from `0` up to the length of the input array to check the results in the output array.
     */
    controlledEvaluate(input: ControlledEvaluateInputItem[], options?: {
        /**
         * When a lot of tokens are queued for the next batch, more than the configured `batchSize`, the tokens for each sequence will be
         * evaluated based on the strategy chosen for the context.
         * By default, the `"maximumParallelism"` strategy is used, which will try to evaluate as many sequences in parallel as possible,
         * but at some point, it'll have to choose which sequences to evaluate more tokens of, so it'll prioritize the sequences with the
         * highest evaluation priority.
         * Also, a custom strategy can be used to prioritize the sequences differently, but generally, the higher the evaluation priority
         * is, the more likely and more tokens will be evaluated for that sequence in the next queued batch.
         */
        evaluationPriority?: EvaluationPriority;
        /** Override the sequence context shift options for this evaluation */
        contextShift?: ContextShiftOptions;
        /** Called on each token result after it's generated */
        onTokenResult?(inputTokenIndex: number, result: ControlledEvaluateIndexOutput): void;
    }): Promise<Array<undefined | ControlledEvaluateIndexOutput>>;
    /**
     * Save the current context sequence evaluation state to a file.
     * @see [Saving and restoring a context sequence evaluation state](https://node-llama-cpp.withcat.ai/guide/chat-session#save-and-restore-with-context-sequence-state)
     */
    saveStateToFile(filePath: string): Promise<{
        fileSize: number;
    }>;
    /**
     * Load a context sequence evaluation state from a file.
     *
     * Trying to load a state file with a longer context size than the current sequence's context size will fail and throw an error.
     *
     * You must ensure that the file was created from the exact same model, otherwise, using this function may crash the process.
     * @see [Saving and restoring a context sequence evaluation state](https://node-llama-cpp.withcat.ai/guide/chat-session#save-and-restore-with-context-sequence-state)
     */
    loadStateFromFile(filePath: string, acceptRisk: {
        /**
         * Loading a state file created using a different model may crash the process.
         *
         * You must accept this risk to use this feature.
         */
        acceptRisk: true;
    }): Promise<void>;
    /**
     * When reusing a prefix evaluation state is not possible for the current context sequence
     * (like in contexts from recurrent and hybrid models,
     * or with models that use SWA (Sliding Window Attention) when the `swaFullCache` option is not enabled on the context),
     * you can use this method to checkpoint the current context sequence state.
     * Those checkpoints will automatically be used when trying to erase parts of the context state that come after a checkpointed state,
     * and be freed from memory when no longer relevant.
     *
     * Those checkpoints are relatively lightweight compared to saving the entire state,
     * but taking too many checkpoints can increase memory usage.
     * Checkpoints are stored in the RAM (not VRAM).
     *
     * Calling this method on a context sequence from a model that natively supports prefix evaluation state reuse will have no effect.
     *
     * > **Note:** to check whether the current context sequence needs taking checkpoints,
     * > you can use the {@link needsCheckpoints `.needsCheckpoints`} property.
     */
    takeCheckpoint(): Promise<void>;
    /**
     * Whether the current context sequence needs taking checkpoints of the context state to be able to reuse
     * it as a prefix evaluation state in the future.
     *
     * See {@link takeCheckpoint `.takeCheckpoint()`} for more details.
     */
    get needsCheckpoints(): boolean;
    /**
     * The index of the last taken checkpoint that's available for prefix reuse
     */
    get lastCheckpointIndex(): number;
    /**
     * The total memory usage in bytes of all the checkpoints currently held for this context sequence
     */
    get checkpointsMemoryUsage(): number;
}
export declare function getDefaultContextBatchSize({ contextSize, sequences }: {
    contextSize: number;
    sequences: number;
}): number;
export declare function getDefaultContextSequences(): number;
export declare function getDefaultModelContextSize({ trainContextSize }: {
    trainContextSize?: number;
}): number;
