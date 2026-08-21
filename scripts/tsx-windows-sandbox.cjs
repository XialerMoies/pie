if (process.platform === "win32" && typeof process.geteuid !== "function") {
  Object.defineProperty(process, "geteuid", {
    configurable: true,
    value: () => 0,
  });
}

// The managed Windows desktop sandbox can return ENOMEM from uv_os_get_passwd
// even when a normal Node process can start. tsx only needs userInfo() to pick
// a temporary-directory name, so keep test execution deterministic and local.
if (process.platform === "win32") {
  const os = require("node:os");
  const originalUserInfo = os.userInfo;
  os.userInfo = function safeUserInfo() {
    try {
      return originalUserInfo.call(os);
    } catch {
      return {
        uid: -1,
        gid: -1,
        username: process.env.USERNAME || "codex",
        homedir: process.env.USERPROFILE || process.cwd(),
        shell: process.env.ComSpec || null,
      };
    }
  };
}
