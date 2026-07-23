import { createHash } from "node:crypto";

import type { Redis } from "ioredis";

import type {
  BatchRecord,
  JobRepository,
  StoreBatchRequest,
  StoreBatchResult,
  FileJobUpdate,
} from "../../modules/jobs/job-repository.js";

const BATCH_PREFIX = "ocr:batch:";
const IDEMPOTENCY_PREFIX = "ocr:idempotency:";

const STORE_SCRIPT = `
local record = redis.call("GET", KEYS[1])
if record then
  local separator = string.find(record, "|", 1, true)
  if separator then
    local existingBatchId = string.sub(record, separator + 1)
    local existingBatch = redis.call("GET", ARGV[5] .. existingBatchId)
    if existingBatch then
      return {"existing", record, existingBatch}
    end
  end
  redis.call("DEL", KEYS[1])
end

redis.call("SET", KEYS[2], ARGV[1], "EX", ARGV[3])
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[4])
return {"created", ARGV[2], ARGV[1]}
`;

const UPDATE_FILE_SCRIPT = `
local value = redis.call("GET", KEYS[1])
if not value then return nil end

local batch = cjson.decode(value)
local update = cjson.decode(ARGV[2])
local found = false
local success = 0
local failed = 0
local queued = 0

for _, file in ipairs(batch.files) do
  if file.file_job_id == ARGV[1] then
    for key, item in pairs(update) do file[key] = item end
    found = true
  end
end

if not found then return nil end

for _, file in ipairs(batch.files) do
  if file.status == "success" then success = success + 1 end
  if file.status == "failed" then failed = failed + 1 end
  if file.status == "queued" then queued = queued + 1 end
end

local total = #batch.files
if success == total then
  batch.status = "completed"
elseif failed == total then
  batch.status = "failed"
elseif success + failed == total then
  batch.status = "partial"
elseif queued == total then
  batch.status = "queued"
else
  batch.status = "processing"
end

local encoded = cjson.encode(batch)
local ttl = redis.call("PTTL", KEYS[1])
if ttl > 0 then
  redis.call("SET", KEYS[1], encoded, "PX", ttl)
else
  redis.call("SET", KEYS[1], encoded)
end
return encoded
`;

function parseBatch(value: string): BatchRecord {
  return JSON.parse(value) as BatchRecord;
}

export class RedisJobRepository implements JobRepository {
  constructor(private readonly redis: Redis) {}

  async store(request: StoreBatchRequest): Promise<StoreBatchResult> {
    const idempotencyHash = createHash("sha256")
      .update(request.idempotencyKey, "utf8")
      .digest("hex");
    const idempotencyKey = `${IDEMPOTENCY_PREFIX}${idempotencyHash}`;
    const batchKey = `${BATCH_PREFIX}${request.batch.batch_id}`;
    const batchJson = JSON.stringify(request.batch);
    const record = `${request.requestFingerprint}|${request.batch.batch_id}`;
    const result = await this.redis.eval(
      STORE_SCRIPT,
      2,
      idempotencyKey,
      batchKey,
      batchJson,
      record,
      String(request.jobTtlSeconds),
      String(request.idempotencyTtlSeconds),
      BATCH_PREFIX,
    );

    if (
      !Array.isArray(result) ||
      typeof result[0] !== "string" ||
      typeof result[1] !== "string" ||
      typeof result[2] !== "string"
    ) {
      throw new Error("Redis returned an invalid job result");
    }

    const separator = result[1].indexOf("|");
    const existingFingerprint = result[1].slice(0, separator);

    if (separator < 1 || existingFingerprint !== request.requestFingerprint) {
      return { outcome: "conflict" };
    }

    return {
      outcome: result[0] === "existing" ? "existing" : "created",
      batch: parseBatch(result[2]),
    };
  }

  async get(batchId: string): Promise<BatchRecord | null> {
    const value = await this.redis.get(`${BATCH_PREFIX}${batchId}`);
    return value === null ? null : parseBatch(value);
  }

  async updateFile(
    batchId: string,
    fileJobId: string,
    update: FileJobUpdate,
  ): Promise<BatchRecord | null> {
    const result = await this.redis.eval(
      UPDATE_FILE_SCRIPT,
      1,
      `${BATCH_PREFIX}${batchId}`,
      fileJobId,
      JSON.stringify(update),
    );
    if (result === null) return null;
    if (typeof result !== "string") {
      throw new Error("Redis returned an invalid batch update");
    }
    return parseBatch(result);
  }
}
