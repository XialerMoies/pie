import os from "node:os"
import path from "node:path"

const SENSITIVE_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "id_rsa",
  "id_ed25519",
])

function normalizeForComparison(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+/g, "/").replace(/\/$/, "")
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLowerCase()
    : normalized
}

function isInside(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeForComparison(candidate)
  const normalizedRoot = normalizeForComparison(root)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

function browserProfileRoots(home: string): string[] {
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local")
  const roamingAppData = process.env.APPDATA || path.join(home, "AppData", "Roaming")
  return [
    path.join(localAppData, "Google", "Chrome", "User Data"),
    path.join(localAppData, "Chromium", "User Data"),
    path.join(localAppData, "Microsoft", "Edge", "User Data"),
    path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
    path.join(roamingAppData, "Mozilla", "Firefox", "Profiles"),
    path.join(home, "Library", "Application Support", "Google", "Chrome"),
    path.join(home, "Library", "Application Support", "Chromium"),
    path.join(home, "Library", "Application Support", "Microsoft Edge"),
    path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
    path.join(home, "Library", "Application Support", "Firefox", "Profiles"),
    path.join(home, ".config", "google-chrome"),
    path.join(home, ".config", "chromium"),
    path.join(home, ".config", "microsoft-edge"),
    path.join(home, ".config", "BraveSoftware", "Brave-Browser"),
    path.join(home, ".mozilla", "firefox"),
  ]
}

export function isSensitiveExternalPath(targetPath: string, workspaceRoot: string): boolean {
  if (isInside(targetPath, workspaceRoot)) return false

  const home = os.homedir()
  const sensitiveRoots = [
    ".ssh",
    ".aws",
    ".azure",
    ".gnupg",
    ".kube",
    ".docker",
  ].map((entry) => path.join(home, entry))
  sensitiveRoots.push(...browserProfileRoots(home))

  const windowsRoot = process.env.SystemRoot || process.env.WINDIR
  if (windowsRoot) {
    sensitiveRoots.push(
      path.join(windowsRoot, "System32", "drivers", "etc"),
      path.join(windowsRoot, "System32", "config"),
    )
  }

  if (sensitiveRoots.some((root) => isInside(targetPath, root))) return true

  const base = path.basename(targetPath).toLowerCase()
  return SENSITIVE_FILE_NAMES.has(base)
}
