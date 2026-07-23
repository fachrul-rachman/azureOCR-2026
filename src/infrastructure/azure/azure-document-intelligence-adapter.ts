import type { AzureSettings } from "../../config/azure-settings.js";
import type { SupportedMimeType } from "../storage/temporary-file-storage.js";

export type AzureRateLimitOperation = "submit" | "poll";

export interface AzureRateLimiter {
  acquire(operation: AzureRateLimitOperation): Promise<void>;
}

export type AzureAnalyzeResult = Record<string, unknown>;

export interface AnalyzeDocumentOptions {
  locale?: string;
  pages?: string;
  operationLocation?: string;
  onSubmitted?: (operationLocation: string) => Promise<void>;
  onRetry?: (retryCount: number) => Promise<void>;
}

export interface DocumentAnalysisAdapter {
  analyze(
    document: Uint8Array,
    mimeType: SupportedMimeType,
    options?: AnalyzeDocumentOptions,
  ): Promise<AzureAnalyzeResult>;
}

export class AzureAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AzureAdapterError";
  }
}

interface AzureAdapterDependencies {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseRetryAfter(headers: Headers, now: number): number | undefined {
  const value = headers.get("retry-after");
  if (value === null) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

function mapHttpError(response: Response, now: number): AzureAdapterError {
  const retryAfterMs = parseRetryAfter(response.headers, now);

  if (response.status === 429) {
    return new AzureAdapterError(
      "AZURE_RATE_LIMITED",
      "Azure sedang membatasi permintaan.",
      true,
      retryAfterMs,
    );
  }
  if (response.status === 408) {
    return new AzureAdapterError(
      "AZURE_TIMEOUT",
      "Permintaan ke Azure melewati batas waktu.",
      true,
      retryAfterMs,
    );
  }
  if (response.status >= 500) {
    return new AzureAdapterError(
      "AZURE_UNAVAILABLE",
      "Layanan Azure sedang tidak tersedia.",
      true,
      retryAfterMs,
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new AzureAdapterError(
      "AZURE_AUTHENTICATION_FAILED",
      "Konfigurasi akses Azure tidak valid.",
      false,
    );
  }
  if ([400, 413, 415, 422].includes(response.status)) {
    return new AzureAdapterError(
      "AZURE_INVALID_DOCUMENT",
      "Dokumen ditolak oleh Azure.",
      false,
    );
  }
  return new AzureAdapterError(
    "AZURE_REQUEST_FAILED",
    "Permintaan ke Azure gagal.",
    false,
  );
}

function mapNetworkError(error: unknown): AzureAdapterError {
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return new AzureAdapterError(
      "AZURE_TIMEOUT",
      "Permintaan ke Azure melewati batas waktu.",
      true,
    );
  }
  return new AzureAdapterError(
    "AZURE_UNAVAILABLE",
    "Layanan Azure tidak dapat dihubungi.",
    true,
  );
}

function parseOperation(value: unknown): {
  status: "notStarted" | "running" | "succeeded" | "failed";
  analyzeResult?: AzureAnalyzeResult;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AzureAdapterError(
      "AZURE_INVALID_RESPONSE",
      "Respons Azure tidak valid.",
      false,
    );
  }

  const record = value as Record<string, unknown>;
  if (
    !new Set(["notStarted", "running", "succeeded", "failed"]).has(
      String(record.status),
    )
  ) {
    throw new AzureAdapterError(
      "AZURE_INVALID_RESPONSE",
      "Respons Azure tidak valid.",
      false,
    );
  }

  const status = record.status as
    "notStarted" | "running" | "succeeded" | "failed";
  if (
    status === "succeeded" &&
    (typeof record.analyzeResult !== "object" ||
      record.analyzeResult === null ||
      Array.isArray(record.analyzeResult))
  ) {
    throw new AzureAdapterError(
      "AZURE_INVALID_RESPONSE",
      "Respons Azure tidak valid.",
      false,
    );
  }

  return status === "succeeded"
    ? { status, analyzeResult: record.analyzeResult as AzureAnalyzeResult }
    : { status };
}

export class AzureDocumentIntelligenceAdapter implements DocumentAnalysisAdapter {
  private readonly fetch: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly settings: AzureSettings,
    private readonly limiter: AzureRateLimiter,
    dependencies: AzureAdapterDependencies = {},
  ) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
  }

  async analyze(
    document: Uint8Array,
    mimeType: SupportedMimeType,
    options: AnalyzeDocumentOptions = {},
  ): Promise<AzureAnalyzeResult> {
    void mimeType;
    const deadline = this.now() + this.settings.operationTimeoutMs;
    const submitUrl = new URL(
      `/documentintelligence/documentModels/${encodeURIComponent(this.settings.modelId)}:analyze`,
      this.settings.endpoint,
    );
    submitUrl.searchParams.set("_overload", "analyzeDocument");
    submitUrl.searchParams.set("api-version", this.settings.apiVersion);
    if (options.pages !== undefined) {
      submitUrl.searchParams.set("pages", options.pages);
    }
    if (options.locale !== undefined) {
      submitUrl.searchParams.set("locale", options.locale);
    }

    let operationUrl: URL;

    if (options.operationLocation === undefined) {
      const submitResponse = await this.request(
        "submit",
        submitUrl,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "ocp-apim-subscription-key": this.settings.key,
          },
          body: JSON.stringify({
            base64Source: Buffer.from(document).toString("base64"),
          }),
        },
        deadline,
        options.onRetry,
      );
      operationUrl = this.validateOperationLocation(
        submitResponse.headers.get("operation-location"),
      );
      await options.onSubmitted?.(operationUrl.toString());
      await submitResponse.body?.cancel();
      await this.sleep(
        parseRetryAfter(submitResponse.headers, this.now()) ??
          this.settings.pollIntervalMs,
      );
    } else {
      operationUrl = this.validateOperationLocation(options.operationLocation);
    }

    while (this.now() < deadline) {
      const pollResponse = await this.request(
        "poll",
        operationUrl,
        {
          method: "GET",
          headers: {
            "ocp-apim-subscription-key": this.settings.key,
          },
        },
        deadline,
        options.onRetry,
      );

      let body: unknown;
      try {
        body = await pollResponse.json();
      } catch {
        throw new AzureAdapterError(
          "AZURE_INVALID_RESPONSE",
          "Respons Azure tidak valid.",
          false,
        );
      }

      const operation = parseOperation(body);
      if (operation.status === "succeeded") {
        const result = operation.analyzeResult;
        if (result === undefined) {
          throw new AzureAdapterError(
            "AZURE_INVALID_RESPONSE",
            "Respons Azure tidak valid.",
            false,
          );
        }
        return result;
      }
      if (operation.status === "failed") {
        throw new AzureAdapterError(
          "AZURE_OPERATION_FAILED",
          "Azure tidak dapat memproses dokumen.",
          false,
        );
      }

      await this.sleep(
        parseRetryAfter(pollResponse.headers, this.now()) ??
          this.settings.pollIntervalMs,
      );
    }

    throw new AzureAdapterError(
      "AZURE_TIMEOUT",
      "Pemrosesan Azure melewati batas waktu.",
      true,
    );
  }

  private validateOperationLocation(value: string | null): URL {
    if (value === null) {
      throw new AzureAdapterError(
        "AZURE_INVALID_RESPONSE",
        "Respons Azure tidak valid.",
        false,
      );
    }

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new AzureAdapterError(
        "AZURE_INVALID_RESPONSE",
        "Respons Azure tidak valid.",
        false,
      );
    }

    const endpoint = new URL(this.settings.endpoint);
    const expectedPath = `/documentintelligence/documentModels/${encodeURIComponent(this.settings.modelId)}/analyzeResults/`;
    if (
      url.origin !== endpoint.origin ||
      !url.pathname.startsWith(expectedPath) ||
      url.searchParams.get("api-version") !== this.settings.apiVersion
    ) {
      throw new AzureAdapterError(
        "AZURE_INVALID_RESPONSE",
        "Respons Azure tidak valid.",
        false,
      );
    }

    return url;
  }

  private async request(
    operation: AzureRateLimitOperation,
    url: URL,
    options: RequestInit,
    deadline: number,
    onRetry?: (retryCount: number) => Promise<void>,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.now() >= deadline) {
        throw new AzureAdapterError(
          "AZURE_TIMEOUT",
          "Pemrosesan Azure melewati batas waktu.",
          true,
        );
      }

      await this.limiter.acquire(operation);
      if (this.now() >= deadline) {
        throw new AzureAdapterError(
          "AZURE_TIMEOUT",
          "Pemrosesan Azure melewati batas waktu.",
          true,
        );
      }
      const remaining = Math.max(1, deadline - this.now());

      try {
        const response = await this.fetch(url, {
          ...options,
          signal: AbortSignal.timeout(
            Math.min(this.settings.requestTimeoutMs, remaining),
          ),
        });
        if (response.ok) return response;
        await response.body?.cancel();
        throw mapHttpError(response, this.now());
      } catch (error) {
        const mapped =
          error instanceof AzureAdapterError ? error : mapNetworkError(error);
        if (!mapped.retryable || attempt >= this.settings.maxRetries) {
          throw mapped;
        }

        await onRetry?.(attempt + 1);

        const exponential =
          this.settings.retryBaseDelayMs *
          2 ** attempt *
          (1 + this.random() * 0.25);
        await this.sleep(Math.max(mapped.retryAfterMs ?? 0, exponential));
      }
    }
  }
}
