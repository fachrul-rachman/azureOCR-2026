import { PDFDocument } from "pdf-lib";

export interface PdfPart {
  partNumber: number;
  startPage: number;
  endPage: number;
  data: Buffer;
}

export interface SplitPdfResult {
  pageCount: number;
  parts: PdfPart[];
}

export class InvalidPdfError extends Error {
  constructor(
    message = "PDF tidak valid atau tidak dapat dibaca.",
    readonly code: "CORRUPT_FILE" | "INPUT_TOO_LARGE" = "CORRUPT_FILE",
  ) {
    super(message);
    this.name = "InvalidPdfError";
  }
}

async function createPart(
  source: PDFDocument,
  pageIndexes: number[],
): Promise<Buffer> {
  const part = await PDFDocument.create();
  const pages = await part.copyPages(source, pageIndexes);
  pages.forEach((page) => part.addPage(page));
  return Buffer.from(await part.save({ useObjectStreams: false }));
}

export async function splitPdf(
  data: Uint8Array,
  maxPartSizeBytes: number,
): Promise<SplitPdfResult> {
  let source: PDFDocument;

  try {
    source = await PDFDocument.load(data);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("PDFDocument.load` is encrypted")
    ) {
      throw new InvalidPdfError("PDF terkunci dan tidak dapat diproses.");
    }
    throw new InvalidPdfError();
  }

  const pageCount = source.getPageCount();
  const parts: PdfPart[] = [];

  if (pageCount === 0) throw new InvalidPdfError("PDF tidak memiliki halaman.");

  for (let index = 0; index < pageCount; index += 2) {
    const endIndex = Math.min(index + 1, pageCount - 1);
    const pair = await createPart(
      source,
      Array.from(
        { length: endIndex - index + 1 },
        (_, offset) => index + offset,
      ),
    );

    if (pair.length <= maxPartSizeBytes) {
      parts.push({
        partNumber: parts.length + 1,
        startPage: index + 1,
        endPage: endIndex + 1,
        data: pair,
      });
      continue;
    }

    for (let pageIndex = index; pageIndex <= endIndex; pageIndex += 1) {
      const single = await createPart(source, [pageIndex]);

      if (single.length > maxPartSizeBytes) {
        throw new InvalidPdfError(
          `Satu halaman PDF melebihi batas ukuran pada halaman ${String(pageIndex + 1)}.`,
          "INPUT_TOO_LARGE",
        );
      }

      parts.push({
        partNumber: parts.length + 1,
        startPage: pageIndex + 1,
        endPage: pageIndex + 1,
        data: single,
      });
    }
  }

  return { pageCount, parts };
}
