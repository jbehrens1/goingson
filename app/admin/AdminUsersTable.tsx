"use client";

import { Fragment, useState, useTransition } from "react";
import type { Role } from "@/lib/auth";
import { TYPE_LABELS } from "@/lib/categorize";
import type { NewsletterSubscription } from "@/lib/newsletter/types";

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: number;
  subscriptions: NewsletterSubscription[];
};

const ROLES: Role[] = ["regular", "admin", "owner"];

export function AdminUsersTable({ initialUsers }: { initialUsers: UserRow[] }) {
  const [users, setUsers] = useState(initialUsers);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [_, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function changeRole(user: UserRow, nextRole: Role) {
    if (nextRole === user.role) return;
    const verb =
      ROLES.indexOf(nextRole) > ROLES.indexOf(user.role) ? "promote" : "demote";
    if (
      !confirm(
        `${verb[0].toUpperCase() + verb.slice(1)} ${user.email} from ${user.role} → ${nextRole}?`,
      )
    ) {
      return;
    }
    setError(null);
    setPendingId(user.id);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/role", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: user.id, role: nextRole }),
        });
        const json = (await res.json()) as { ok: boolean; error?: string };
        if (!json.ok) {
          setError(json.error ?? "Update failed");
          return;
        }
        setUsers((prev) =>
          prev.map((u) => (u.id === user.id ? { ...u, role: nextRole } : u)),
        );
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setPendingId(null);
      }
    });
  }

  function toggleExpanded(userId: string) {
    setExpandedId((prev) => (prev === userId ? null : userId));
  }

  return (
    <>
      {error && <p className="hint hint-error">{error}</p>}
      <table className="sources-table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Role</th>
            <th>Newsletters</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const subCount = u.subscriptions.length;
            const isExpanded = expandedId === u.id;
            return (
              <Fragment key={u.id}>
                <tr>
                  <td>{u.email}</td>
                  <td>{u.name}</td>
                  <td>
                    <select
                      value={u.role}
                      disabled={pendingId === u.id}
                      onChange={(e) => changeRole(u, e.target.value as Role)}
                      title="Change role"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    {pendingId === u.id && (
                      <span className="muted small"> …saving</span>
                    )}
                  </td>
                  <td>
                    {subCount === 0 ? (
                      <span className="muted small">—</span>
                    ) : (
                      <button
                        type="button"
                        className="link-btn admin-sub-toggle"
                        onClick={() => toggleExpanded(u.id)}
                        title={isExpanded ? "Hide details" : "Show subscription filters"}
                      >
                        {subCount} {subCount === 1 ? "sub" : "subs"}
                        <span className="admin-sub-caret" aria-hidden>
                          {isExpanded ? "▾" : "▸"}
                        </span>
                      </button>
                    )}
                  </td>
                  <td className="muted small">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                </tr>
                {isExpanded && subCount > 0 && (
                  <tr className="admin-sub-detail-row">
                    <td colSpan={5}>
                      <SubscriptionList subs={u.subscriptions} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/** Render every subscription on a user as a tidy parameter card. */
function SubscriptionList({ subs }: { subs: NewsletterSubscription[] }) {
  return (
    <div className="admin-sub-list">
      {subs.map((s) => (
        <SubscriptionCard key={s.id} sub={s} />
      ))}
    </div>
  );
}

function SubscriptionCard({ sub }: { sub: NewsletterSubscription }) {
  const typeLabels =
    sub.types.length === 0
      ? "All types"
      : sub.types
          .map((t) => TYPE_LABELS[t] ?? t)
          .join(", ");
  const venueSummary =
    sub.venues.length === 0
      ? "All venues"
      : sub.venues.length <= 3
      ? sub.venues.join(", ")
      : `${sub.venues.slice(0, 3).join(", ")} + ${sub.venues.length - 3} more`;
  const center =
    sub.center && sub.radiusMi
      ? `${sub.center.label} · ${sub.radiusMi} mi`
      : sub.center
      ? sub.center.label
      : "No location filter";
  const lastSent = sub.lastSentAt
    ? new Date(sub.lastSentAt).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "never";

  return (
    <div className="admin-sub-card">
      <div className="admin-sub-card-head">
        <span className="admin-sub-card-name">{sub.name || "(unnamed)"}</span>
        <span className="admin-sub-card-region">{sub.region}</span>
        <span className="admin-sub-card-schedule">
          {sub.schedule} · {sub.lookaheadDays}d lookahead
        </span>
      </div>
      <dl className="admin-sub-card-grid">
        <dt>Types</dt>
        <dd>{typeLabels}</dd>
        <dt>Venues</dt>
        <dd>{venueSummary}</dd>
        <dt>Location</dt>
        <dd>{center}</dd>
        <dt>Surprise</dt>
        <dd>{sub.surprise}</dd>
        <dt>Last sent</dt>
        <dd>{lastSent}</dd>
      </dl>
    </div>
  );
}
