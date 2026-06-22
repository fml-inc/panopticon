export interface ArchivedSessionFile {
  sessionId: string;
  source: string;
  sizeBytes: number;
  fileName: string;
  contentType: string;
  contentEncoding: string;
}

export interface ArchivedSessionFileContent extends ArchivedSessionFile {
  content: Buffer;
}

export interface ArchiveBackend {
  /** Store raw session file content (compressed internally) */
  putSync(sessionId: string, source: string, content: Buffer): void;
  /** Retrieve raw session file content (decompressed) */
  getSync(sessionId: string, source: string): Buffer | null;
  /** Retrieve the stored archive file bytes exactly as persisted locally. */
  getStoredFileSync(
    sessionId: string,
    source: string,
  ): ArchivedSessionFileContent | null;
  /** Check if archive exists for this session+source */
  hasSync(sessionId: string, source: string): boolean;
  /** List all archived sessions */
  list(): ArchivedSessionFile[];
  /** Aggregate stats */
  stats(): { totalFiles: number; totalBytes: number };
}
