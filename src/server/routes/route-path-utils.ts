import { existsSync } from "fs";
import { dirname, resolve } from "path";

export function existingAncestorForPath(filePath: string): string {
  let current = dirname(resolve(filePath));
  while (!pathExists(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

export function pathExists(filePath: string): boolean {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}
