// VSCode mock for Vitest tests
import { vi } from 'vitest'

const mockDisposable = { dispose: vi.fn() }

export const workspace = {
	createFileSystemWatcher: vi.fn(() => ({
		onDidCreate: vi.fn(() => mockDisposable),
		onDidChange: vi.fn(() => mockDisposable),
		onDidDelete: vi.fn(() => mockDisposable),
		dispose: vi.fn(),
	})),
}

export const RelativePattern = vi.fn().mockImplementation((base: any, pattern: any) => ({
	base,
	pattern,
}))

export default {
	workspace,
	RelativePattern,
}