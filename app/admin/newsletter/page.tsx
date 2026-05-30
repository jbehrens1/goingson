// Basic newsletter reporting. Aggregates subscriber counts from Clerk.
// Per-email open/click rollups live on the Resend dashboard
// (https://resend.com/emails) — the local newsletter-events.jsonl rollup
// was killed because Vercel's serverless filesystem is read-only at
// runtime, so the append-on-webhook approach never actually persisted.
// When we want this rollup back, the webhook needs a real backing store
// (Vercel KV / Postgres / a logging backend) — see the route handler at
// app/api/webhooks/resend/route.ts for context.

import { redirect } from "next/navigation";
import { authIsConfigured, getCurrentRole } from "@/lib/auth";
import { iterateAllUsers, stateFromUser } from "@/lib/newsletter/prefs";

export const dynamic = "force-dynamic";

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
        <h2>Delivery activity</h2>
        <p className="muted">
          Open / click / bounce metrics live on the{" "}
          <a
            href="https://resend.com/emails"
            target="_blank"
            rel="noopener noreferrer"
          >
            Resend dashboard
          </a>
          . Filter by tag <code>region:&lt;name&gt;</code> or{" "}
          <code>schedule:daily</code> / <code>weekly</code> for cohort views.
        </p>
        <p className="muted small">
          The local rollup is on hold — Vercel&rsquo;s serverless filesystem is
          read-only at runtime, so the webhook can&rsquo;t persist events to a
          file. When we want this page to show counts again, the webhook
          needs a real backing store (KV, Postgres, or a logging backend).
        </p>
      </section>
    </main>
  );
}
