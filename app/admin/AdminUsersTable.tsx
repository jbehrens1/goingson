"use client";

import { useState, useTransition } from "react";
import type { Role } from "@/lib/auth";

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: number;
};

const ROLES: Role[] = ["regular", "admin", "owner"];

export function AdminUsersTable({ initialUsers }: { initialUsers: UserRow[] }) {
  const [users, setUsers] = useState(initialUsers);
  const [pendingId, setPendingId] = useState<string | null>(null);
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

  return (
    <>
      {error && <p className="hint hint-error">{error}</p>}
      <table className="sources-table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Role</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
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
                {pendingId === u.id && <span className="muted small"> …saving</span>}
              </td>
              <td className="muted small">
                {new Date(u.createdAt).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
