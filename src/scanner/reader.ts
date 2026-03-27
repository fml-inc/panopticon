import fs from "node:fs";

/**
 * Read complete lines appended to a file since the given byte offset.
 * Incomplete trailing lines (no newline) are left for the next read.
 */
export function readNewLines(
  filePath: string,
  fromByteOffset: number,
): { lines: string[]; newByteOffset: number } {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return { lines: [], newByteOffset: fromByteOffset };
  }

  try {
    const size = fs.fstatSync(fd).size;
    if (size <= fromByteOffset) {
      return { lines: [], newByteOffset: fromByteOffset };
    }

    const bytesToRead = size - fromByteOffset;
    const buf = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buf, 0, bytesToRead, fromByteOffset);

    const text = buf.toString("utf-8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) {
      // No complete line yet
      return { lines: [], newByteOffset: fromByteOffset };
    }

    const complete = text.slice(0, lastNewline);
    const lines = complete.split("\n").filter((l) => l.length > 0);
    const bytesConsumed = Buffer.byteLength(
      text.slice(0, lastNewline + 1),
      "utf-8",
    );

    return {
      lines,
      newByteOffset: fromByteOffset + bytesConsumed,
    };
  } finally {
    fs.closeSync(fd);
  }
}
