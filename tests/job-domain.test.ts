import { describe, expect, it } from "vitest";

import {
  calculateBatchStatus,
  parseMetadata,
  sanitizeFileName,
  toBatchStatus,
} from "../src/modules/jobs/job-domain.js";
import type { BatchRecord } from "../src/modules/jobs/job-repository.js";

describe("job domain", () => {
  it("uses metadata defaults and removes unsafe filename characters", () => {
    expect(
      parseMetadata(
        [
          {
            client_file_id: " drive-1 ",
            file_name: "../bad\u0000name.pdf",
          },
        ],
        1,
      ),
    ).toEqual([
      {
        client_file_id: "drive-1",
        file_name: "badname.pdf",
        language: "id-ID",
        modified_time: null,
      },
    ]);
  });

  it("rejects invalid metadata values", () => {
    expect(() => parseMetadata([null], 1)).toThrow("Request tidak valid");
    expect(() =>
      parseMetadata(
        [{ client_file_id: "id", file_name: "file.pdf", modified_time: "no" }],
        1,
      ),
    ).toThrow("Request tidak valid");
    expect(() => sanitizeFileName("..", "file_name")).toThrow(
      "Request tidak valid",
    );
  });

  it("groups every file state into the public progress counters", () => {
    const statuses = ["success", "failed", "queued", "validating"] as const;
    const batch: BatchRecord = {
      batch_id: "00000000-0000-4000-8000-000000000001",
      status: "processing",
      created_at: "2026-07-22T10:00:00.000Z",
      files: statuses.map((status, index) => ({
        file_job_id: `job-${String(index)}`,
        client_file_id: `id-${String(index)}`,
        file_name: `file-${String(index)}.pdf`,
        language: "id-ID",
        modified_time: null,
        status,
        result_ready: status === "success",
        source_path: `/tmp/source-${String(index)}`,
        mime_type: "application/pdf",
        size_bytes: 100,
        sha256: "a".repeat(64),
      })),
    };

    expect(toBatchStatus(batch).progress).toEqual({
      total: 4,
      success: 1,
      failed: 1,
      processing: 1,
      queued: 1,
    });
  });

  it("derives terminal batch states without exposing internal Azure data", () => {
    const makeFile = (status: "success" | "failed") => ({
      file_job_id: status,
      client_file_id: status,
      file_name: `${status}.pdf`,
      language: "id-ID",
      modified_time: null,
      status,
      result_ready: status === "success",
      source_path: `/tmp/${status}`,
      mime_type: "application/pdf" as const,
      size_bytes: 10,
      sha256: "a".repeat(64),
      parts: [
        {
          part_number: 1,
          start_page: 1,
          end_page: 1,
          temporary_path: "/tmp/part",
          size_bytes: 10,
          retry_count: 0,
          azure_status: "succeeded" as const,
          azure_result: { raw: "must stay internal" },
        },
      ],
      ...(status === "failed"
        ? { error: { code: "FAILED", message: "Dokumen gagal." } }
        : {}),
    });
    const files = [makeFile("success"), makeFile("failed")];
    const batch: BatchRecord = {
      batch_id: "00000000-0000-4000-8000-000000000002",
      status: calculateBatchStatus(files),
      created_at: "2026-07-23T00:00:00.000Z",
      files,
    };

    expect(batch.status).toBe("partial");
    expect(toBatchStatus(batch).files).toEqual([
      {
        client_file_id: "success",
        file_name: "success.pdf",
        status: "success",
        result_ready: true,
      },
      {
        client_file_id: "failed",
        file_name: "failed.pdf",
        status: "failed",
        result_ready: false,
        error: { code: "FAILED", message: "Dokumen gagal." },
      },
    ]);
  });

  it("returns a completed file result without exposing internal processing data", () => {
    const result = {
      client_file_id: "success",
      status: "success" as const,
      document: {
        file_name: "success.pdf",
        language: "id-ID",
        page_count: 1,
      },
      data: { text: "Recognized", tables: [] },
      confidence: null,
    };
    const batch: BatchRecord = {
      batch_id: "00000000-0000-4000-8000-000000000003",
      status: "completed",
      created_at: "2026-07-23T00:00:00.000Z",
      files: [
        {
          file_job_id: "success",
          client_file_id: "success",
          file_name: "success.pdf",
          language: "id-ID",
          modified_time: null,
          status: "success",
          result_ready: true,
          source_path: "/tmp/success",
          mime_type: "application/pdf",
          size_bytes: 10,
          sha256: "a".repeat(64),
          result,
        },
      ],
    };

    expect(toBatchStatus(batch).files[0]).toEqual({
      client_file_id: "success",
      file_name: "success.pdf",
      status: "success",
      result_ready: true,
      result,
    });
  });
});
