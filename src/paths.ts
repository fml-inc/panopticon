import path from "node:path";

export type ObservedPathStyle = "windows" | "posix";

export function looksLikeWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

export function detectObservedPathStyle(
  value: string,
): ObservedPathStyle | null {
  if (!value) return null;
  if (looksLikeWindowsPath(value)) return "windows";
  if (path.posix.isAbsolute(value)) return "posix";
  return null;
}

export function isObservedAbsolutePath(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.isAbsolute(value)
  );
}

export function canUseLocalPathApis(value: string): boolean {
  const style = detectObservedPathStyle(value);
  if (!style) return true;
  if (process.platform === "win32") return style === "windows";
  return style === "posix";
}

export function resolveFilePathFromCwd(
  filePath: string,
  cwd: string | null,
): string {
  if (!cwd || filePath.length === 0 || isObservedAbsolutePath(filePath)) {
    return filePath;
  }
  const cwdStyle = detectObservedPathStyle(cwd);
  if (cwdStyle === "windows") {
    return path.win32.resolve(cwd, filePath);
  }
  if (cwdStyle === "posix") {
    return path.posix.resolve(cwd, filePath);
  }
  return path.resolve(cwd, filePath);
}
