// Basic newsletter reporting. Aggregates subscriber counts from Clerk +
// last-30-day send/click totals from public/newsletter-events.jsonl.
//
// For deep analytics (which event got most clicks last week, etc.) you can
// use the Resend dashboard at https://resend.com/emails — filter by tag.
// Once you outgrow either, migrate the JSONL into Postgres per the
// architecture notes.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { redirect } from "next/navigation";
import { authIsConfigured, getCurrentRole } from "@/lib/auth";
import { iterateAllUsers, stateFromUser } from "@/lib/newsletter/prefs";

export const dynamic = "force-dynamic";

type EventRow = {
  ts: string;
  type: string;
  region?: string;
  schedule?: string;
};

async function loadRecentEvents(): Promise<EventRow[]> {
  const file = path.join(process.cwd(), "public", "newsletter-events.jsonl");
  try {
    const raw = await readFile(file, "utf8");
    const cutoff = Date.now() - 30 * 86_400_000;
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as EventRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is EventRow => r !== null && new Date(r.ts).getTime() >= cutoff);
  } catch {
    return [];
  }
}

export default async function NewsletterAdminPage() {
  if (!authIsConfigured()) {
    return (
      <main className="sources-page">
        <h1>Newsletter</h1>
        <p className="hint hint-error">Auth is not configured.</p>
      </main>
    );
  }
  const role = await getCurrentRole();
  if (role !== "admin" && role !== "owner") redirect("/sources");

  // Subscription counts, grouped by region + schedule. One user can have
  // multiple subscriptions, so totalSubs counts subscriptions (not users)
  // and uniqueUsers counts distinct users with ≥1 subscription.
  const byRegion = new Map<string, { daily: number; weekly: number; total: number }>();
  let totalSubs = 0;
  let uniqueUsers = 0;
  for await (const user of iterateAllUsers()) {
    const state = stateFromUser(user);
    if (state.subscriptions.length === 0) continue;
    uniqueUsers++;
    for (const sub of state.subscriptions) {
      totalSubs++;
      const r = byRegion.get(sub.region) ?? { daily: 0, weekly: 0, total: 0 };
      r.total++;
      if (sub.schedule === "daily") r.daily++;
      else r.weekly++;
      byRegion.set(sub.region, r);
    }
  }

  // Send/click counts from the webhook log (last 30 days).
  const events = await loadRecentEvents();
  const eventBuckets: Record<string, number> = {
    "email.sent": 0,
    "email.delivered": 0,
    "email.opened": 0,
    "email.clicked": 0,
    "email.bounced": 0,
    "email.complained": 0,
  };
  for (const e of events) {
    eventBuckets[e.type] = (eventBuckets[e.type] ?? 0) + 1;
  }

  return (
    <main className="sources-page">
      <header>
        <h1>Newsletter</h1>
        <p className="muted">
          Subscriber counts + last-30-day delivery activity. Visit{" "}
          <a href="https://resend.com/emails" target="_blank" rel="noopener noreferrer">
            resend.com/emails
          </a>{" "}
          for per-email open/click detail and live deliverability stats.
        </p>
      </header>

      <section style={{ marginTop: "1.5rem" }}>
        <h2>
          Subscriptions — {totalSubs} across {uniqueUsers} user
          {uniqueUsers === 1 ? "" : "s"}
        </h2>
        <table className="sources-table">
          <thead>
            <tr>
              <th>Region</th>
              <th>Daily</th>
              <th>Weekly</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {[...byRegion.entries()].map(([r, c]) => (
              <tr key={r}>
                <td>{r}</td>
                <td className="sources-count-cell">{c.daily}</td>
                <td className="sources-count-cell">{c.weekly}</td>
                <td className="sources-count-cell">
                  <strong>{c.total}</strong>
                </td>
              </tr>
            ))}
            {byRegion.size === 0 && (
              <tr>
                <td colSpan={4} className="muted small">
                  No subscribers yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h2>Delivery activity — last 30 days</h2>
        <table className="sources-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(eventBuckets).map(([type, n]) => (
              <tr key={type}>
                <td>
                  <code>{type}</code>
                </td>
                <td className="sources-count-cell">{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small" style={{ marginTop: "0.5rem" }}>
          {events.length === 0 &&
            "No webhook events captured yet. Configure the Resend webhook at /api/webhooks/resend to start logging."}
        </p>
      </section>
    </main>
  );
}
