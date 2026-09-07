import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export interface LargeResultStore {
  maybeStore(toolName: string, content: string): Promise<StoredResult>;
}

export interface StoredResult {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface FileLargeResultStoreOptions {
  thresholdBytes?: number;
  previewBytes?: number;
}

const DEFAULT_THRESHOLD_BYTES = 30 * 1024;
const DEFAULT_PREVIEW_BYTES = 4 * 1024;

export class PassthroughLargeResultStore implements LargeResultStore {
  async maybeStore(_toolName: string, content: string): Promise<StoredResult> {
    return { content };
  }
}

export class FileLargeResultStore implements LargeResultStore {
  private readonly thresholdBytes: number;
  private readonly previewBytes: number;

  constructor(
    private readonly cwd: string,
    options: FileLargeResultStoreOptions = {},
  ) {
    this.thresholdBytes = options.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
    this.previewBytes = options.previewBytes ?? DEFAULT_PREVIEW_BYTES;
  }

  async maybeStore(toolName: string, content: string): Promise<StoredResult> {
    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength <= this.thresholdBytes) {
      return { content };
    }

    const date = new Date().toISOString().slice(0, 10);
    const safeToolName = toolName.replace(/[^a-z0-9_-]/gi, "_");
    const artifactDir = resolve(this.cwd, ".agent", "artifacts", date);
    await mkdir(artifactDir, { recursive: true });

    const artifactPath = resolve(
      artifactDir,
      `${safeToolName}_${randomUUID()}.txt`,
    );
    await writeFile(artifactPath, content, "utf8");

    const relativePath = relative(this.cwd, artifactPath).replaceAll("\\", "/");
    const preview = truncateByBytes(
      content,
      this.previewBytes,
      toolName === "run_shell",
    );

    return {
      content: [
        "Tool result was too large and has been stored at:",
        relativePath,
        "",
        "Preview:",
        preview,
      ].join("\n"),
      metadata: {
        stored: true,
        artifactPath: relativePath,
        originalBytes: byteLength,
        previewBytes: Buffer.byteLength(preview, "utf8"),
      },
    };
  }
}

function truncateByBytes(
  content: string,
  maxBytes: number,
  fromEnd: boolean,
): string {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return content;
  }

  return buffer
    .subarray(fromEnd ? buffer.byteLength - maxBytes : 0, fromEnd ? undefined : maxBytes)
    .toString("utf8");
}
