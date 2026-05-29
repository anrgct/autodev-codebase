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

    // Also copy the binary + metadata + dylibs to dist/bins/<tag>/ and
    // dist/bins/<folderName>/ paths.
    // 
    // Resolution logic in node-llama-cpp:
    //   getPrebuiltBinaryPath first checks dist/bins/<folderName>/, then platform-pkg/bins/<folderName>/
    //   By default (existingPrebuiltBinaryMustMatchBuildOptions=false), folderName = withoutCustomCmakeOptions = tag
    //   So it looks for: dist/bins/mac-arm64-metal/llama-addon.node
    const distBinsDir = join(
        PROJECT_ROOT, "node_modules", "@realtimex", "node-llama-cpp", "dist", "bins",
    );

    function copyAllToDir(srcDir: string, targetDir: string) {
        mkdirSync(targetDir, { recursive: true });
        const items: string[] = ["llama-addon.node", "_nlcBuildMetadata.json"];
        // Copy ALL dylibs (llama-addon.node needs libllama-common.dylib etc. at @rpath)
        if (existsSync(srcDir)) {
            for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
                if (entry.isFile() && entry.name.endsWith(".dylib")) {
                    items.push(entry.name);
                }
            }
        }
        let c = 0;
        for (const file of [...new Set(items)]) {
            const src = join(srcDir, file);
            if (!existsSync(src)) continue;
            copyFileSync(src, join(targetDir, file));
            c++;
        }
        return c;
    }

    // Priority 1 → dist/bins/<tag>/: checked FIRST by getPrebuiltBinaryPath -> resolvePrebuiltBinaryPath
    copyAllToDir(srcDir, join(distBinsDir, tag));
    console.log("[deploy] C++ layer: deployed to dist/bins/" + tag + "/");

    // Priority 2 → platform-pkg/bins/<tag>/: checked SECOND via getPrebuiltBinariesPackageDirectoryForBuildOptions
    copyAllToDir(srcDir, destDir);
    console.log("[deploy] C++ layer: deployed to " + destDir);
}

// ---- Main ----

try {
    deployJsLayer();
    deployCppLayer();
} catch (err) {
    console.error("[deploy] Failed:", err);
    process.exit(1);
}
