import { readFile } from "node:fs/promises";
import path from "node:path";
import EventsView, { type EventsPayload } from "./EventsView";

export const dynamic = "force-dynamic";

async function loadEvents(): Promise<EventsPayload> {
  const filePath = path.join(process.cwd(), "public", "events.json");
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as EventsPayload;
}

function canRefresh(): boolean {
  // Same logic as the /api/refresh route — true only when the filesystem is
  // writable. Lets the client hide the button on Vercel/Cloudflare.
  return !(
    process.env.VERCEL === "1" ||
    process.env.CF_PAGES === "1" ||
    process.env.READONLY === "1"
  );
}

export default async function Home() {
  const initial = await loadEvents();
  return <EventsView initial={initial} canRefresh={canRefresh()} />;
}
