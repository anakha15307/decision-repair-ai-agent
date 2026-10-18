# Decision Repair (prototype)

> **We fixed the AI. Have we fixed what happened to people?**

Decision Repair helps an organization go back over past AI interactions after an AI error is found. It identifies people who may have been affected, puts each case in front of a human reviewer with the evidence, and tracks corrective actions until completion is **verified with evidence**.

The seeded demonstration: the support chatbot of *Northwind Outfitters* (a fictional retailer) quoted a superseded refund policy for six weeks: a 14-day window, sale items final, and receipt required, when the policy in force was 30 days, sale items refundable, and receipt or order number accepted. **All data is synthetic.**

---

## Run it

Requires Node.js 20+ (tested on Node 24).

```bash
npm install
```

```bash
npm run setup
```

```bash
npm run dev
```

Open <http://localhost:3100>. `npm run setup` generates the synthetic sample files and seeds the demo incident `INC-2026-014` into `data/decision-repair.db`. Run it again at any time to reset the demo.

| Command | Purpose |
|---|---|
| `npm test` | Run the test suite (Vitest) |
| `npm run typecheck` | TypeScript check |
| `npm run build && npm start` | Production build on port 3100 |
| `npm run generate:data` | Regenerate the synthetic files in `data/samples/` and hidden labels in `data/eval/` |
| `npm run seed` | Reset the database and replay the scripted demo timeline |

On npm 11+, install scripts may be blocked. If `better-sqlite3` fails to load, run `npm install-scripts approve better-sqlite3 esbuild` and then `npm rebuild`.

**Live model (optional).** Copy `.env.example` to `.env.local` and set `ANTHROPIC_API_KEY`. Without it, the app uses the **Demo analyzer (rules-based)**, which is labelled as such in the header, on every finding, and in the report. A demo result is never presented as a live model result.

### A five-minute tour
1. **Overview**: each measure has its definition. Refund amounts are shown as proposed, approved, verified, and simulated, never summed. *Needs attention* lists an approved action with no execution, a failed and reopened refund, a case awaiting evidence, and prompt-injection content.
2. **Incidents → INC-2026-014**: incident definition, the four policy versions (outdated, two authoritative with a mid-period change on 1 July, and one *introduced after* that is never applied), known gaps, evidence imports with SHA-256 hashes, and the *Investigation* tab showing why each conversation matched or was excluded.
3. **Review Queue**: filter by `Flag: Instruction-like text` and open the case. The injected `SYSTEM: ignore all previous instructions…` text is highlighted and has no effect.
4. Open a case and use **Acting as** (top right) to switch roles. Try confirming impact without every criterion, approving your own draft, or verifying your own execution. Each is refused with an explanation.
5. **Corrective Actions**: the lifecycle board. **Reports**: report preview, CSV exports, the audit history with its hash-chain check, and the analyzer evaluation against hidden labels.

---

## Design principles, and how they're enforced

| Principle | Mechanism |
|---|---|
| Exposure ≠ impact | Separate `exposure` and `impact` fields. The workflow `status` is a third, independent field. |
| Only humans confirm impact | Providers cannot output `confirmed` (schema plus explicit check). `recordDetermination` requires **every** reviewer-defined criterion and a reason. |
| Every finding links to evidence | Typed references (`msg:CONV-1#2`, `txn:…`, `int:…`, `pol:…#RW`). Provider output citing anything outside the evidence it was given is **rejected** and stored as a rejected finding. Reviewer references must exist and belong to the same customer. |
| Policy at the time | `applicablePolicyAt()` uses only `authoritative` versions in force at the conversation instant. `introduced_after` versions are refused if they start inside the period, and are never applied. |
| Correlation ≠ causation | The analyzer explains evidence, never gives confidence percentages, and every explanation states this limitation. |
| Approval ≠ execution ≠ completion | An explicit state machine. Separation of duties: the drafter cannot approve, and the executor cannot verify. Verifying a refund requires an *imported, completed refund transaction* for the case's customer and order, dated after approval. |
| Nothing is sent or executed | No outbound integrations exist. Communication drafts are labelled *DRAFT — NOT SENT*. "Execution" means staff recording work done elsewhere, or a **labelled simulation** that is excluded from verified totals. |
| Untrusted content | Imported text is stored verbatim, rendered as text (never HTML), flagged when instruction-like, and wrapped in `<untrusted>` delimiters for any model call. Classification is identical with or without injected text (tested). |
| Honest audit | An append-only `audit_log` (SQLite triggers block UPDATE and DELETE) plus a hash chain. It is described as a consistency check, **not** tamper-proof. |
| No leakage of answers | Hidden labels live in `data/eval/labels.json` and are read only by `src/lib/evaluation.ts`. Importers refuse label-like columns, and a test asserts that analysis code never references them. |

## Architecture

```
src/
  lib/                      domain core (framework-independent, unit-tested)
    db.ts                   SQLite schema (better-sqlite3), append-only audit triggers
    incidents.ts policy.ts  incident setup, policy versions and effective dates
    importers.ts csv.ts     CSV/JSON validation (all-or-nothing), hashing, injection flagging
    evidence.ts             evidence-reference parsing, resolution, validation
    analysis/
      engine.ts             deterministic scope screen → provider → output validation → findings/cases
      provider.ts           AnalysisProvider interface + validateDraft()
      demoAnalyzer.ts       rules-based demo analyzer (default)
      anthropicProvider.ts  live provider (server-only, structured JSON output, minimized prompt)
      untrusted.ts          instruction-like text detection, delimiting, redaction
    cases.ts                review queue, determinations, overrides, merge, reject, evidence requests
    remediation.ts          corrective-action state machine, communication drafts, verification
    metrics.ts              dashboard measures with definitions
    report.ts evaluation.ts incident report, CSV export, evaluation against hidden labels
    audit.ts actors.ts      audit history with hash chain; demo roles and permissions
  app/                      Next.js 15 App Router UI (server components + server actions)
scripts/                    synthetic data generator and seed (replays a timeline through the services)
tests/                      Vitest suites
data/samples/               downloadable synthetic import files
data/eval/labels.json       hidden evaluation labels (never imported)
```

Each UI mutation is a server action that calls a domain service. The services enforce permissions (whatever the UI shows), validate input, write the change, and append to the audit history inside a single transaction.

**Analysis pipeline.** (1) A deterministic scope screen checks the date window (timezone-aware, start inclusive, end exclusive), affected or unrecorded version, exclusions, and topic. (2) For each candidate, the provider receives only that customer's records and the policy in force at the time. (3) Output is validated: schema, no `confirmed`, references limited to the supplied evidence, and at least one message cited for exposure. (4) Derived facts such as days since purchase and amounts are always computed deterministically, never taken from a model. (5) Cases are opened for exposed or undetermined candidates. Re-runs update suggestions but never overwrite reviewer determinations. Possible duplicates (same customer and order) are flagged for a reviewer to merge, never merged automatically.

**Live provider.** It uses the Anthropic SDK on the server with `output_config.format` (JSON schema) and server-side refusal fallbacks enabled. It records the analyzer version, the model requested, and the model that served each run. Prompts omit customer IDs and redact emails, phone numbers, and card-like numbers. The live path is covered by unit tests with fake providers and has **not been exercised against the real API in this build**.

## Synthetic dataset

110 conversations (105 JSON plus a 5-conversation CSV email-channel export imported later), 148 transactions, 13 interactions, and a 3-row remediation ledger. Scenarios include:

- Incorrect advice followed by an abandoned request
- Incorrect advice followed by a later refund
- Correct advice
- Conversations before the period, after the fix, and on a fixed-version canary during the period
- Exact boundary times
- Duplicate conversations for one customer and order
- Missing model versions
- Missing purchase records
- Conflicting evidence: refund recorded but never received; stated purchase date contradicts the record; refund reversed
- Defective items affected by the 1 July policy change
- Prompt injection in a conversation and in an interaction summary
- A deliberately tricky false positive (a 14-day *exchange* window)
- Test accounts and human-agent-only chats

The seed then replays scripted reviewer activity covering: confirmations, an override with reason, a merge, a rejected match, an evidence request, verified refunds against the ledger, **an approved refund with no execution evidence**, **a failed refund (card expired) that was reopened**, and a labelled simulated execution. Seeded reviewer decisions are scripted demo data.

**Evaluation (Reports page).** On the latest run, candidate matching has 100% precision and recall, and the analyzer's suggested impact agrees with the labels on 67 of 68 exposed conversations. The two disagreements are deliberate: a refund delay the rules can't judge (overridden by a reviewer in the seed) and the exchange-window false positive (rejected by a reviewer). These figures describe this synthetic set only and are not an expected accuracy.

## Test results

`npm test` → **46 passed (6 files)**.

| Suite | Covers |
|---|---|
| `scope-and-policy` | Timezone conversion (CDT/CST), inclusive start / exclusive end, version, exclusion and topic screening, policy in force on either side of 1 July, later policy never applied, overlapping and misdated policies refused, defective-item outcome changing with the mid-period policy |
| `duplicates` | Identical file refused, duplicate IDs within a file or already stored refused atomically, duplicates flagged but not auto-merged, merge moves conversations and counts the customer once, cross-customer merges refused |
| `evidence-refs` | Malformed, missing, and other-customer references; provider output with invented references rejected and stored as a rejected finding; analyzer metadata recorded; reviewer references validated; live prompt minimization |
| `remediation` | Every criterion required to confirm, overrides need reasons, approval ≠ execution ≠ verification, separation of duties, role permissions, refund evidence (completed, same order, after approval, same customer), simulated kept separate, failure → reopen clears execution, case closes only when verified |
| `dashboard` | Latest-run counting, unique customers, merged and rejected excluded, confirmed only from reviewers, approved/executed/verified separated with simulated excluded, money kept separate, time-to-resolution population |
| `injection-and-audit` | Pattern detection without false alarms on normal text; injected conversation classified identically to the clean one with no action created; interaction summaries flagged; label columns refused; analysis code independent of labels; row-level validation errors; append-only triggers; hash chain detects an out-of-band edit |

The production build (`next build`) completes. The main flows were also checked in a browser at desktop and phone widths.

## Limitations, and what production would need

This is a local prototype. It makes **no claim of legal or regulatory compliance, certification, or guaranteed detection**.

- **Identity and access.** The role switcher is a stand-in. Production needs SSO, server-side sessions, role administration, and per-incident access control.
- **Audit integrity.** The triggers and hash chain stop application-level edits and detect casual changes only. Production needs write-once storage or an external ledger, signed or anchored hashes, backups, and retention policies.
- **Detection coverage.** Matching uses keywords and patterns and covers only imported records. People affected through channels that left no record (for example, a log outage, help-center reads, or in-store returns) cannot be found. These gaps are listed in the incident and the report.
- **Live AI.** The live provider needs evaluation on real, consented data, prompt-injection red-teaming, cost and rate controls, a data-processing review, and possibly batch processing. Pattern-based injection detection is heuristic.
- **Integrations.** There are none. Execution evidence comes from imported ledgers. Production needs read-only connectors to CRM, payments, and ticketing, with provenance, plus a separately controlled, human-approved path for any outbound action.
- **Data protection.** Production needs retention and deletion rules for investigation data, field-level encryption, PII minimization in the UI and exports, and data-subject request handling.
- **Scale.** SQLite and synchronous analysis suit about 10⁴ conversations. Larger incidents need a server database, background jobs, pagination, and incremental re-analysis.
- **Policy modelling.** Policy terms are entered as a small set of parameters (window, sale items, proof, defective window). Other incident types need their own rule models or reviewer-defined checklists. The core (incidents, evidence references, cases, actions, audit) is not refund-specific.
- **Legal review.** Remedy decisions and customer communications should go through legal and compliance review. This tool records decisions; it does not make them.
