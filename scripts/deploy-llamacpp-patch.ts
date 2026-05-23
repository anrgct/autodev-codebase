// Deploy patched llama-addon.node and its dependent .dylib files to node_modules.
// Called from postinstall after patch-package applies JS patches.
//
// The source-built .node links against .dylib shared libraries. The official
// @node-llama-cpp prebuilt package provides most of these, but ships libggml-cpu,
// libggml-blas, and libggml-metal as Mach-O bundles (.so) — which can't be dlopen'd
// by a shared library. We store just those 3 .dylib files alongside the patched .node.

import { existsSync, copyFileSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { platform, arch } from "process";

const PROJECT_ROOT = join(import.meta.dirname, "..");

// Map process.platform + arch to node-llama-cpp platform tag
function detectPlatformTag(): string {
    const isMetal = platform === "darwin";
    const suffix = isMetal ? "-metal" : "";

    switch (platform) {
        case "darwin":
            return arch === "arm64" ? "mac-arm64-metal" : "mac-x64";
        case "linux":
            return arch === "x64" ? "linux-x64" : arch === "arm64" ? "linux-arm64" : "";
        default:
            console.warn(`[deploy-llamacpp-patch] Unsupported platform: ${platform}-${arch}`);
            return "";
    }
}

const tag = detectPlatformTag();
if (!tag) {
    console.log("[deploy-llamacpp-patch] No patched binary for this platform, skipping.");
    process.exit(0);
}

const srcDir = join(PROJECT_ROOT, "vendor", "llama-addon", "binaries", tag);
if (!existsSync(srcDir)) {
    console.log(`[deploy-llamacpp-patch] Patched binary dir not found: ${srcDir}, skipping.`);
    process.exit(0);
}

// Target: node_modules/@node-llama-cpp/<platform>/bins/<platform>/
const destDir = join(
    PROJECT_ROOT,
    "node_modules",
    "@node-llama-cpp",
    tag,
    "bins",
    tag,
);

try {
    // Ensure localBuilds cache is removed so getLlama() doesn't load a stale
    // source-compiled binary that would take priority over our patched prebuilt.
    const localBuildsDir = join(
        PROJECT_ROOT, "node_modules", "node-llama-cpp", "llama", "localBuilds",
    );
    if (existsSync(localBuildsDir)) {
        rmSync(localBuildsDir, { recursive: true, force: true });
        console.log("[deploy-llamacpp-patch] Removed stale localBuilds cache");
    }

    mkdirSync(destDir, { recursive: true });

    // Files to deploy: llama-addon.node + the .dylib files our build produces
    // that differ from the .so bundles in the original prebuilt package.
    // (libggml-base.dylib, libggml.metal.*.dylib, libllama.metal.*.dylib
    // already exist in the target directory from the original prebuilt.)
    const files: string[] = ["llama-addon.node"];
    // Only deploy .dylib files from vendor that the original prebuilt lacks.
    // We use a fixed list so we don't accidentally overwrite prebuilt dylibs.
    const extraDylibs = ["libggml-cpu.dylib", "libggml-blas.dylib", "libggml-metal.dylib"];
    for (const dylib of extraDylibs) {
        if (existsSync(join(srcDir, dylib))) {
            files.push(dylib);
        }
    }

    // Source builds can encode a custom cmake-options hash in these dependency
    // names, e.g. libllama.metal.b8390.<hash>.dylib. Deploy them when present.
    for (const file of readdirSync(srcDir)) {
        if (
            /^libllama\.metal\..+\.dylib$/.test(file) ||
            /^libggml\.metal\..+\.dylib$/.test(file)
        ) {
            files.push(file);
        }
    }

    let copied = 0;
    for (const file of [...new Set(files)]) {
        const srcPath = join(srcDir, file);
        const destPath = join(destDir, file);
        copyFileSync(srcPath, destPath);
        copied++;
    }
    console.log(`[deploy-llamacpp-patch] Deployed ${copied} files to ${destDir}`);
} catch (err) {
    console.error(`[deploy-llamacpp-patch] Failed:`, err);
    process.exit(1);
}
