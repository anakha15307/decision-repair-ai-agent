import fs from "node:fs";
import path from "node:path";
import { generateDataset, POLICY_TEXTS } from "./dataset";
import { toCsv } from "../src/lib/csv";

const root = process.cwd();
const samples = path.join(root, "data", "samples");
const evalDir = path.join(root, "data", "eval");
fs.mkdirSync(samples, { recursive: true });
fs.mkdirSync(evalDir, { recursive: true });

const ds = generateDataset();
const write = (dir: string, name: string, content: string) => fs.writeFileSync(path.join(dir, name), content);

write(samples, "conversations.json", JSON.stringify({ conversations: ds.conversationsMain }, null, 2) + "\n");

const lateRows = ds.conversationsLate.flatMap((c) =>
  c.messages.map((m) => ({ conversation_id: c.conversation_id, customer_id: c.customer_id, channel: c.channel, app_version: c.app_version ?? "", order_id: c.order_id ?? "", message_seq: m.seq, role: m.role, timestamp: m.timestamp, text: m.text })),
);
write(samples, "conversations-email-export.csv", toCsv(["conversation_id", "customer_id", "channel", "app_version", "order_id", "message_seq", "role", "timestamp", "text"], lateRows));

const txnHeader = ["transaction_id", "customer_id", "order_id", "type", "amount", "currency", "timestamp", "status", "item_category", "sale_item", "defective"];
write(samples, "transactions.csv", toCsv(txnHeader, ds.transactions as unknown as Record<string, unknown>[]));
write(samples, "remediation-ledger.csv", toCsv(txnHeader, ds.remediationLedger as unknown as Record<string, unknown>[]));
write(samples, "interactions.json", JSON.stringify(ds.interactions, null, 2) + "\n");

for (const [v, text] of Object.entries(POLICY_TEXTS)) write(samples, `policy-refund-${v}.txt`, text + "\n");

// Deliberately invalid file for demonstrating validation errors.
write(samples, "invalid-transactions.csv", [
  txnHeader.join(","),
  "TXN-X1,SYN-C-9999,ORD-1,purchase,49.00,USD,2026-06-12T10:00:00-05:00,settled,apparel,false,false",
  "TXN-X2,SYN-C-9999,ORD-1,refund,abc,USD,2026-06-13T10:00:00-05:00,completed,,,",
  "TXN-X3,,ORD-2,purchase,10.00,usd,13 June 2026,settled,apparel,maybe,false",
  "TXN-X1,SYN-C-9999,ORD-1,chargeback,49.00,USD,2026-06-14T10:00:00-05:00,completed,,,",
].join("\n") + "\n");

// Hidden evaluation labels: stored outside the samples directory and never imported as evidence.
write(evalDir, "labels.json", JSON.stringify({
  note: "Hidden ground-truth labels for evaluating the analyzer. Do not import as evidence. Synthetic data only.",
  generated_from: "scripts/dataset.ts (seed 20260610)",
  labels: ds.labels,
}, null, 2) + "\n");

const total = ds.conversationsMain.length + ds.conversationsLate.length;
console.log(`Wrote ${total} conversations (${ds.conversationsMain.length} main + ${ds.conversationsLate.length} late CSV), ${ds.transactions.length} transactions, ${ds.interactions.length} interactions, ${ds.remediationLedger.length} ledger rows, ${ds.labels.length} hidden labels.`);
