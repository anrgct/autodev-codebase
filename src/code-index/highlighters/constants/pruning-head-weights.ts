/**
 * Pruning Head weights for the semantic-highlight-bilingual-v1 model.
 *
 * Extracted from the original HuggingFace model and skipped during GGUF conversion.
 * The Pruning Head is a standard linear classifier ([1024] → [2] → softmax).
 *
 * Formula: logits = hidden @ W.T + b → softmax → probs[:, 1] = token keep probability
 *
 * These weights are version-locked to the GGUF model at:
 * open_provence_demo/output/gguf/semantic-highlight-bilingual-v1-Q8_0.gguf
 *
 * DO NOT EDIT - auto-generated from pruning_head_weight.npy and pruning_head_bias.npy
 */

/**
 * Decode a base64-encoded Float32Array
 */
function decodeFloat32Array(base64: string, expectedLength: number): Float32Array {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  if (bytes.length !== expectedLength * 4) {
    throw new Error(
      `Pruning head weight size mismatch: expected ${expectedLength * 4} bytes, got ${bytes.length}`,
    )
  }
  return new Float32Array(bytes.buffer)
}

// Base64-encoded float32 weights [2, 1024]
const _W_BASE64 =
  "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"

// Base64-encoded float32 bias [2]
const _B_BASE64 = "8AuJujoLiTo="

/** Pruning Head weight matrix [2, 1024] */
export const PRUNING_HEAD_WEIGHT = decodeFloat32Array(_W_BASE64, 2048)

/** Pruning Head bias vector [2] */
export const PRUNING_HEAD_BIAS = decodeFloat32Array(_B_BASE64, 2)
