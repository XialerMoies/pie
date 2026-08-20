import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildCliTerminalLaunch,
  launchCliTerminal,
} from "../src/electron/cli-terminal.ts";

describe("CLI terminal launch", () => {
  it("uses the absolute app-owned loader and entry for development", () => {
    const appRoot = "/opt/My Code Agent";
    const workspace = "/home/user/untrusted workspace";
    const dataRoot = "/var/lib/my-code-agent";
    const executable = "/opt/My Code Agent/my-code-agent";

    const launch = buildCliTerminalLaunch({
      platform: "linux",
      appRoot,
      workspace,
      dataRoot,
      electronExecutable: executable,
      isPackaged: false,
      env: { PRESERVED_ENV: "yes" },
    });

    const loader = posix.join(appRoot, "node_modules", "tsx", "dist", "loader.mjs");
    const loaderUrl = pathToFileURL(loader, { windows: false }).href;
    const entry = posix.join(appRoot, "src", "server", "main.ts");
    assert.strictEqual(launch.command, "x-terminal-emulator");
    assert.deepStrictEqual(launch.args, ["-e", executable, "--import", loaderUrl, entry, "--cli"]);
    assert.ok(posix.isAbsolute(loader));
    assert.strictEqual(new URL(loaderUrl).protocol, "file:");
    assert.ok(posix.isAbsolute(entry));
    assert.ok(!launch.args.includes("npx"));
    assert.ok(!launch.args.includes("tsx"));
    assert.strictEqual(launch.options.cwd, workspace);
    assert.strictEqual(launch.options.env.PRESERVED_ENV, "yes");
    assert.strictEqual(launch.options.env.ELECTRON_RUN_AS_NODE, "1");
    assert.strictEqual(launch.options.env.PI_WORKSPACE, workspace);
    assert.strictEqual(launch.options.env.PI_DATA_ROOT, dataRoot);
    assert.strictEqual(launch.options.detached, true);
  });

  it("uses the compiled server entry without a tsx loader when packaged", () => {
    const appRoot = "/opt/MyCodeAgent/resources/app.asar";
    const executable = "/opt/MyCodeAgent/my-code-agent";
    const launch = buildCliTerminalLaunch({
      platform: "linux",
      appRoot,
      workspace: "/home/user/project",
      dataRoot: "/home/user/.my-code-agent",
      electronExecutable: executable,
      isPackaged: true,
      env: {},
    });

    assert.deepStrictEqual(launch.args, [
      "-e",
      executable,
      posix.join(appRoot, "dist", "server", "main.js"),
      "--cli",
    ]);
    assert.ok(!launch.args.includes("--import"));
    assert.ok(!launch.args.some((arg) => /tsx/i.test(arg)));
  });

  it("keeps the Windows workspace out of command text and inherits it through cwd and env", () => {
    const workspace = "C:\\Users\\user\\hostile & workspace";
    const dataRoot = "D:\\Agent Data";
    const appRoot = "C:\\Program Files\\My Code Agent\\resources\\app.asar";
    const executable = "C:\\Program Files\\My Code Agent\\MyCodeAgent.exe";
    const launch = buildCliTerminalLaunch({
      platform: "win32",
      appRoot,
      workspace,
      dataRoot,
      electronExecutable: executable,
      isPackaged: false,
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });

    assert.strictEqual(launch.command, "C:\\Windows\\System32\\cmd.exe");
    assert.strictEqual(launch.options.cwd, workspace);
    assert.strictEqual(launch.options.env.PI_WORKSPACE, workspace);
    assert.strictEqual(launch.options.env.PI_DATA_ROOT, dataRoot);
    assert.strictEqual(launch.options.env.MY_CODE_AGENT_CLI_EXECUTABLE, executable);
    assert.strictEqual(
      launch.options.env.MY_CODE_AGENT_CLI_LOADER,
      pathToFileURL(win32.join(appRoot, "node_modules", "tsx", "dist", "loader.mjs"), { windows: true }).href,
    );
    const commandText = launch.args.join(" ");
    assert.ok(!commandText.includes(workspace));
    assert.ok(!commandText.includes(dataRoot));
    assert.doesNotMatch(commandText, /\bnpx\b/);
    assert.doesNotMatch(commandText, /(?:^|\s)tsx(?:\s|$)/);
  });

  it("opens Windows Terminal with the Git Bash profile when both are available", () => {
    const workspace = "C:\\Users\\user\\project";
    const launch = buildCliTerminalLaunch({
      platform: "win32",
      appRoot: "C:\\Program Files\\My Code Agent\\resources\\app.asar",
      workspace,
      dataRoot: "D:\\Agent Data",
      electronExecutable: "C:\\Program Files\\My Code Agent\\MyCodeAgent.exe",
      isPackaged: true,
      env: {},
      windowsTerminalPath: "C:\\Windows\\System32\\wt.exe",
      bashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    });

    assert.strictEqual(launch.command, "C:\\Windows\\System32\\wt.exe");
    assert.deepStrictEqual(launch.args.slice(0, 4), ["new-tab", "--startingDirectory", workspace, "C:\\Program Files\\Git\\bin\\bash.exe"]);
    assert.ok(launch.args.includes("-lc"));
    assert.match(launch.args.at(-1), /exec bash -i/);
    assert.ok(!launch.args.at(-1).includes(workspace));
    assert.strictEqual(launch.options.cwd, workspace);
  });

  it("falls back to cmd when Git Bash or Windows Terminal is unavailable", () => {
    const launch = buildCliTerminalLaunch({
      platform: "win32",
      appRoot: "C:\\App",
      workspace: "C:\\Workspace",
      dataRoot: "C:\\Data",
      electronExecutable: "C:\\App\\Agent.exe",
      isPackaged: true,
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });

    assert.strictEqual(launch.command, "C:\\Windows\\System32\\cmd.exe");
  });

  it("quotes the macOS workspace, environment, executable, loader, and entry in Terminal", () => {
    const workspace = "/Users/o'connor/project; echo untrusted";
    const dataRoot = "/Users/o'connor/Agent Data";
    const appRoot = "/Applications/My Code Agent.app/Contents/Resources/app.asar";
    const executable = "/Applications/My Code Agent.app/Contents/MacOS/My Code Agent";
    const launch = buildCliTerminalLaunch({
      platform: "darwin",
      appRoot,
      workspace,
      dataRoot,
      electronExecutable: executable,
      isPackaged: false,
      env: {},
    });

    assert.strictEqual(launch.command, "osascript");
    assert.strictEqual(launch.args[0], "-e");
    const appleScript = launch.args[1];
    const terminalCommand = JSON.parse(appleScript.slice(appleScript.indexOf("do script ") + "do script ".length));
    assert.ok(terminalCommand.includes("cd -- '/Users/o'\\''connor/project; echo untrusted'"));
    assert.ok(terminalCommand.includes("'ELECTRON_RUN_AS_NODE=1'"));
    assert.ok(terminalCommand.includes("'PI_WORKSPACE=/Users/o'\\''connor/project; echo untrusted'"));
    assert.ok(terminalCommand.includes("'PI_DATA_ROOT=/Users/o'\\''connor/Agent Data'"));
    assert.ok(terminalCommand.includes("'/Applications/My Code Agent.app/Contents/MacOS/My Code Agent'"));
    assert.ok(terminalCommand.includes("'file:///Applications/My%20Code%20Agent.app/Contents/Resources/app.asar/node_modules/tsx/dist/loader.mjs'"));
    assert.ok(terminalCommand.includes("'/Applications/My Code Agent.app/Contents/Resources/app.asar/src/server/main.ts'"));
    assert.doesNotMatch(terminalCommand, /\bnpx\b/);
    assert.doesNotMatch(terminalCommand, /(?:^|\s)tsx(?:\s|$)/);
  });

  it("spawns the generated launch detached, handles child errors, and unrefs it", () => {
    const launch = buildCliTerminalLaunch({
      platform: "linux",
      appRoot: "/opt/my-code-agent",
      workspace: "/home/user/project",
      dataRoot: "/home/user/.my-code-agent",
      electronExecutable: "/opt/my-code-agent/my-code-agent",
      isPackaged: true,
      env: {},
    });
    const calls = [];
    const reported = [];
    let errorListener;
    const child = {
      once(event, listener) {
        calls.push(`listen:${event}`);
        errorListener = listener;
        return child;
      },
      unref() { calls.push("unref"); },
    };

    const result = launchCliTerminal(launch, {
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return child;
      },
      reportError: (error) => reported.push(error),
    });

    assert.strictEqual(result, true);
    assert.deepStrictEqual(calls, [
      { command: launch.command, args: launch.args, options: launch.options },
      "listen:error",
      "unref",
    ]);
    const asyncError = new Error("terminal failed after spawn");
    errorListener(asyncError);
    assert.deepStrictEqual(reported, [asyncError]);
  });

  it("returns false when spawning throws synchronously", () => {
    const launch = buildCliTerminalLaunch({
      platform: "linux",
      appRoot: "/opt/my-code-agent",
      workspace: "/home/user/project",
      dataRoot: "/home/user/.my-code-agent",
      electronExecutable: "/opt/my-code-agent/my-code-agent",
      isPackaged: true,
      env: {},
    });
    const failure = new Error("spawn rejected");
    const reported = [];

    assert.strictEqual(launchCliTerminal(launch, {
      spawn: () => { throw failure; },
      reportError: (error) => reported.push(error),
    }), false);
    assert.deepStrictEqual(reported, [failure]);
  });

  it("keeps Electron free of synchronous terminal process execution", () => {
    const electronMain = readFileSync(new URL("../src/electron/electron-main.ts", import.meta.url), "utf8");
    const terminalAdapter = electronMain.slice(
      electronMain.indexOf("function spawnCliTerminal"),
      electronMain.indexOf("function resolveDesktopContext"),
    );

    assert.match(terminalAdapter, /launchCliTerminal\(launch\)/);
    assert.doesNotMatch(electronMain, /execFileSync|execSync/);
  });

  it("registers the CLI suites in the standard unit test command", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.match(packageJson.scripts["test:unit"], /test\/cli-terminal\.test\.mjs/);
    assert.match(packageJson.scripts["test:unit"], /test\/cli-startup\.test\.mjs/);
  });
});
