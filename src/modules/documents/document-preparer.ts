import type {
  SupportedMimeType,
  TemporaryFileStorage,
} from "../../infrastructure/storage/temporary-file-storage.js";
import { InvalidPdfError, splitPdf } from "./pdf-splitter.js";

export interface PreparedPart {
  partNumber: number;
  startPage: number;
  endPage: number;
  temporaryPath: string;
  sizeBytes: number;
}

export interface PreparedDocument {
  sourcePath: string;
  pageCount: number;
  parts: PreparedPart[];
}

export class DocumentPreparer {
  constructor(
    private readonly storage: TemporaryFileStorage,
    private readonly maxPartSizeBytes: number,
  ) {}

  async prepare(
    sourcePath: string,
    mimeType: SupportedMimeType,
  ): Promise<PreparedDocument> {
    const createdPaths: string[] = [];

    try {
      const source = await this.storage.read(sourcePath);

      if (mimeType !== "application/pdf") {
        if (source.length > this.maxPartSizeBytes) {
          throw new InvalidPdfError(
            "Gambar melebihi batas ukuran Azure.",
            "INPUT_TOO_LARGE",
          );
        }

        return {
          sourcePath,
          pageCount: 1,
          parts: [
            {
              partNumber: 1,
              startPage: 1,
              endPage: 1,
              temporaryPath: sourcePath,
              sizeBytes: source.length,
            },
          ],
        };
      }

      const split = await splitPdf(source, this.maxPartSizeBytes);
      const parts: PreparedPart[] = [];

      for (const part of split.parts) {
        const temporaryPath = await this.storage.write(part.data);
        createdPaths.push(temporaryPath);
        parts.push({
          partNumber: part.partNumber,
          startPage: part.startPage,
          endPage: part.endPage,
          temporaryPath,
          sizeBytes: part.data.length,
        });
      }

      return { sourcePath, pageCount: split.pageCount, parts };
    } catch (error) {
      await this.storage.removeMany([sourcePath, ...createdPaths]);
      throw error;
    }
  }

  async cleanup(document: PreparedDocument): Promise<void> {
    await this.storage.removeMany([
      document.sourcePath,
      ...document.parts.map((part) => part.temporaryPath),
    ]);
  }
}
