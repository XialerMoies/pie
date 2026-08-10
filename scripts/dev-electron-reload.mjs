export function runElectronBuild({ compileMain, compileBundles, onSuccess, onError }) {
  try {
    compileMain();
    compileBundles();
    onSuccess?.();
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}

export function createIntentionalProcessStops() {
  const processes = new WeakSet();
  return {
    mark(process) {
      processes.add(process);
    },
    consume(process) {
      const intentional = processes.has(process);
      processes.delete(process);
      return intentional;
    },
  };
}

export function handleElectronChildError({
  child,
  currentChild,
  error,
  clearCurrent,
  reportError,
  cleanup,
  exit,
}) {
  if (child !== currentChild) return false;
  clearCurrent();
  reportError(error);
  cleanup();
  exit(1);
  return true;
}

export function createElectronRebuildScheduler({
  buildElectron,
  restartElectron,
  onRebuild,
  delayMs = 150,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null;
  let pendingFile = null;

  return {
    schedule(file) {
      pendingFile = file;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        const changedFile = pendingFile;
        pendingFile = null;
        timer = null;
        onRebuild?.(changedFile);
        if (buildElectron()) restartElectron();
      }, delayMs);
    },
    dispose() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pendingFile = null;
    },
  };
}
