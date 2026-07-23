import { EncryptedPDFError, PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";

import { splitPdf } from "../src/modules/documents/pdf-splitter.js";

async function pdfWithPages(pageCount: number): Promise<Buffer> {
  const document = await PDFDocument.create();

  for (let page = 1; page <= pageCount; page += 1) {
    const current = document.addPage([300, 300]);
    current.drawText(`page ${String(page)}`);
  }

  return Buffer.from(await document.save({ useObjectStreams: false }));
}

describe("PDF splitter", () => {
  it("splits pages in order and preserves original page mapping", async () => {
    const result = await splitPdf(await pdfWithPages(5), 4 * 1024 * 1024);

    expect(result.pageCount).toBe(5);
    expect(
      result.parts.map(({ partNumber, startPage, endPage }) => ({
        partNumber,
        startPage,
        endPage,
      })),
    ).toEqual([
      { partNumber: 1, startPage: 1, endPage: 2 },
      { partNumber: 2, startPage: 3, endPage: 4 },
      { partNumber: 3, startPage: 5, endPage: 5 },
    ]);
  });

  it("falls back to one page when a two-page part is too large", async () => {
    const source = await pdfWithPages(2);
    const normal = await splitPdf(source, 4 * 1024 * 1024);
    const firstPart = normal.parts[0];
    if (firstPart === undefined) throw new Error("Expected a PDF part");
    const onePageThreshold = firstPart.data.length - 1;

    const result = await splitPdf(source, onePageThreshold);

    expect(result.parts).toHaveLength(2);
    expect(result.parts.map((part) => [part.startPage, part.endPage])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it("fails clearly when a single page is too large", async () => {
    await expect(splitPdf(await pdfWithPages(1), 1)).rejects.toThrow(
      "Satu halaman PDF melebihi batas ukuran",
    );
  });

  it("rejects corrupt PDF data", async () => {
    await expect(splitPdf(Buffer.from("%PDF-invalid"), 1024)).rejects.toThrow(
      "PDF tidak valid",
    );
  });

  it("rejects a password-protected PDF with a clear permanent error", async () => {
    const load = vi
      .spyOn(PDFDocument, "load")
      .mockRejectedValueOnce(new EncryptedPDFError());

    await expect(
      splitPdf(Buffer.from("%PDF-encrypted"), 1024),
    ).rejects.toMatchObject({
      code: "CORRUPT_FILE",
      message: "PDF terkunci dan tidak dapat diproses.",
    });
    load.mockRestore();
  });
});
