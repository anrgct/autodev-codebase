import { AsyncDisposeAggregator, EventRelay, splitText, withLock } from "lifecycle-utils";
import { tokenizeInput } from "../utils/tokenizeInput.js";
import { resolveBeginningTokenToPrepend, resolveEndTokenToAppend } from "../utils/tokenizerUtils.js";
import { isRankingTemplateValid, parseRankingTemplate } from "../gguf/insights/GgufInsights.js";
/**
 * @see [Reranking Documents](https://node-llama-cpp.withcat.ai/guide/embedding#reranking) tutorial
 */
export class LlamaRankingContext {
    /** @internal */ _llamaContext;
    /** @internal */ _template;
    /** @internal */ _sequence;
    /** @internal */ _relevanceIndex;
    /** @internal */ _isTwoClassClassifier;
    /** @internal */ _disposeAggregator = new AsyncDisposeAggregator();
    onDispose = new EventRelay();
    constructor({ _llamaContext, _template, _relevanceIndex, _isTwoClassClassifier }) {
        this._llamaContext = _llamaContext;
        this._template = _template;
        this._relevanceIndex = _relevanceIndex ?? 0;
        this._isTwoClassClassifier = _isTwoClassClassifier ?? false;
        this._sequence = this._llamaContext.getSequence();
        this._disposeAggregator.add(this._llamaContext.onDispose.createListener(() => {
            void this._disposeAggregator.dispose();
        }));
        this._disposeAggregator.add(this.onDispose.dispatchEvent);
        this._disposeAggregator.add(async () => {
            await this._llamaContext.dispose();
        });
    }
    /**
     * Get the ranking score for a document for a query.
     *
     * A ranking score is a number between 0 and 1 representing the probability that the document is relevant to the query.
     * @returns a ranking score between 0 and 1 representing the probability that the document is relevant to the query.
     */
    async rank(query, document) {
        const resolvedInput = this._getEvaluationInput(query, document);
        if (resolvedInput.length > this._llamaContext.contextSize)
            throw new Error("The input length exceed the context size. " +
                `Try to increase the context size to at least ${resolvedInput.length + 1} ` +
                "or use another model that supports longer contexts.");
        return this._evaluateRankingForInput(resolvedInput);
    }
    /**
     * Get the ranking scores for all the given documents for a query.
     *
     * A ranking score is a number between 0 and 1 representing the probability that the document is relevant to the query.
     * @returns an array of ranking scores between 0 and 1 representing the probability that the document is relevant to the query.
     */
    async rankAll(query, documents) {
        const resolvedTokens = documents.map((document) => this._getEvaluationInput(query, document));
        const maxInputTokensLength = resolvedTokens.reduce((max, tokens) => Math.max(max, tokens.length), 0);
        if (maxInputTokensLength > this._llamaContext.contextSize)
            throw new Error("The input lengths of some of the given documents exceed the context size. " +
                `Try to increase the context size to at least ${maxInputTokensLength + 1} ` +
                "or use another model that supports longer contexts.");
        else if (resolvedTokens.length === 0)
            return [];
        return await Promise.all(resolvedTokens.map((tokens) => this._evaluateRankingForInput(tokens)));
    }
    /**
     * Get the ranking scores for all the given documents for a query and sort them by score from highest to lowest.
     *
     * A ranking score is a number between 0 and 1 representing the probability that the document is relevant to the query.
     */
    async rankAndSort(query, documents) {
        const scores = await this.rankAll(query, documents);
        return documents
            .map((document, index) => ({ document: document, score: scores[index] }))
            .sort((a, b) => b.score - a.score);
    }
    async dispose() {
        await this._disposeAggregator.dispose();
    }
    /** @hidden */
    [Symbol.asyncDispose]() {
        return this.dispose();
    }
    get disposed() {
        return this._llamaContext.disposed;
    }
    get model() {
        return this._llamaContext.model;
    }
    /** @internal */
    _getEvaluationInput(query, document) {
        if (this._template != null) {
            const resolvedInput = splitText(this._template, ["{{query}}", "{{document}}"])
                .flatMap((item) => {
                if (typeof item === "string")
                    return this._llamaContext.model.tokenize(item, true, "trimLeadingSpace");
                else if (item.separator === "{{query}}")
                    return tokenizeInput(query, this._llamaContext.model.tokenizer, "trimLeadingSpace", false);
                else if (item.separator === "{{document}}")
                    return tokenizeInput(document, this._llamaContext.model.tokenizer, "trimLeadingSpace", false);
                else
                    void item;
                void item;
                return [];
            });
            const beginningTokens = resolveBeginningTokenToPrepend(this.model.vocabularyType, this.model.tokens);
            const endToken = resolveEndTokenToAppend(this.model.vocabularyType, this.model.tokens);
            if (beginningTokens != null && resolvedInput.at(0) !== beginningTokens)
                resolvedInput.unshift(beginningTokens);
            if (endToken != null && resolvedInput.at(-1) !== endToken)
                resolvedInput.unshift(endToken);
            return resolvedInput;
        }
        if (this.model.tokens.eos == null && this.model.tokens.sep == null)
            throw new Error("Computing rankings is not supported for this model.");
        const resolvedQuery = tokenizeInput(query, this._llamaContext.model.tokenizer, "trimLeadingSpace", false);
        const resolvedDocument = tokenizeInput(document, this._llamaContext.model.tokenizer, "trimLeadingSpace", false);
        if (resolvedQuery.length === 0 && resolvedDocument.length === 0)
            return [];
        const resolvedInput = [
            ...(this.model.tokens.bos == null ? [] : [this.model.tokens.bos]),
            ...resolvedQuery,
            ...(this.model.tokens.eos == null ? [] : [this.model.tokens.eos]),
            ...(this.model.tokens.sep == null ? [] : [this.model.tokens.sep]),
            ...resolvedDocument,
            ...(this.model.tokens.eos == null ? [] : [this.model.tokens.eos])
        ];
        return resolvedInput;
    }
    /** @internal */
    _evaluateRankingForInput(input) {
        if (input.length === 0)
            return Promise.resolve(0);
        return withLock([this, "evaluate"], async () => {
            await this._sequence.eraseContextTokenRanges([{
                    start: 0,
                    end: this._sequence.nextTokenIndex
                }]);
            const iterator = this._sequence.evaluate(input, { _noSampling: true });
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (const token of iterator) {
                break; // only generate one token to get embeddings
            }
            // Reranker models come in two architectures:
            // 1. Two-class classifier (e.g., Qwen3-Reranker): C++ does cls_out projection + softmax,
            //    producing [P(label_0), P(label_1)] in [0,1] range summing to 1.
            //    We detect this by the presence of "classifier.output_labels" in GGUF metadata.
            // 2. Single regression output (e.g., bge-reranker-v2-m3): C++ does cls_out projection
            //    only, outputting a raw logit (can be negative). We apply sigmoid in JS.
            if (this._isTwoClassClassifier) {
                // Two-class classifier path (Qwen3-Reranker style)
                const nClsOut = 2;
                const embedding = this._llamaContext._ctx.getEmbedding(input.length, nClsOut);
                if (embedding.length < 2)
                    return 0;
                const probability = embedding[this._relevanceIndex]; // P(yes) = relevance score
                return Math.max(0, Math.min(1, probability));
            } else {
                // Single regression path (bge-reranker style)
                const embedding = this._llamaContext._ctx.getEmbedding(input.length, 1);
                if (embedding.length === 0)
                    return 0;
                const logit = embedding[0];
                const probability = logitToSigmoid(logit);
                return probability;
            }
        });
    }
    /** @internal */
    static async _create({ _model }, { contextSize, batchSize, threads = 6, createSignal, template, ignoreMemorySafetyChecks }) {
        const resolvedTemplate = template ?? parseRankingTemplate(_model.fileInfo.metadata?.tokenizer?.["chat_template.rerank"]);
        if (_model.tokens.eos == null && _model.tokens.sep == null) {
            if (!isRankingTemplateValid(resolvedTemplate)) {
                if (resolvedTemplate === _model.fileInfo.metadata?.tokenizer?.["chat_template.rerank"])
                    throw new Error("The model's builtin template is invalid. It must contain both {query} and {document} placeholders.");
                else
                    throw new Error("The provided template is invalid. It must contain both {{query}} and {{document}} placeholders.");
            }
            else if (resolvedTemplate == null)
                throw new Error("Computing rankings is not supported for this model.");
        }
        if (_model.fileInsights.hasEncoder && _model.fileInsights.hasDecoder)
            throw new Error("Computing rankings is not supported for encoder-decoder models.");
        if (!_model.fileInsights.supportsRanking)
            throw new Error("Computing rankings is not supported for this model.");
        const llamaContext = await _model.createContext({
            contextSize,
            batchSize,
            threads,
            createSignal,
            ignoreMemorySafetyChecks,
            _embeddings: true,
            _ranking: true
        });

        // Determine model architecture:
        // - Two-class classifier (Qwen3-Reranker): has "classifier.output_labels" in GGUF metadata.
        //   C++ does softmax, output is [P(no), P(yes)]. We find the "yes" index.
        // - Single regression (bge-reranker): no output_labels, C++ outputs raw logit.
        //   We apply sigmoid in JS (original behavior).
        let isTwoClassClassifier = false;
        let relevanceIndex = 0;
        try {
            const metadata = _model.fileInfo.metadata;
            const arch = metadata?.general?.architecture;
            const labels = arch ? (metadata)[arch]?.classifier?.output_labels : undefined;
            if (Array.isArray(labels) && labels.length > 0) {
                isTwoClassClassifier = true;
                const yesIdx = labels.indexOf('yes');
                if (yesIdx !== -1)
                    relevanceIndex = yesIdx;
            }
        } catch (_e) {
            // Fall back to single-regression mode if metadata is not accessible
        }

        return new LlamaRankingContext({
            _llamaContext: llamaContext,
            _template: resolvedTemplate,
            _relevanceIndex: relevanceIndex,
            _isTwoClassClassifier: isTwoClassClassifier
        });
    }
}
function logitToSigmoid(logit) {
    return 1 / (1 + Math.exp(-logit));
}
//# sourceMappingURL=LlamaRankingContext.js.map