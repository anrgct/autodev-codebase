// Build helper: triggers node-llama-cpp source compilation via getLlama()
// Called by vendor/llama-addon/build.sh
import { getLlama, LlamaLogLevel } from "@realtimex/node-llama-cpp";

const llama = await getLlama({
    logLevel: LlamaLogLevel.warn,
    gpu: "metal",
    usePrebuiltBinaries: false,
    cmakeOptions: {
        GGML_NATIVE: "OFF",
        GGML_CPU_ARM_ARCH: "armv8.6-a+dotprod+i8mm",
    },
    progressLogs: true,
});
console.log("[build] Compilation complete.");
