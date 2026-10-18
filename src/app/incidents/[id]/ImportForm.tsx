"use client";

import { useActionState, useState } from "react";
import { importAction } from "@/app/server-actions";
import type { ImportResult } from "@/lib/importers";

type State = (ImportResult & { error?: string; filename?: string }) | null;

export function ImportForm({ incidentId, disabled }: { incidentId: string; disabled: boolean }) {
  const [state, action, pending] = useActionState<State, FormData>(importAction, null);
  // Controlled fields so the user's input survives a failed validation (React resets uncontrolled form fields after an action).
  const [kind, setKind] = useState("conversations");
  const [format, setFormat] = useState("");
  const [content, setContent] = useState("");
  return (
    <form action={action} className="stack" encType="multipart/form-data">
      <input type="hidden" name="incidentId" value={incidentId} />
      <div className="grid cols-2">
        <div className="field">
          <label htmlFor="kind">Evidence type</label>
          <select id="kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="conversations">Conversations (messages, speaker roles, versions)</option>
            <option value="transactions">Transactions (purchases, refund requests, refunds)</option>
            <option value="interactions">Later interactions (tickets, calls, emails)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="format">Format</label>
          <select id="format" name="format" value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="">Detect from file extension</option>
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="file">File</label>
        <input id="file" name="file" type="file" accept=".csv,.json,text/csv,application/json" />
        <div className="hint">Or paste content below. Files are validated in full before anything is stored; one invalid row rejects the whole file.</div>
      </div>
      <div className="field">
        <label htmlFor="content">Paste content</label>
        <textarea id="content" name="content" className="tall" value={content} onChange={(e) => setContent(e.target.value)} placeholder={kind === "conversations" ? '{"conversations":[{"conversation_id":"CONV-1","customer_id":"SYN-C-1","started_at":"2026-06-12T10:00:00-05:00","app_version":"assist-2026.06.1","order_id":"ORD-1","messages":[{"seq":1,"role":"customer","timestamp":"…","text":"…"}]}]}' : "transaction_id,customer_id,order_id,type,amount,currency,timestamp,status,item_category,sale_item,defective"} />
      </div>
      <div><button className="btn primary" type="submit" disabled={disabled || pending}>{pending ? "Validating…" : "Validate and import"}</button></div>

      {state && (state.ok ? (
        <div className="alert ok" role="status">
          <p><strong>Imported {state.recordCount} record(s)</strong> from {state.filename} as {state.batchId}.</p>
          {state.flagged.length > 0 && (
            <div className="alert warn" style={{ marginTop: ".5rem" }}>
              <p><strong>{state.flagged.length} item(s) contain instruction-like text.</strong> They were stored verbatim as untrusted data and will not be acted on. Reviewers will see a warning on the affected messages.</p>
              <ul>{state.flagged.map((f) => <li key={f.ref}><code>{f.ref}</code> — {f.patterns.join(", ")}</li>)}</ul>
            </div>
          )}
        </div>
      ) : (
        <div className="alert err" role="alert">
          <p><strong>Nothing was imported.</strong> {state.error ?? `${state.issues.length} validation issue(s) found. Fix them and try again.`}</p>
          {state.issues.length > 0 && (
            <div className="table-wrap" style={{ marginTop: ".5rem" }}>
              <table>
                <thead><tr><th>Row</th><th>Field</th><th>Problem</th></tr></thead>
                <tbody>{state.issues.slice(0, 50).map((i, k) => <tr key={k}><td>{i.row ?? "file"}</td><td><code>{i.field ?? "—"}</code></td><td>{i.message}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </form>
  );
}
