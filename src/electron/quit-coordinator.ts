export interface QuitDisposalInput {
  dispose(): Promise<void>;
  resumeQuit(): void;
  reportFailure(error: unknown): void;
}

export async function resumeQuitAfterDisposal(input: QuitDisposalInput): Promise<void> {
  try {
    await input.dispose();
  } catch (error) {
    input.reportFailure(error);
    return;
  }

  input.resumeQuit();
}
