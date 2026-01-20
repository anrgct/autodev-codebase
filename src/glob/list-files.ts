import * as os from "os"
import * as fs from "fs"
import fg from 'fast-glob'
import { IPathUtils } from "../abstractions"
import { IWorkspace } from "../abstractions/workspace"
import { IGNORE_DIRS, HIDDEN_DIR_PATTERN } from "../ignore/default-dirs"

/**
 * List of directories that are typically large and should be ignored
 * when showing recursive file listings
 *
 * Combines the unified ignore configuration with:
 * - HIDDEN_DIR_PATTERN for hidden file/directory matching
 * - Additional path patterns specific to list-files (e.g., Java/Maven build paths)
 */
const DIRS_TO_IGNORE = [
	...IGNORE_DIRS,
	HIDDEN_DIR_PATTERN,  // Retain .* behavior for consistency
	"target/dependency",  // Java/Maven specific
	"build/dependencies", // Build variant
]

export interface ListFilesDependencies {
	pathUtils: IPathUtils
	fileSystem: IFileSystem
	workspace: IWorkspace  // Through workspace to get ignoreService
	fs?: any  // Optional custom filesystem adapter (e.g., memfs for testing)
}

// Re-export IFileSystem for use
interface IFileSystem {
	readFile(path: string): Promise<Uint8Array>
	writeFile(path: string, content: Uint8Array): Promise<void>
	exists(path: string): Promise<boolean>
	stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtime: number }>
	readdir(path: string): Promise<string[]>
	mkdir(path: string): Promise<void>
	delete(path: string): Promise<void>
}

/**
 * List files in a directory, with optional recursive traversal
 *
 * Uses fast-glob for efficient file enumeration and the unified IgnoreService
 * for proper gitignore semantics
 *
 * @param dirPath - Directory path to list files from
 * @param recursive - Whether to recursively list files in subdirectories
 * @param limit - Maximum number of files to return
 * @param deps - Dependencies including path utilities, file system, and workspace
 * @returns Tuple of [file paths array, whether the limit was reached]
 */
export async function listFiles(
	dirPath: string,
	recursive: boolean,
	limit: number,
	deps: ListFilesDependencies
): Promise<[string[], boolean]> {
	// Handle special directories
	const specialResult = await handleSpecialDirectories(dirPath, deps.pathUtils)

	if (specialResult) {
		return specialResult
	}

	// Get the ignore service
	const ignoreService = deps.workspace.getIgnoreService()
	await ignoreService.initialize()

	// Use fast-glob to list files and directories
	const pattern = recursive ? '**/*' : '*'

	// fast-glob configuration
	const entries = await fg(pattern, {
		cwd: dirPath,
		absolute: true,
		markDirectories: true,
		dot: true,  // Include hidden files
		onlyFiles: false,  // Include directories (for UI display)

		// Fast pruning: skip large directories (performance optimization)
		// This is the first layer of filtering - applies glob patterns only
		ignore: DIRS_TO_IGNORE.map(dir => `**/${dir}/**`),
		
		// Support custom filesystem adapter (e.g., memfs for testing)
		...(deps.fs && { fs: deps.fs }),
	})

	// Use the unified IgnoreService for precise filtering
	// This is the second layer - handles .gitignore complex rules
	// Convert Entry[] to string[] for filterFiles
	const filtered = ignoreService.filterFiles(entries.map(String))

	// Apply limit
	const limited = filtered.slice(0, limit)
	const hitLimit = filtered.length > limit

	return [limited, hitLimit]
}

/**
 * Handle special directories (root, home) that should not be fully listed
 */
async function handleSpecialDirectories(dirPath: string, pathUtils: IPathUtils): Promise<[string[], boolean] | null> {
	const absolutePath = pathUtils.resolve(dirPath)

	// Do not allow listing files in root directory
	const root = process.platform === "win32" ? absolutePath.split(/[/\\]/)[0] + "/" : "/"
	const isRoot = pathUtils.normalize(absolutePath) === pathUtils.normalize(root)
	if (isRoot) {
		return [[root], false]
	}

	// Do not allow listing files in home directory
	const homeDir = os.homedir()
	const isHomeDir = pathUtils.normalize(absolutePath) === pathUtils.normalize(homeDir)
	if (isHomeDir) {
		return [[homeDir], false]
	}

	return null
}
