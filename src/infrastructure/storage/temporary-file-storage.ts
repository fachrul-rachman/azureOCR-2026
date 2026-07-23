import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type SupportedMimeType =
  "application/pdf" | "image/png" | "image/jpeg" | "image/tiff";

export interface StoredFile {
  path: string;
  mimeType: SupportedMimeType;
  size: number;
  sha256: string;
}

export class UnsupportedDocumentTypeError extends Error {
  constructor() {
    super("Jenis file tidak didukung.");
    this.name = "UnsupportedDocumentTypeError";
  }
}

function detectMimeType(header: Buffer): SupportedMimeType | null {
  const pdfHeader = Buffer.from("%PDF-");
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  if (header.subarray(0, 1024).indexOf(pdfHeader) >= 0)
    return "application/pdf";
  if (header.subarray(0, pngHeader.length).equals(pngHeader))
    return "image/png";
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)
    return "image/jpeg";
  if (
    (header[0] === 0x49 &&
      header[1] === 0x49 &&
      header[2] === 0x2a &&
      header[3] === 0x00) ||
    (header[0] === 0x4d &&
      header[1] === 0x4d &&
      header[2] === 0x00 &&
      header[3] === 0x2a)
  )
    return "image/tiff";

  return null;
}

export class TemporaryFileStorage {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  static async createForTest(): Promise<TemporaryFileStorage> {
    const directory = await mkdtemp(join(tmpdir(), "azure-ocr-test-"));
    return new TemporaryFileStorage(directory);
  }

  static async removeDirectory(directory: string): Promise<void> {
    await rm(resolve(directory), { recursive: true, force: true });
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  async store(
    stream: AsyncIterable<Buffer | string>,
    onChunk?: (size: number) => void,
  ): Promise<StoredFile> {
    await this.initialize();
    const path = join(this.directory, randomUUID());
    const handle = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    const headers: Buffer[] = [];
    let headerSize = 0;
    let size = 0;

    try {
      for await (const rawChunk of stream) {
        const chunk = Buffer.isBuffer(rawChunk)
          ? rawChunk
          : Buffer.from(rawChunk);
        onChunk?.(chunk.length);
        size += chunk.length;
        hash.update(chunk);

        if (headerSize < 1029) {
          const headerChunk = chunk.subarray(0, 1029 - headerSize);
          headers.push(headerChunk);
          headerSize += headerChunk.length;
        }

        await handle.write(chunk);
      }
    } catch (error) {
      await handle.close();
      await unlink(path).catch(() => undefined);
      throw error;
    }

    await handle.close();
    const mimeType = detectMimeType(Buffer.concat(headers));

    if (mimeType === null) {
      await unlink(path).catch(() => undefined);
      throw new UnsupportedDocumentTypeError();
    }

    return { path, mimeType, size, sha256: hash.digest("hex") };
  }

  async write(data: Uint8Array): Promise<string> {
    await this.initialize();
    const path = join(this.directory, randomUUID());
    await writeFile(path, data, { flag: "wx", mode: 0o600 });
    return path;
  }

  read(path: string): Promise<Buffer> {
    return readFile(path);
  }

  async remove(path: string): Promise<void> {
    await unlink(path).catch((error: unknown) => {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    });
  }

  async removeMany(paths: string[]): Promise<void> {
    await Promise.all(paths.map(async (path) => this.remove(path)));
  }

  async list(): Promise<string[]> {
    await this.initialize();
    return readdir(this.directory);
  }

  async removeOlderThan(cutoffMs: number): Promise<number> {
    const names = await this.list();
    let deleted = 0;
    await Promise.all(
      names.map(async (name) => {
        const path = join(this.directory, name);
        try {
          const details = await stat(path);
          if (!details.isFile() || details.mtimeMs >= cutoffMs) return;
          await this.remove(path);
          deleted += 1;
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )) {
            throw error;
          }
        }
      }),
    );
    return deleted;
  }
}
