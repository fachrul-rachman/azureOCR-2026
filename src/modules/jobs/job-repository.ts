export type BatchStatus =
  "queued" | "processing" | "completed" | "partial" | "failed";

export type FileJobStatus =
  | "queued"
  | "validating"
  | "splitting"
  | "processing"
  | "merging"
  | "success"
  | "failed";

export interface FileJobError {
  code: string;
  message: string;
}

export interface NormalizedOcrTable {
  table_ref: string;
  page: number;
  header: string[];
  rows: string[][];
  structure: {
    normalized: true;
    row_count: number;
    column_count: number;
  };
}

export interface OcrFileResult {
  client_file_id: string;
  status: "success";
  document: {
    file_name: string;
    language: string;
    page_count: number;
  };
  data: {
    text: string;
    tables: NormalizedOcrTable[];
  };
  confidence: number | null;
}

export interface PartJobRecord {
  part_number: number;
  start_page: number;
  end_page: number;
  temporary_path: string;
  size_bytes: number;
  retry_count: number;
  azure_status: "queued" | "processing" | "succeeded" | "failed";
  operation_location?: string;
  azure_result?: Record<string, unknown>;
}

export interface FileJobRecord {
  file_job_id: string;
  request_id?: string;
  client_file_id: string;
  file_name: string;
  language: string;
  modified_time: string | null;
  status: FileJobStatus;
  result_ready: boolean;
  source_path: string;
  mime_type: "application/pdf" | "image/png" | "image/jpeg" | "image/tiff";
  size_bytes: number;
  sha256: string;
  page_count?: number;
  parts?: PartJobRecord[];
  result?: OcrFileResult;
  error?: FileJobError;
}

export interface BatchRecord {
  batch_id: string;
  status: BatchStatus;
  created_at: string;
  files: FileJobRecord[];
}

export interface StoreBatchRequest {
  batch: BatchRecord;
  idempotencyKey: string;
  requestFingerprint: string;
  jobTtlSeconds: number;
  idempotencyTtlSeconds: number;
}

export type StoreBatchResult =
  | { outcome: "created" | "existing"; batch: BatchRecord }
  | { outcome: "conflict" };

export interface JobRepository {
  store(request: StoreBatchRequest): Promise<StoreBatchResult>;
  get(batchId: string): Promise<BatchRecord | null>;
  updateFile(
    batchId: string,
    fileJobId: string,
    update: FileJobUpdate,
  ): Promise<BatchRecord | null>;
}

export type FileJobUpdate = Partial<
  Pick<
    FileJobRecord,
    "status" | "result_ready" | "page_count" | "parts" | "result" | "error"
  >
>;
