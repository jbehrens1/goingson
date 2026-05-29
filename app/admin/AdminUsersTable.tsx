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
                      <SubscriptionList
                        userId={u.id}
                        subs={u.subscriptions}
                        onChanged={(newSubs) =>
                          setUsers((prev) =>
                            prev.map((row) =>
                              row.id === u.id
                                ? { ...row, subscriptions: newSubs }
                                : row,
                            ),
                          )
                        }
                      />
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
function SubscriptionList({
  userId,
  subs,
  onChanged,
}: {
  userId: string;
  subs: NewsletterSubscription[];
  onChanged: (next: NewsletterSubscription[]) => void;
}) {
  return (
    <div className="admin-sub-list">
      {subs.map((s) => (
        <SubscriptionCard
          key={s.id}
          userId={userId}
          sub={s}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function SubscriptionCard({
  userId,
  sub,
  onChanged,
}: {
  userId: string;
  sub: NewsletterSubscription;
  onChanged: (next: NewsletterSubscription[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<NewsletterSubscription>(sub);
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function callApi(
    action: "patch" | "delete",
    payload?: Record<string, unknown>,
  ) {
    setError(null);
    const res = await fetch("/api/admin/user-subscription", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, action, subscriptionId: sub.id, ...payload }),
    });
    const json = (await res.json()) as {
      ok: boolean;
      state?: { subscriptions: NewsletterSubscription[] };
      error?: string;
    };
    if (!json.ok || !json.state) {
      setError(json.error ?? "Update failed");
      return;
    }
    onChanged(json.state.subscriptions);
    setEditing(false);
  }

  function save() {
    startSave(async () => {
      // Only send fields the admin actually changed. Avoids clobbering
      // surpriseHistory + lastSentAt which the user-facing UI also leaves alone.
      const patch: Partial<NewsletterSubscription> = {};
      const keys: (keyof NewsletterSubscription)[] = [
        "name", "region", "schedule", "lookaheadDays",
        "types", "towns", "venues", "surprise",
        "center", "radiusMi",
      ];
      for (const k of keys) {
        if (JSON.stringify(draft[k]) !== JSON.stringify(sub[k])) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (patch as any)[k] = draft[k];
        }
      }
      await callApi("patch", { patch });
    });
  }

  function remove() {
    if (!confirm(`Delete "${sub.name || "this subscription"}" for this user?`)) return;
    startSave(async () => {
      await callApi("delete");
    });
  }


  const typeLabels =
    sub.types.length === 0
      ? "All types"
      : sub.types
          .map((t) => TYPE_LABELS[t] ?? t)
          .join(", ");
  const townList = sub.towns ?? [];
  const townSummary =
    townList.length === 0
      ? "All towns"
      : townList.length <= 5
      ? townList.join(", ")
      : `${townList.slice(0, 5).join(", ")} + ${townList.length - 5} more`;
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
        <div className="admin-sub-card-actions">
          {editing ? (
            <>
              <button
                type="button"
                className="ghost-btn"
                disabled={saving}
                onClick={save}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="ghost-btn"
                disabled={saving}
                onClick={() => {
                  setDraft(sub);
                  setEditing(false);
                  setError(null);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
              <button
                type="button"
                className="ghost-btn sub-delete-btn"
                disabled={saving}
                onClick={remove}
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>
      {error && <p className="hint hint-error">{error}</p>}
      {editing ? (
        <dl className="admin-sub-card-grid">
          <dt>Name</dt>
          <dd>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </dd>
          <dt>Region</dt>
          <dd>
            <input
              type="text"
              value={draft.region}
              onChange={(e) => setDraft({ ...draft, region: e.target.value })}
              placeholder="e.g. lbi, metrowest"
            />
          </dd>
          <dt>Schedule</dt>
          <dd>
            <select
              value={draft.schedule}
              onChange={(e) =>
                setDraft({ ...draft, schedule: e.target.value as "daily" | "weekly" })
              }
            >
              <option value="weekly">weekly</option>
              <option value="daily">daily</option>
            </select>{" "}
            <input
              type="number"
              min={1}
              max={30}
              value={draft.lookaheadDays}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  lookaheadDays: Math.max(1, Math.min(30, Number(e.target.value) || 1)),
                })
              }
              style={{ width: "5rem" }}
            />{" "}
            <span className="muted small">d lookahead</span>
          </dd>
          <dt>Types</dt>
          <dd>
            <input
              type="text"
              value={draft.types.join(", ")}
              placeholder="comma-separated (e.g. live-music, theater) — empty = all"
              onChange={(e) =>
                setDraft({
                  ...draft,
                  types: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean) as typeof draft.types,
                })
              }
            />
          </dd>
          <dt>Towns</dt>
          <dd>
            <input
              type="text"
              value={(draft.towns ?? []).join(", ")}
              placeholder="comma-separated (e.g. Wellesley, Natick) — empty = all"
              onChange={(e) =>
                setDraft({
                  ...draft,
                  towns: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </dd>
          <dt>Venues</dt>
          <dd>
            <input
              type="text"
              value={draft.venues.join(", ")}
              placeholder="comma-separated — empty = all"
              onChange={(e) =>
                setDraft({
                  ...draft,
                  venues: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </dd>
          <dt>Surprise</dt>
          <dd>
            <select
              value={draft.surprise}
              onChange={(e) =>
                setDraft({ ...draft, surprise: e.target.value as typeof draft.surprise })
              }
            >
              <option value="never">never</option>
              <option value="sometimes">sometimes</option>
              <option value="often">often</option>
            </select>
          </dd>
        </dl>
      ) : (
        <dl className="admin-sub-card-grid">
          <dt>Types</dt>
          <dd>{typeLabels}</dd>
          <dt>Towns</dt>
          <dd>{townSummary}</dd>
          <dt>Venues</dt>
          <dd>{venueSummary}</dd>
          <dt>Location</dt>
          <dd>{center}</dd>
          <dt>Surprise</dt>
          <dd>{sub.surprise}</dd>
          <dt>Last sent</dt>
          <dd>{lastSent}</dd>
        </dl>
      )}
    </div>
  );
}
