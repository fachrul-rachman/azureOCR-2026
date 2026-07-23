interface MultipartFile {
  name: string;
  content: string | Buffer;
  contentType?: string;
}

interface MultipartRequest {
  payload: Buffer;
  headers: Record<string, string>;
}

const BOUNDARY = "ocr-test-boundary";

function field(name: string, value: string): Buffer {
  return Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
}

export function createMultipartRequest(
  files: MultipartFile[],
  metadata: unknown,
  idempotencyKey: string,
): MultipartRequest {
  const parts: Buffer[] = [];

  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: ${file.contentType ?? "application/pdf"}\r\n\r\n`,
      ),
      Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content),
      Buffer.from("\r\n"),
    );
  }

  parts.push(
    field(
      "metadata",
      typeof metadata === "string" ? metadata : JSON.stringify(metadata),
    ),
    field("idempotency_key", idempotencyKey),
    Buffer.from(`--${BOUNDARY}--\r\n`),
  );

  return {
    payload: Buffer.concat(parts),
    headers: {
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    },
  };
}
