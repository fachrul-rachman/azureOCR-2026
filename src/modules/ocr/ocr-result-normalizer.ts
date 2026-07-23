import type {
  FileJobRecord,
  NormalizedOcrTable,
  OcrFileResult,
  PartJobRecord,
} from "../jobs/job-repository.js";

type UnknownRecord = Record<string, unknown>;

interface PageData {
  page: number;
  text: string;
  confidenceTotal: number;
  confidenceWeight: number;
}

interface TableData {
  page: number;
  order: number;
  table: UnknownRecord;
}

export class InvalidOcrResultError extends Error {
  readonly code = "AZURE_INVALID_RESPONSE";

  constructor() {
    super("Hasil Azure tidak valid.");
    this.name = "InvalidOcrResultError";
  }
}

function invalid(): never {
  throw new InvalidOcrResultError();
}

function record(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid();
  }
  return value as UnknownRecord;
}

function integer(value: unknown, minimum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum) return invalid();
  return Number(value);
}

function optionalPositiveInteger(value: unknown): number {
  if (value === undefined) return 1;
  return integer(value, 1);
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalid();
  return value;
}

function pageText(page: UnknownRecord): string {
  if (page.lines === undefined) return "";
  return array(page.lines)
    .map((line) => {
      const content = record(line).content;
      if (typeof content !== "string") return invalid();
      return content;
    })
    .join("\n");
}

function pageConfidence(page: UnknownRecord): {
  total: number;
  weight: number;
} {
  if (page.words === undefined) return { total: 0, weight: 0 };

  let total = 0;
  let weight = 0;
  for (const item of array(page.words)) {
    const word = record(item);
    if (typeof word.content !== "string" || word.confidence === undefined) {
      continue;
    }
    const confidence = Number(word.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      continue;
    }
    const characters = Array.from(word.content).length;
    if (characters === 0) continue;
    total += confidence * characters;
    weight += characters;
  }
  return { total, weight };
}

function globalPage(part: PartJobRecord, localPage: unknown): number {
  const local = integer(localPage, 1);
  const page = part.start_page + local - 1;
  if (page > part.end_page) return invalid();
  return page;
}

function tableLocalPage(table: UnknownRecord): number {
  const regions = array(table.boundingRegions);
  const firstRegion = regions[0];
  if (firstRegion === undefined) return invalid();
  return integer(record(firstRegion).pageNumber, 1);
}

function collectPart(
  part: PartJobRecord,
  pages: Map<number, PageData>,
  tables: TableData[],
): void {
  if (part.azure_status !== "succeeded" || part.azure_result === undefined) {
    return invalid();
  }
  const result = record(part.azure_result);
  for (const value of array(result.pages)) {
    const page = record(value);
    const originalPage = globalPage(part, page.pageNumber);
    if (pages.has(originalPage)) return invalid();
    const confidence = pageConfidence(page);
    pages.set(originalPage, {
      page: originalPage,
      text: pageText(page),
      confidenceTotal: confidence.total,
      confidenceWeight: confidence.weight,
    });
  }

  if (result.tables === undefined) return;
  for (const [order, value] of array(result.tables).entries()) {
    const table = record(value);
    tables.push({
      page: globalPage(part, tableLocalPage(table)),
      order,
      table,
    });
  }
}

function normalizeTable(
  source: UnknownRecord,
  page: number,
  sequence: number,
): NormalizedOcrTable {
  const declaredRows = integer(source.rowCount, 1);
  const declaredColumns = integer(source.columnCount, 1);
  const cells = array(source.cells).map(record);
  let rowCount = declaredRows;
  let columnCount = declaredColumns;

  for (const cell of cells) {
    const row = integer(cell.rowIndex, 0);
    const column = integer(cell.columnIndex, 0);
    rowCount = Math.max(rowCount, row + optionalPositiveInteger(cell.rowSpan));
    columnCount = Math.max(
      columnCount,
      column + optionalPositiveInteger(cell.columnSpan),
    );
  }

  const grid = Array.from({ length: rowCount }, () =>
    Array<string>(columnCount).fill(""),
  );
  for (const cell of cells) {
    const row = integer(cell.rowIndex, 0);
    const column = integer(cell.columnIndex, 0);
    if (typeof cell.content !== "string") return invalid();
    const targetRow = grid[row];
    if (targetRow === undefined || column >= columnCount) return invalid();
    targetRow[column] = cell.content;
  }

  const hasHeader = cells.some(
    (cell) => cell.rowIndex === 0 && cell.kind === "columnHeader",
  );
  const header = hasHeader ? (grid[0] ?? []) : [];
  const rows = hasHeader ? grid.slice(1) : grid;

  return {
    table_ref: `p${String(page)}-t${String(sequence)}`,
    page,
    header,
    rows,
    structure: {
      normalized: true,
      row_count: rows.length,
      column_count: columnCount,
    },
  };
}

export function normalizeOcrResult(file: FileJobRecord): OcrFileResult {
  const pageCount = integer(file.page_count, 1);
  if (file.parts === undefined || file.parts.length === 0) return invalid();

  const pages = new Map<number, PageData>();
  const tables: TableData[] = [];
  const orderedParts = [...file.parts].sort(
    (left, right) => left.start_page - right.start_page,
  );
  for (const part of orderedParts) collectPart(part, pages, tables);

  if (pages.size !== pageCount) return invalid();
  const orderedPages = [...pages.values()].sort(
    (left, right) => left.page - right.page,
  );
  if (orderedPages.some((page, index) => page.page !== index + 1)) {
    return invalid();
  }

  tables.sort(
    (left, right) => left.page - right.page || left.order - right.order,
  );
  const tableSequence = new Map<number, number>();
  const normalizedTables = tables.map(({ page, table }) => {
    const sequence = (tableSequence.get(page) ?? 0) + 1;
    tableSequence.set(page, sequence);
    return normalizeTable(table, page, sequence);
  });

  const confidenceTotal = orderedPages.reduce(
    (total, page) => total + page.confidenceTotal,
    0,
  );
  const confidenceWeight = orderedPages.reduce(
    (total, page) => total + page.confidenceWeight,
    0,
  );

  return {
    client_file_id: file.client_file_id,
    status: "success",
    document: {
      file_name: file.file_name,
      language: file.language,
      page_count: pageCount,
    },
    data: {
      text: orderedPages.map((page) => page.text).join("\n\n"),
      tables: normalizedTables,
    },
    confidence:
      confidenceWeight === 0
        ? null
        : Number((confidenceTotal / confidenceWeight).toFixed(6)),
  };
}
