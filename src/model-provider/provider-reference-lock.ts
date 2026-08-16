import { withFileLock, type FileLockOptions } from "../data/file-lock.js";

/**
 * Global lock order for provider-reference mutations:
 * 1. provider reference mutation lock;
 * 2. AgentRuntime stable-session/transition lock;
 * 3. settings, subagent, or custom-provider store lock.
 */
export interface ProviderReferenceMutationLock {
  runExclusive<T>(callback: () => T | Promise<T>): Promise<T>;
}

export class FileProviderReferenceMutationLock implements ProviderReferenceMutationLock {
  constructor(
    private readonly lockFile: string,
    private readonly options: FileLockOptions = {},
  ) {}

  runExclusive<T>(callback: () => T | Promise<T>): Promise<T> {
    return withFileLock(this.lockFile, this.options, callback);
  }
}
