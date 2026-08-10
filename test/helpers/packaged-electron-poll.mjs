export function inspectPackagedE2EPoll({
  result,
  childExited,
  childExitCode,
  now,
  deadline,
  secondLaunchStarted,
}) {
  if (result && typeof result === "object" && typeof result.ok === "boolean") {
    return { kind: "result", result };
  }
  if (childExited) {
    return {
      kind: "process-exit",
      diagnostics: {
        state: result?.state || null,
        electronPid: Number.isInteger(result?.electronPid) ? result.electronPid : null,
        childExitCode: childExitCode ?? null,
      },
    };
  }
  if (now >= deadline) {
    return {
      kind: "timeout",
      diagnostics: {
        state: result?.state || null,
        electronPid: Number.isInteger(result?.electronPid) ? result.electronPid : null,
        childExitCode: childExitCode ?? null,
        secondLaunchStarted: !!secondLaunchStarted,
      },
    };
  }
  return null;
}
