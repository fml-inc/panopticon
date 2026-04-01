export interface ArchiveBackend {
  /** Store raw session file content (compressed internally) */
  putSync(sessionId: string, source: string, content: Buffer): void;
  /** Retrieve raw session file content (decompressed) */
  getSync(sessionId: string, source: string): Buffer | null;
  /** Check if archive exists for this session+source */
  hasSync(sessionId: string, source: string): boolean;
  /** List all archived sessions */
  list(): Array<{ sessionId: string; source: string; sizeBytes: number }>;
  /** Aggregate stats */
  stats(): { totalFiles: number; totalBytes: number };
}
