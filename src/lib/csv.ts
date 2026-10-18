// Minimal RFC 4180 CSV parser and writer (quoted fields, escaped quotes, embedded newlines).

export function parseCsv(text: string): { header: string[]; rows: Record<string, string>[]; error?: string } {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const src = text.replace(/^﻿/, "");
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') {
      if (field.length > 0) return { header: [], rows: [], error: `Unexpected quote inside an unquoted field on record ${records.length + 1}.` };
      inQuotes = true; i++; continue;
    }
    if (c === ",") { record.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { record.push(field); records.push(record); record = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (inQuotes) return { header: [], rows: [], error: "Unterminated quoted field at end of file." };
  if (field.length > 0 || record.length > 0) { record.push(field); records.push(record); }
  const nonEmpty = records.filter((r) => !(r.length === 1 && r[0].trim() === ""));
  if (nonEmpty.length === 0) return { header: [], rows: [], error: "File is empty." };
  const header = nonEmpty[0].map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < nonEmpty.length; r++) {
    const vals = nonEmpty[r];
    if (vals.length !== header.length) {
      return { header, rows, error: `Row ${r + 1} has ${vals.length} fields; header has ${header.length}.` };
    }
    rows.push(Object.fromEntries(header.map((h, k) => [h, vals[k]])));
  }
  return { header, rows };
}

function cell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  // Neutralize spreadsheet formula injection in exported files.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: string[], rows: Record<string, unknown>[]): string {
  return [header.join(","), ...rows.map((r) => header.map((h) => cell(r[h])).join(","))].join("\n") + "\n";
}
