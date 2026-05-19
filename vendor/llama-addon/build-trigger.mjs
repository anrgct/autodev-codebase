// Build helper: triggers node-llama-cpp source compilation via getLlama()
// Called by vendor/llama-addon/build.sh
import { getLlama, LlamaLogLevel } from "node-llama-cpp";

const llama = await getLlama({
    logLevel: LlamaLogLevel.warn,
    gpu: "metal",
    usePrebuiltBinaries: false,
    progressLogs: true,
});
console.log("[build] Compilation complete.");
