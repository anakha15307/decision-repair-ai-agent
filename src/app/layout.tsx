import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { ACTORS, ROLE_LABELS } from "@/lib/actors";
import { currentActor, currentIncident } from "@/lib/session";
import { getDb } from "@/lib/db";
import { listIncidents } from "@/lib/incidents";
import { liveProviderConfigured } from "@/lib/analysis/anthropicProvider";
import { switchActor, switchIncident } from "./server-actions";

export const metadata: Metadata = {
  title: "Decision Repair",
  description: "Identify people potentially affected by an AI error, review their cases, and verify corrective actions.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const actor = await currentActor();
  const incident = await currentIncident();
  const incidents = listIncidents(getDb());
  const live = liveProviderConfigured();
  const returnTo = (await headers()).get("x-dr-path") ?? "/";

  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              <strong>Decision Repair</strong>
              <span>We fixed the AI. Have we fixed what happened to people?</span>
            </div>
            <Nav />
            <div className="sidebar-foot">
              <p>Prototype. All customer data is synthetic.</p>
              <p>This tool never sends messages, issues refunds, or changes customer records.</p>
            </div>
          </aside>
          <div className="main">
            <div className="topbar">
              {incidents.length > 0 && (
                <form action={switchIncident}>
                  <label htmlFor="incident-switch" className="sr-only">Current incident</label>
                  <select id="incident-switch" name="incident" defaultValue={incident?.id} style={{ maxWidth: 380 }}>
                    {incidents.map((i) => <option key={i.id} value={i.id}>{i.id} · {i.title}</option>)}
                  </select>
                  <button className="btn small" type="submit">Open</button>
                </form>
              )}
              <div className="spacer" />
              <form action={switchActor}>
                <label htmlFor="actor-switch" className="muted" style={{ margin: 0, fontWeight: 400 }}>Acting as</label>
                <select id="actor-switch" name="actor" defaultValue={actor.id}>
                  {ACTORS.map((a) => <option key={a.id} value={a.id}>{a.name} — {ROLE_LABELS[a.role]}</option>)}
                </select>
                <input type="hidden" name="returnTo" value={returnTo} />
                <button className="btn small" type="submit">Switch</button>
              </form>
            </div>
            <div className="notice" role="note">
              <span><b>Synthetic data</b> · fictional company and customers</span>
              <span>Analyzer: <b>{live ? "Live model configured (server-side)" : "Demo analyzer (rules-based) — no live model configured"}</b></span>
              <span>Role switching is a demo stand-in for sign-in</span>
            </div>
            <main id="main" className="content">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
