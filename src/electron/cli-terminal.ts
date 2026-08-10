import { spawn as spawnChild } from "node:child_process";
import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";

export interface CliTerminalLaunchInput {
  platform: NodeJS.Platform;
  appRoot: string;
  workspace: string;
  dataRoot: string;
  electronExecutable: string;
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
}

export interface CliTerminalLaunch {
  command: string;
  args: string[];
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: "ignore";
    detached: true;
    windowsHide?: boolean;
  };
}

interface CliTerminalChild {
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}

export interface CliTerminalLaunchDeps {
  spawn?: (
    command: string,
    args: readonly string[],
    options: CliTerminalLaunch["options"],
  ) => CliTerminalChild;
  reportError?: (error: Error) => void;
}

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertAbsolute(name: string, value: string, platform: NodeJS.Platform): void {
  const pathApi = platform === "win32" ? win32 : posix;
  if (!pathApi.isAbsolute(value)) throw new Error(`${name} must be absolute`);
}

export function buildCliTerminalLaunch(input: CliTerminalLaunchInput): CliTerminalLaunch {
  const pathApi = input.platform === "win32" ? win32 : posix;
  for (const [name, value] of [
    ["appRoot", input.appRoot],
    ["workspace", input.workspace],
    ["dataRoot", input.dataRoot],
    ["electronExecutable", input.electronExecutable],
  ] as const) {
    assertAbsolute(name, value, input.platform);
  }

  const entry = pathApi.join(
    input.appRoot,
    input.isPackaged ? "dist" : "src",
    "server",
    input.isPackaged ? "main.js" : "main.ts",
  );
  const loaderPath = input.isPackaged
    ? null
    : pathApi.join(input.appRoot, "node_modules", "tsx", "dist", "loader.mjs");
  const loader = loaderPath
    ? pathToFileURL(loaderPath, { windows: input.platform === "win32" }).href
    : null;
  const runtimeArgs = loader
    ? ["--import", loader, entry, "--cli"]
    : [entry, "--cli"];
  const env: NodeJS.ProcessEnv = {
    ...input.env,
    ELECTRON_RUN_AS_NODE: "1",
    PI_WORKSPACE: input.workspace,
    PI_DATA_ROOT: input.dataRoot,
  };
  const baseOptions = {
    cwd: input.workspace,
    env,
    stdio: "ignore" as const,
    detached: true as const,
  };

  if (input.platform === "win32") {
    env.MY_CODE_AGENT_CLI_EXECUTABLE = input.electronExecutable;
    env.MY_CODE_AGENT_CLI_ENTRY = entry;
    if (loader) env.MY_CODE_AGENT_CLI_LOADER = loader;
    const invocation = loader
      ? '"%MY_CODE_AGENT_CLI_EXECUTABLE%" --import "%MY_CODE_AGENT_CLI_LOADER%" "%MY_CODE_AGENT_CLI_ENTRY%" --cli'
      : '"%MY_CODE_AGENT_CLI_EXECUTABLE%" "%MY_CODE_AGENT_CLI_ENTRY%" --cli';
    return {
      command: input.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `start "" cmd.exe /d /k ${invocation}`],
      options: { ...baseOptions, windowsHide: true },
    };
  }

  if (input.platform === "darwin") {
    const terminalCommand = [
      "cd",
      "--",
      quotePosixShellArg(input.workspace),
      "&&",
      "exec",
      "env",
      quotePosixShellArg("ELECTRON_RUN_AS_NODE=1"),
      quotePosixShellArg(`PI_WORKSPACE=${input.workspace}`),
      quotePosixShellArg(`PI_DATA_ROOT=${input.dataRoot}`),
      quotePosixShellArg(input.electronExecutable),
      ...runtimeArgs.map(quotePosixShellArg),
    ].join(" ");
    const appleScript = `tell application "Terminal" to do script ${JSON.stringify(terminalCommand)}`;
    return {
      command: "osascript",
      args: ["-e", appleScript],
      options: baseOptions,
    };
  }

  return {
    command: "x-terminal-emulator",
    args: ["-e", input.electronExecutable, ...runtimeArgs],
    options: baseOptions,
  };
}

export function launchCliTerminal(
  launch: CliTerminalLaunch,
  dependencies: CliTerminalLaunchDeps = {},
): boolean {
  const spawn = dependencies.spawn || ((command, args, options) => (
    spawnChild(command, [...args], options)
  ));
  const reportError = dependencies.reportError || ((error) => {
    console.error("Failed to launch CLI terminal:", error);
  });

  try {
    const child = spawn(launch.command, launch.args, launch.options);
    child.once("error", reportError);
    child.unref();
    return true;
  } catch (error) {
    reportError(error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}
