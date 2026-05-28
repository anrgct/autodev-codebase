// Deploy patched @realtimex/node-llama-cpp files to node_modules.
// Called from postinstall.
//
// Two layers:
//   1. JS/DTS files: overwrite from vendor/node-llama-cpp/dist/ (replaces patch-package)
//   2. C++ binaries: copy .node + .dylib from vendor/llama-addon/binaries/

import { existsSync, copyFileSync, mkdirSync, readdirSync, rmSync, readFileSync } from "fs";
import { join, dirname, relative } from "path";
import { platform, arch } from "process";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const PLATFORM_PKG_PREFIX = "node-llama-cpp-";

// ---- Platform detection ----

function detectPlatformTag(): string {
    switch (platform) {
        case "darwin":
            return arch === "arm64" ? "mac-arm64-metal" : "mac-x64";
        case "linux":
            return arch === "x64" ? "linux-x64" : arch === "arm64" ? "linux-arm64" : "";
        default:
            return "";
    }
}

// ---- Version check ----

function getInstalledVersion(): string | null {
    try {
        const pkgPath = join(PROJECT_ROOT, "node_modules", "@realtimex", "node-llama-cpp", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        return pkg.version ?? null;
    } catch {
        return null;
    }
}

function getBaseVersion(): string | null {
    const versionFile = join(PROJECT_ROOT, "vendor", "node-llama-cpp", ".version");
    if (!existsSync(versionFile)) return null;
    return readFileSync(versionFile, "utf8").trim();
}

// ---- JS/DTS file deployment ----

function deployJsLayer() {
    const srcRoot = join(PROJECT_ROOT, "vendor", "node-llama-cpp", "dist");
    if (!existsSync(srcRoot)) {
        console.log("[deploy] vendor/node-llama-cpp/dist/ not found, skipping JS layer");
        return;
    }

    const destRoot = join(PROJECT_ROOT, "node_modules", "@realtimex", "node-llama-cpp", "dist");

    // Version check
    const installed = getInstalledVersion();
    const base = getBaseVersion();
    if (installed && base && installed !== base) {
        console.warn(
            `[deploy] ⚠️  @realtimex/node-llama-cpp version mismatch!\n` +
            `  installed: ${installed}\n` +
            `  vendor baseline: ${base}\n` +
            `  JS files will still be deployed, but please review changes and update vendor/.version.`
        );
    }

    // Walk vendor/dist/ and copy each file to node_modules
    let count = 0;
    function walk(dir: string) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const src = join(dir, entry.name);
            const rel = relative(srcRoot, src);
            const dest = join(destRoot, rel);
            if (entry.isDirectory()) {
                mkdirSync(dest, { recursive: true });
                walk(src);
            } else {
                copyFileSync(src, dest);
                count++;
            }
        }
    }
    walk(srcRoot);
    console.log(`[deploy] JS/DTS layer: ${count} files deployed`);
}

// ---- C++ binary deployment ----

function deployCppLayer() {
    const tag = detectPlatformTag();
    if (!tag) {
        console.log("[deploy] C++ layer: unsupported platform, skipping");
        return;
    }

    const srcDir = join(PROJECT_ROOT, "vendor", "llama-addon", "binaries", tag);
    if (!existsSync(srcDir)) {
        console.log(`[deploy] C++ layer: ${srcDir} not found, skipping`);
        return;
    }

    const destDir = join(PROJECT_ROOT, "node_modules", "@realtimex", `${PLATFORM_PKG_PREFIX}${tag}`, "bins", tag);

    // Remove stale localBuilds (getLlama priority: localBuilds > prebuilt)
    const localBuildsDir = join(
        PROJECT_ROOT, "node_modules", "@realtimex", "node-llama-cpp", "llama", "localBuilds",
    );
    if (existsSync(localBuildsDir)) {
        rmSync(localBuildsDir, { recursive: true, force: true });
        console.log("[deploy] C++ layer: removed stale localBuilds cache");
    }

    mkdirSync(destDir, { recursive: true });

    const files: string[] = ["llama-addon.node"];

    // Extra dylibs that the official prebuilt ships as .so (Mach-O bundle),
    // which can't be dlopen'd by a shared library.
    for (const dylib of ["libggml-cpu.dylib", "libggml-blas.dylib", "libggml-metal.dylib"]) {
        if (existsSync(join(srcDir, dylib))) {
            files.push(dylib);
        }
    }

    // Hash-versioned dylibs (e.g. libllama.metal.b8390.2da1n284.dylib)
    for (const file of readdirSync(srcDir)) {
        if (/^libllama\.metal\..+\.dylib$/.test(file) ||
            /^libggml\.metal\..+\.dylib$/.test(file)) {
            files.push(file);
        }
    }

    let count = 0;
    for (const file of [...new Set(files)]) {
        copyFileSync(join(srcDir, file), join(destDir, file));
        count++;
    }
    console.log(`[deploy] C++ layer: ${count} files → ${destDir}`);
}

// ---- Main ----

try {
    deployJsLayer();
    deployCppLayer();
} catch (err) {
    console.error("[deploy] Failed:", err);
    process.exit(1);
}
