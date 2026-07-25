/**
 * A rejection the user caused and can fix (bad zip, disallowed URL, repo too
 * big). Routes map this to a 4xx with the message shown verbatim, so messages
 * must be safe to expose and describe what to do differently.
 */
export class IngestError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

/** Byte counts for user-facing limit messages, so a small cap doesn't read "0 MB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} bytes`;
}
