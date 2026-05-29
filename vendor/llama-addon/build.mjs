// Build patched llama-addon.node from source.
//
// Two-pass compilation:
//   Pass 1: getLlama() → download llama.cpp + cmake compile
//   Pass 2: if llama.h lacks patch markers, patch source + cmake --build
//
// Usage: node vendor/llama-addon/build.mjs
//   or:  npm run build:llamacpp

import { execSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { arch, cpus, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---- Paths ----

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");
const LLAMA_DIR = join(PROJECT_ROOT, "node_modules/@realtimex/node-llama-cpp/llama");
const ADDON_SRC_DIR = join(LLAMA_DIR, "addon");
const LLAMA_CPP_DIR = join(LLAMA_DIR, "llama.cpp");
const PREBUILT_DIR = join(PROJECT_ROOT, "node_modules/@realtimex");
const PLATFORM_PKG_PREFIX = "node-llama-cpp-";

// ---- Platform detection (mirrors node-llama-cpp naming) ----

function detectPlatformTag() {
    const isMac = platform() === "darwin";
    const isLinux = platform() === "linux";

    if (isMac) {
        if (arch() === "arm64") return "mac-arm64-metal";
        if (arch() === "x64") return "mac-x64";
    }
    if (isLinux) {
        if (arch() === "x64") return "linux-x64";
        if (arch() === "arm64") return "linux-arm64";
    }

    console.error(`[build] ERROR: unsupported platform: ${platform()}-${arch()}`);
    process.exit(1);
}

function getParallelJobs() {
    try {
        return cpus().length;
    } catch {
        return 4;
    }
}

// ---- Helpers ----

function log(msg) {
    console.log(`[build] ${msg}`);
}

function findFiles(dir, pattern) {
    const results = [];
    if (!existsSync(dir)) return results;
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...findFiles(full, pattern));
            } else if (pattern.test(entry.name)) {
                results.push(full);
            }
        }
    } catch {
        // skip inaccessible dirs
    }
    return results;
}

function findFirst(dir, pattern) {
    return findFiles(dir, pattern)[0] ?? null;
}

// ---- Pre-pass: patch original AddonContext (fix upstream API changes) ----

function prePass_patchAddonContext() {
    const addonCpp = join(ADDON_SRC_DIR, "AddonContext.cpp");
    if (!existsSync(addonCpp)) {
        log("Pre-pass: AddonContext.cpp not found, skipping");
        return;
    }
    let c = readFileSync(addonCpp, "utf8");
    if (c.includes("cpu_get_num_math")) {
        log("Pre-pass: fixing cpu_get_num_math references (removed in newer llama.cpp)...");
        c = c.replace(/(common_)?cpu_get_num_math\(\)/g, "(int32_t)std::thread::hardware_concurrency()");
        writeFileSync(addonCpp, c);
        log("Pre-pass: AddonContext.cpp patched");
    } else {
        log("Pre-pass: AddonContext.cpp already patched, skipping");
    }
}

// ---- Pass 1: download + compile ----

async function pass1_downloadAndCompile() {
    log("Pass 1: downloading llama.cpp + compiling via node-llama-cpp...");
    prePass_patchAddonContext();
    const triggerPath = join(__dirname, "build-trigger.mjs");
    execSync(`node "${triggerPath}"`, {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
    });
}

// ---- Pass 2: patch + rebuild ----

function pass2_patchAndRebuild(tag) {
    const llamaHeader = join(LLAMA_CPP_DIR, "include", "llama.h");

    if (!existsSync(llamaHeader)) {
        log("Pass 2: llama.cpp source not found, skipping");
        return;
    }

    log("Pass 2: checking and patching headers...");

    // Patch 1: llama.h — add embd_layer to llama_context_params
    patchFile(
        join(LLAMA_CPP_DIR, "include", "llama.h"),
        "bool embeddings;  // if true, extract embeddings",
        "bool embeddings;  // if true, extract embeddings\n        int32_t embd_layer;  // -1 = last layer, 0..n_layer-1 = target layer",
    );

    // Patch 2: llama-cparams.h — add embd_layer to llama_cparams
    patchFile(
        join(LLAMA_CPP_DIR, "src", "llama-cparams.h"),
        "bool embeddings;",
        "bool embeddings;\n    int32_t embd_layer = -1;",
    );

    // Patch 3: llama-context.cpp — copy embd_layer in constructor
    patchFile(
        join(LLAMA_CPP_DIR, "src", "llama-context.cpp"),
        "    cparams.embeddings                  = params.embeddings;",
        "    cparams.embeddings                  = params.embeddings;\n    cparams.embd_layer                  = params.embd_layer;",
    );

    // Patch 4: llama-context.cpp — add embd_layer to default params
    patchFile(
        join(LLAMA_CPP_DIR, "src", "llama-context.cpp"),
        "/*.embeddings                  =*/ false,",
        "/*.embeddings                  =*/ false,\n        /*.embd_layer                  =*/ -1,",
    );

    log("Headers patched.");

    // Patch 5: model files — external script (adds mid-layer embd extraction)
    // Check if model files already have embd_layer support (from previous run)
    const checkModelFile = join(LLAMA_CPP_DIR, "src", "models", "gemma.cpp");
    const modelAlreadyPatched = existsSync(checkModelFile)
        ? readFileSync(checkModelFile, "utf8").includes("embd_layer")
        : false;

    if (modelAlreadyPatched) {
        log("Model files already have embd_layer support; skipping model patch script.");
    } else {
        const candidates = [
            join(PROJECT_ROOT, "..", "llama.cpp", "scripts", "add-midlayer-embd.py"),
            join(PROJECT_ROOT, "scripts", "add-midlayer-embd.py"),
        ];
        const patchScript = candidates.find((c) => existsSync(c));

        if (patchScript) {
            log("Running model patch script: " + patchScript);
            try {
                execSync('python3 "' + patchScript + '" --llamacpp-dir "' + LLAMA_CPP_DIR + '"', {
                    stdio: "inherit",
                });
            } catch {
                log("WARNING: model patch script failed (likely upstream changes). Models use default behavior.");
            }
        } else {
            log("WARNING: no model patch script found. Models will use default behavior.");
        }
    }

    log("Pass 2 complete.");
}

// Inline file patching: replace first occurrence of oldText with newText
function patchFile(filePath, oldText, newText) {
    if (!existsSync(filePath)) {
        log("  skip: " + filePath + " not found");
        return;
    }
    let c = readFileSync(filePath, "utf8");
    if (c.includes(newText)) {
        return; // already patched or natively supported
    }
    if (!c.includes(oldText)) {
        log("  WARNING: pattern not found in " + filePath + " — upstream may have changed");
        return;
    }
    c = c.replace(oldText, newText);
    writeFileSync(filePath, c);
    log("  patched: " + filePath);
}

// ---- Collect artifacts ----

function collectBinary(tag) {
    // Priority 1: platform-specific prebuilt dir
    const prebuiltBin = join(PREBUILT_DIR, PLATFORM_PKG_PREFIX + tag, "bins", tag, "llama-addon.node");
    if (existsSync(prebuiltBin)) return prebuiltBin;

    // Priority 2: localBuilds
    const localBuild = findFirst(
        join(LLAMA_DIR, "localBuilds"),
        /^llama-addon\.node$/,
    );
    if (localBuild) return localBuild;

    // Priority 3: anywhere under @realtimex/node-llama-cpp
    const fallback = findFirst(
        join(PROJECT_ROOT, "node_modules", "@realtimex", "node-llama-cpp"),
        /^llama-addon\.node$/,
    );
    if (fallback) return fallback;

    console.error("[build] ERROR: could not find compiled llama-addon.node");
    process.exit(1);
}

function collectDylibs(binaryPath, outputDir) {
    const binDir = join(dirname(binaryPath), "bin");
    const searchDirs = [binDir, dirname(binaryPath)];

    const seen = new Set();
    for (const dir of searchDirs) {
        if (!existsSync(dir)) continue;
        try {
            for (const entry of readdirSync(dir)) {
                if (!entry.endsWith(".dylib")) continue;
                if (seen.has(entry)) continue;
                seen.add(entry);
                copyFileSync(join(dir, entry), join(outputDir, entry));
                log(`Copied ${entry} to vendor`);
            }
        } catch {
            // skip
        }
    }
}

// ---- Main ----
// Build order matters: our patched AddonContext references fields (like embd_layer)
// that only exist in llama.h AFTER we patch it. So:
//   Pass 1: getLlama downloads + compiles with original AddonContext (from npm install)
//   Pass 2: patch llama.h + models, then copy patched AddonContext, then rebuild

async function main() {
    const tag = detectPlatformTag();
    log(`Platform: ${tag}`);

    // Remove prebuilt binary to force source compilation
    const prebuiltBin = join(PREBUILT_DIR, PLATFORM_PKG_PREFIX + tag, "bins", tag, "llama-addon.node");
    if (existsSync(prebuiltBin)) {
        log(`Removing prebuilt binary: ${prebuiltBin}`);
        rmSync(prebuiltBin);
    }

    // Clean build caches (before Pass 1 so getLlama starts fresh)
    for (const dir of [join(LLAMA_DIR, "build"), join(LLAMA_DIR, "localBuilds")]) {
        if (existsSync(dir)) {
            log(`Cleaning cache: ${dir}`);
            rmSync(dir, { recursive: true, force: true });
        }
    }

    // Pass 1: download + compile (uses ORIGINAL AddonContext from npm install)
    await pass1_downloadAndCompile();

    // Pass 2: patch llama.h + model files if needed
    pass2_patchAndRebuild(tag);

    // Now copy our patched AddonContext (llama.h now has embd_layer from Pass 2)
    log("Copying patched C++ files to node_modules...");
    copyFileSync(join(__dirname, "AddonContext.h"), join(ADDON_SRC_DIR, "AddonContext.h"));
    copyFileSync(join(__dirname, "AddonContext.cpp"), join(ADDON_SRC_DIR, "AddonContext.cpp"));
    log("Patched files copied.");

    // Rebuild to pick up patched AddonContext (incremental, uses existing cmake cache).
    // cmake-js puts build files inside localBuilds/<variant>/, not in a top-level build/.
    const localBuildsDir = join(LLAMA_DIR, "localBuilds");
    let buildDir = null;
    if (existsSync(localBuildsDir)) {
        // Find the build directory (contains build.ninja or CMakeCache.txt)
        for (const entry of readdirSync(localBuildsDir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                const candidate = join(localBuildsDir, entry.name);
                if (existsSync(join(candidate, "build.ninja")) ||
                    existsSync(join(candidate, "CMakeCache.txt"))) {
                    buildDir = candidate;
                    break;
                }
            }
        }
    }
    if (buildDir) {
        log("Rebuilding with patched AddonContext (incremental)...");
        const nproc = getParallelJobs();
        execSync(`cmake --build "${buildDir}" --config Release --parallel ${nproc}`, {
            stdio: "inherit",
        });
        log("Rebuild complete.");
    } else {
        log("WARNING: cmake build directory not found, skipping rebuild");
    }

    // Collect artifacts
    const binary = collectBinary(tag);
    log(`Found compiled binary: ${binary}`);

    const outputDir = join(__dirname, "binaries", tag);
    mkdirSync(outputDir, { recursive: true });
    copyFileSync(binary, join(outputDir, "llama-addon.node"));

    // Also copy build metadata (_nlcBuildMetadata.json) from the Release dir
    const binDir = dirname(binary);
    const metaSrc = join(binDir, "_nlcBuildMetadata.json");
    if (existsSync(metaSrc)) {
        copyFileSync(metaSrc, join(outputDir, "_nlcBuildMetadata.json"));
        log("Copied _nlcBuildMetadata.json to vendor");
    }

    const stats = statSync(join(outputDir, "llama-addon.node"));
    log(`Done! Binary copied to: ${join(outputDir, "llama-addon.node")} (${(stats.size / 1024).toFixed(1)} KB)`);

    collectDylibs(binary, outputDir);

    // Auto-deploy after build: copy vendor → node_modules loading paths
    try {
        const deployScript = join(__dirname, "../../scripts/deploy-llamacpp-patch.ts");
        if (existsSync(deployScript)) {
            log("Running deploy script...");
            execSync(`npx tsx "${deployScript}"`, { cwd: PROJECT_ROOT, stdio: "inherit" });
            log("Deploy complete.");
        } else {
            log("WARNING: deploy script not found, skipping auto-deploy");
        }
    } catch (err) {
        log("WARNING: auto-deploy failed: " + err.message);
    }
}

main().catch((err) => {
    console.error("[build] Failed:", err);
    process.exit(1);
});
