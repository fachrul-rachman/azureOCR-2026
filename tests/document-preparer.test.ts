import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";

import { TemporaryFileStorage } from "../src/infrastructure/storage/temporary-file-storage.js";
import { DocumentPreparer } from "../src/modules/documents/document-preparer.js";

const directories: string[] = [];

async function pdfWithPages(count: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < count; index += 1) pdf.addPage([100, 100]);
  return Buffer.from(await pdf.save());
}

describe("document preparation", () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map(async (directory) => {
        await TemporaryFileStorage.removeDirectory(directory);
      }),
    );
  });

  it("stores ordered PDF parts and cleans all temporary data", async () => {
    const storage = await TemporaryFileStorage.createForTest();
    directories.push(storage.directory);
    const sourcePath = await storage.write(await pdfWithPages(3));
    const preparer = new DocumentPreparer(storage, 4 * 1024 * 1024);

    const prepared = await preparer.prepare(sourcePath, "application/pdf");

    expect(prepared.pageCount).toBe(3);
    expect(
      prepared.parts.map((part) => [
        part.partNumber,
        part.startPage,
        part.endPage,
      ]),
    ).toEqual([
      [1, 1, 2],
      [2, 3, 3],
    ]);
    expect(await storage.list()).toHaveLength(3);

    await preparer.cleanup(prepared);
    await expect(storage.list()).resolves.toEqual([]);
  });

  it("removes the source when PDF preparation fails permanently", async () => {
    const storage = await TemporaryFileStorage.createForTest();
    directories.push(storage.directory);
    const sourcePath = await storage.write(Buffer.from("%PDF-invalid"));
    const preparer = new DocumentPreparer(storage, 1024);

    await expect(
      preparer.prepare(sourcePath, "application/pdf"),
    ).rejects.toThrow("PDF tidak valid");
    await expect(storage.list()).resolves.toEqual([]);
  });

  it("uses an image as one page and rejects an oversized image", async () => {
    const storage = await TemporaryFileStorage.createForTest();
    directories.push(storage.directory);
    const sourcePath = await storage.write(
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    );
    const preparer = new DocumentPreparer(storage, 3);

    await expect(preparer.prepare(sourcePath, "image/jpeg")).rejects.toThrow(
      "Gambar melebihi batas ukuran",
    );
    await expect(storage.list()).resolves.toEqual([]);
  });
});
