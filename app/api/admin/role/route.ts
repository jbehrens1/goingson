import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireRole, type Role } from "@/lib/auth";

export const runtime = "nodejs";

const ROLES: Role[] = ["regular", "admin", "owner"];

export async function POST(req: Request) {
  try {
    await requireRole("owner");
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }

  let body: { userId?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { userId, role } = body;
  if (!userId || typeof userId !== "string") {
    return NextResponse.json({ ok: false, error: "userId required" }, { status: 400 });
  }
  if (!role || !ROLES.includes(role as Role)) {
    return NextResponse.json(
      { ok: false, error: `role must be one of: ${ROLES.join(", ")}` },
      { status: 400 },
    );
  }

  const client = await clerkClient();
  const target = await client.users.getUser(userId);
  await client.users.updateUser(userId, {
    publicMetadata: { ...target.publicMetadata, role },
  });
  return NextResponse.json({ ok: true });
}
