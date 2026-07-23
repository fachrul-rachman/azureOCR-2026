import { describe, expect, it } from "vitest";

import {
  InvalidOcrResultError,
  normalizeOcrResult,
} from "../src/modules/ocr/ocr-result-normalizer.js";
import type { FileJobRecord } from "../src/modules/jobs/job-repository.js";

function completedFile(): FileJobRecord {
  return {
    file_job_id: "file-1",
    client_file_id: "drive-1",
    file_name: "report.pdf",
    language: "id-ID",
    modified_time: null,
    status: "merging",
    result_ready: false,
    source_path: "/tmp/report.pdf",
    mime_type: "application/pdf",
    size_bytes: 100,
    sha256: "a".repeat(64),
    page_count: 3,
    parts: [
      {
        part_number: 2,
        start_page: 3,
        end_page: 3,
        temporary_path: "/tmp/part-2.pdf",
        size_bytes: 20,
        retry_count: 0,
        azure_status: "succeeded",
        azure_result: {
          pages: [
            {
              pageNumber: 1,
              lines: [{ content: "Halaman tiga" }],
              words: [{ content: "tiga", confidence: 0.5 }],
            },
          ],
          tables: [],
        },
      },
      {
        part_number: 1,
        start_page: 1,
        end_page: 2,
        temporary_path: "/tmp/part-1.pdf",
        size_bytes: 20,
        retry_count: 0,
        azure_status: "succeeded",
        azure_result: {
          pages: [
            {
              pageNumber: 2,
              lines: [{ content: "Halaman dua" }],
              words: [{ content: "dua", confidence: 1 }],
            },
            {
              pageNumber: 1,
              lines: [{ content: "Halaman satu" }],
              words: [{ content: "satu", confidence: 0.5 }],
            },
          ],
          tables: [
            {
              rowCount: 2,
              columnCount: 3,
              boundingRegions: [{ pageNumber: 2 }],
              cells: [
                {
                  kind: "columnHeader",
                  rowIndex: 0,
                  columnIndex: 0,
                  content: "Nama",
                },
                {
                  kind: "columnHeader",
                  rowIndex: 0,
                  columnIndex: 1,
                  columnSpan: 2,
                  content: "Jumlah",
                },
                { rowIndex: 1, columnIndex: 0, content: "Produk A" },
                { rowIndex: 1, columnIndex: 1, content: "10" },
              ],
            },
            {
              rowCount: 1,
              columnCount: 2,
              boundingRegions: [{ pageNumber: 1 }],
              cells: [
                { rowIndex: 0, columnIndex: 0, content: "Tanpa" },
                { rowIndex: 0, columnIndex: 1, content: "Header" },
              ],
            },
          ],
        },
      },
    ],
  };
}

describe("OCR result normalizer", () => {
  it("merges pages and tables in original page order", () => {
    expect(normalizeOcrResult(completedFile())).toEqual({
      client_file_id: "drive-1",
      status: "success",
      document: {
        file_name: "report.pdf",
        language: "id-ID",
        page_count: 3,
      },
      data: {
        text: "Halaman satu\n\nHalaman dua\n\nHalaman tiga",
        tables: [
          {
            table_ref: "p1-t1",
            page: 1,
            header: [],
            rows: [["Tanpa", "Header"]],
            structure: {
              normalized: true,
              row_count: 1,
              column_count: 2,
            },
          },
          {
            table_ref: "p2-t1",
            page: 2,
            header: ["Nama", "Jumlah", ""],
            rows: [["Produk A", "10", ""]],
            structure: {
              normalized: true,
              row_count: 1,
              column_count: 3,
            },
          },
        ],
      },
      confidence: 0.636364,
    });
  });

  it("uses null when Azure provides no usable confidence", () => {
    const file = completedFile();
    for (const part of file.parts ?? []) {
      const pages = part.azure_result?.pages;
      if (Array.isArray(pages)) {
        for (const page of pages) {
          if (typeof page === "object" && page !== null) {
            delete (page as Record<string, unknown>).words;
          }
        }
      }
    }

    expect(normalizeOcrResult(file).confidence).toBeNull();
  });

  it("rejects incomplete or malformed Azure results", () => {
    const file = completedFile();
    const firstPart = file.parts?.[0];
    if (firstPart !== undefined) firstPart.azure_result = { pages: [] };

    expect(() => normalizeOcrResult(file)).toThrow(InvalidOcrResultError);
  });
});
