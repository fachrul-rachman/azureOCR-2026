import { Readable } from "node:stream";
import { utimes } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { TemporaryFileStorage } from "../src/infrastructure/storage/temporary-file-storage.js";

const directories: string[] = [];

describe("temporary file storage", () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map(async (directory) => {
        await TemporaryFileStorage.removeDirectory(directory);
      }),
    );
  });

  it.each([
    ["application/pdf", Buffer.from("%PDF-1.7\n")],
    [
      "image/png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ],
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ["image/tiff", Buffer.from([0x49, 0x49, 0x2a, 0x00])],
  ])("stores supported content as %s", async (mimeType, content) => {
    const storage = await TemporaryFileStorage.createForTest();
    directories.push(storage.directory);

    const stored = await storage.store(Readable.from(content));

    expect(stored.mimeType).toBe(mimeType);
    expect(stored.size).toBe(content.length);
    await expect(storage.read(stored.path)).resolves.toEqual(content);
  });

  it("rejects a spoofed file and removes its partial data", async () => {
    const storage = await TemporaryFileStorage.createForTest();
    directories.push(storage.directory);

    await expect(
      storage.store(Readable.from("not a document")),
    ).rejects.toThrow("Jenis file tidak didukung");
    await expect(storage.list()).resolves.toEqual([]);
  });

  it("removes stored data", async () => {
    const storage = await TemporaryFileStorage.createForTest();
    directories.push(storage.directory);
    const stored = await storage.store(Readable.from("%PDF-1.7\n"));

    await storage.remove(stored.path);

    await expect(storage.list()).resolves.toEqual([]);
  });

  it("removes only temporary files older than the cutoff", async () => {
    const storage = await TemporaryFileStorage.createForTest();
    directories.push(storage.directory);
    const expired = await storage.write(Buffer.from("expired"));
    const fresh = await storage.write(Buffer.from("fresh"));
    await utimes(expired, new Date(1_000), new Date(1_000));
    await utimes(fresh, new Date(3_000), new Date(3_000));

    await expect(storage.removeOlderThan(2_000)).resolves.toBe(1);
    await expect(storage.list()).resolves.toHaveLength(1);
    await expect(storage.read(fresh)).resolves.toEqual(Buffer.from("fresh"));
  });
});
