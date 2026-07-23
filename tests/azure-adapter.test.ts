import { describe, expect, it, vi } from "vitest";

import type { AzureSettings } from "../src/config/azure-settings.js";
import {
  AzureAdapterError,
  AzureDocumentIntelligenceAdapter,
  type AzureRateLimiter,
  type DocumentAnalysisAdapter,
} from "../src/infrastructure/azure/azure-document-intelligence-adapter.js";

const settings: AzureSettings = {
  tier: "F0",
  endpoint: "https://sample.cognitiveservices.azure.com",
  key: "azure-secret",
  apiVersion: "2024-11-30",
  modelId: "prebuilt-layout",
  requestTimeoutMs: 30_000,
  operationTimeoutMs: 120_000,
  pollIntervalMs: 2_000,
  maxRetries: 3,
  retryBaseDelayMs: 1_000,
  submitRequestsPerSecond: 1,
  pollRequestsPerSecond: 1,
};

const limiter: AzureRateLimiter = { acquire: () => Promise.resolve() };

function response(
  status: number,
  body: unknown = {},
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function adapter(
  fetchResponses: Array<Response | Error>,
  overrides: Partial<AzureSettings> = {},
  sleep = vi.fn<(_: number) => Promise<void>>(() => Promise.resolve()),
) {
  const fetchMock = vi.fn<typeof fetch>(() => {
    const next = fetchResponses.shift();
    if (next instanceof Error) return Promise.reject(next);
    if (next === undefined)
      return Promise.reject(new Error("Unexpected request"));
    return Promise.resolve(next);
  });
  return {
    client: new AzureDocumentIntelligenceAdapter(
      { ...settings, ...overrides },
      limiter,
      { fetch: fetchMock, sleep, random: () => 0 },
    ),
    fetchMock,
    sleep,
  };
}

describe("Azure Document Intelligence adapter", () => {
  it("is replaceable by a mock adapter", async () => {
    const mock: DocumentAnalysisAdapter = {
      analyze: vi.fn(() => Promise.resolve({ pages: [] })),
    };
    await expect(
      mock.analyze(Buffer.from("document"), "application/pdf"),
    ).resolves.toEqual({
      pages: [],
    });
  });

  it("submits to prebuilt-layout and polls until succeeded", async () => {
    const operationLocation =
      "https://sample.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-layout/analyzeResults/result-1?api-version=2024-11-30";
    const { client, fetchMock } = adapter([
      response(202, {}, { "operation-location": operationLocation }),
      response(200, { status: "running" }),
      response(200, {
        status: "succeeded",
        analyzeResult: { pages: [{ pageNumber: 1 }] },
      }),
    ]);

    const onSubmitted = vi.fn<(_: string) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const result = await client.analyze(
      Buffer.from("document"),
      "application/pdf",
      { locale: "id-ID", onSubmitted },
    );

    expect(result).toEqual({ pages: [{ pageNumber: 1 }] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onSubmitted).toHaveBeenCalledWith(operationLocation);
    const [submitUrl, submitOptions] = fetchMock.mock.calls[0] ?? [];
    expect(submitUrl).toBeInstanceOf(URL);
    expect((submitUrl as URL).toString()).toBe(
      "https://sample.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-layout:analyze?_overload=analyzeDocument&api-version=2024-11-30&locale=id-ID",
    );
    expect(submitOptions).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "ocp-apim-subscription-key": "azure-secret",
      },
    });
    const submitBody = submitOptions?.body;
    expect(typeof submitBody).toBe("string");
    expect(JSON.parse(submitBody as string)).toEqual({
      base64Source: Buffer.from("document").toString("base64"),
    });
  });

  it("retries 429 and server errors but honors Retry-After", async () => {
    const location =
      "https://sample.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-layout/analyzeResults/result-2?api-version=2024-11-30";
    const { client, fetchMock, sleep } = adapter([
      response(
        429,
        { error: { message: "raw secret detail" } },
        { "retry-after": "3" },
      ),
      response(503, { error: { message: "raw outage" } }),
      response(202, {}, { "operation-location": location }),
      response(200, { status: "succeeded", analyzeResult: { pages: [] } }),
    ]);

    const onRetry = vi.fn<(_: number) => Promise<void>>(() =>
      Promise.resolve(),
    );
    await expect(
      client.analyze(Buffer.from("document"), "application/pdf", { onRetry }),
    ).resolves.toEqual({
      pages: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledWith(3_000);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2);
  });

  it("resumes polling without submitting the document again", async () => {
    const operationLocation =
      "https://sample.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-layout/analyzeResults/resume-1?api-version=2024-11-30";
    const { client, fetchMock } = adapter([
      response(200, { status: "succeeded", analyzeResult: { pages: [] } }),
    ]);

    await expect(
      client.analyze(Buffer.from("document"), "application/pdf", {
        operationLocation,
      }),
    ).resolves.toEqual({ pages: [] });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("retries network timeouts only up to the configured limit", async () => {
    const timeout = new Error("socket included sensitive address");
    timeout.name = "TimeoutError";
    const { client, fetchMock } = adapter([timeout, timeout, timeout], {
      maxRetries: 2,
    });

    const error = await client
      .analyze(Buffer.from("document"), "application/pdf")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AzureAdapterError);
    expect(error).toMatchObject({ code: "AZURE_TIMEOUT", retryable: true });
    expect(String(error)).not.toContain("sensitive address");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry invalid input or expose the raw Azure response", async () => {
    const { client, fetchMock } = adapter([
      response(400, {
        error: { code: "InvalidRequest", message: "raw document detail" },
      }),
    ]);

    const error = await client
      .analyze(Buffer.from("document"), "application/pdf")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "AZURE_INVALID_DOCUMENT",
      retryable: false,
    });
    expect(String(error)).not.toContain("raw document detail");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects an operation address outside the configured Azure resource", async () => {
    const { client, fetchMock } = adapter([
      response(
        202,
        {},
        { "operation-location": "https://attacker.test/steal" },
      ),
    ]);

    await expect(
      client.analyze(Buffer.from("document"), "application/pdf"),
    ).rejects.toMatchObject({
      code: "AZURE_INVALID_RESPONSE",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops polling after the overall timeout", async () => {
    const location =
      "https://sample.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-layout/analyzeResults/result-3?api-version=2024-11-30";
    let now = 0;
    let requestCount = 0;
    const fetchMock = vi.fn<typeof fetch>(() => {
      requestCount += 1;
      return Promise.resolve(
        requestCount === 1
          ? response(202, {}, { "operation-location": location })
          : response(200, { status: "running" }),
      );
    });
    const client = new AzureDocumentIntelligenceAdapter(
      { ...settings, operationTimeoutMs: 3_000, pollIntervalMs: 2_000 },
      limiter,
      {
        fetch: fetchMock,
        sleep: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
        now: () => now,
        random: () => 0,
      },
    );

    await expect(
      client.analyze(Buffer.from("document"), "application/pdf"),
    ).rejects.toMatchObject({
      code: "AZURE_TIMEOUT",
    });
  });

  it("does not send a request after waiting past the overall timeout", async () => {
    let now = 0;
    const fetchMock = vi.fn<typeof fetch>();
    const slowLimiter: AzureRateLimiter = {
      acquire: () => {
        now = 4_000;
        return Promise.resolve();
      },
    };
    const client = new AzureDocumentIntelligenceAdapter(
      { ...settings, operationTimeoutMs: 3_000 },
      slowLimiter,
      { fetch: fetchMock, now: () => now },
    );

    await expect(
      client.analyze(Buffer.from("document"), "application/pdf"),
    ).rejects.toMatchObject({ code: "AZURE_TIMEOUT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
