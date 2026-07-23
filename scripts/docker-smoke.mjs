import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const live = process.argv.includes("--live");

async function compose(args, options = {}) {
  return exec("docker", ["compose", ...args], {
    cwd: process.cwd(),
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

async function waitForReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:3000/ready");
      if (response.ok) return;
    } catch {
      // Service may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("API did not become ready");
}

async function submitDocument() {
  const code = `
    const { PDFDocument } = await import("pdf-lib");
    const document = await PDFDocument.create();
    const page = document.addPage([300, 300]);
    page.drawText("Docker smoke test");
    const data = await document.save({ useObjectStreams: false });
    const form = new FormData();
    form.append("files", new Blob([data], { type: "application/pdf" }), "smoke.pdf");
    form.append("metadata", JSON.stringify([{
      client_file_id: "docker-smoke",
      file_name: "smoke.pdf",
      language: "id-ID",
      modified_time: new Date().toISOString()
    }]));
    form.append("idempotency_key", "docker-smoke-" + Date.now());
    const response = await fetch("http://127.0.0.1:3000/v1/ocr/jobs", {
      method: "POST",
      headers: { "x-api-key": process.env.SERVICE_API_KEY },
      body: form
    });
    const body = await response.json();
    if (response.status !== 202) throw new Error("Smoke submission failed with HTTP " + response.status);
    process.stdout.write(JSON.stringify(body));
  `;
  const { stdout } = await compose([
    "exec",
    "-T",
    "api",
    "node",
    "--input-type=module",
    "-e",
    code,
  ]);
  const body = JSON.parse(stdout.trim());
  if (typeof body.batch_id !== "string") throw new Error("Missing batch ID");
  return body.batch_id;
}

async function readStatus(batchId) {
  const code = `
    const response = await fetch("http://127.0.0.1:3000/v1/ocr/jobs/${batchId}", {
      headers: { "x-api-key": process.env.SERVICE_API_KEY }
    });
    if (!response.ok) throw new Error("Smoke status failed with HTTP " + response.status);
    process.stdout.write(await response.text());
  `;
  const { stdout } = await compose([
    "exec",
    "-T",
    "api",
    "node",
    "--input-type=module",
    "-e",
    code,
  ]);
  return JSON.parse(stdout.trim());
}

await compose(["up", "-d", "--build"]);
await waitForReady();
const { stdout: workerLogs } = await compose([
  "logs",
  "--no-color",
  "--tail",
  "50",
  "worker",
]);
if (!workerLogs.includes("Worker connected to Redis")) {
  throw new Error("Worker did not connect to Redis");
}

if (!live) {
  await compose(["restart", "worker"]);
  await waitForReady();
  process.stdout.write("Docker infrastructure smoke test passed.\n");
  process.stdout.write(
    "Use --live to process one real document through Azure.\n",
  );
  process.exit(0);
}

const batchId = await submitDocument();
await compose(["restart", "worker"]);
let terminal;
for (let attempt = 0; attempt < 180; attempt += 1) {
  const status = await readStatus(batchId);
  if (["completed", "partial", "failed"].includes(status.status)) {
    terminal = status;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
if (terminal === undefined) throw new Error("Smoke job did not finish in time");
if (
  terminal.status !== "completed" ||
  terminal.files?.[0]?.status !== "success" ||
  terminal.files?.[0]?.result_ready !== true
) {
  const code = terminal.files?.[0]?.error?.code ?? "UNKNOWN";
  throw new Error(`Smoke job failed safely with code ${code}`);
}
process.stdout.write("Docker live smoke test passed.\n");
