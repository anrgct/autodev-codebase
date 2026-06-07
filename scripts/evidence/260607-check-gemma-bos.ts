import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp";
async function main() {
  const llama = await getLlama({ logLevel: LlamaLogLevel.disabled });
  const model = await llama.loadModel({ modelPath: "/Users/anrgct/llm_models/unsloth/gemma-3-270m-it-GGUF/gemma-3-270m-it-F16.gguf" });
  const prompt = "<start_of_turn>user\nhello<end_of_turn>\n<start_of_turn>model\n";
  const tokens = model.tokenize(prompt);
  console.log("tokens:", tokens.map(Number).join(","));
  console.log("count:", tokens.length);
  console.log("bos token:", model.tokenize("<bos>").map(Number).join(","));
  console.log("detokenize:", model.detokenize(tokens).replace(/\n/g,"\\n"));
}
main();
