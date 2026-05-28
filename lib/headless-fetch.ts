// Optional headless-browser fetch fallback. Some venues (McCallum Theatre,
// many Cloudflare/Kemo-gated sites) require JavaScript execution before
// useful HTML is rendered. Server-side fetch can't get past those gates,
// so we offload to an external rendering service.
//
// Compatible with the Browserless `/scrape` and `/content` endpoints
// (https://docs.browserless.io/). To use:
//
//   1. Sign up for Browserless cloud OR self-host their Docker image.
//   2. Set HEADLESS_FETCH_URL in env, e.g.
//        export HEADLESS_FETCH_URL="https://chrome.browserless.io/content?token=YOUR_TOKEN"
//      (or for self-hosted: http://localhost:3010/content)
//   3. Mark blocked sources with `useHeadless: true` in their config.
//   4. The probe + adapters call `headlessFetch()` instead of `politeFetch()`
//      when the source asks for it. If the env var is unset, the call
//      no-ops with a warning so dev/local ingests still work.
//
// We deliberately don't add Playwright as a dep — that's a ~300MB binary
// install that Vercel can't host and would slow GitHub Actions ingests.

const HEADLESS_TIMEOUT_MS = 30_000;

/** Render `url` through an external headless-browser service and return the
 *  resulting HTML. Returns null (with a console.warn) when HEADLESS_FETCH_URL
 *  is unset so callers can fall through to politeFetch. */
export async function headlessFetch(url: string): Promise<string | null> {
  const endpoint = process.env.HEADLESS_FETCH_URL?.trim();
  if (!endpoint) {
    console.warn(
      `[headless-fetch] HEADLESS_FETCH_URL not set; cannot render ${url}. ` +
        `Set the env var to a Browserless-compatible /content endpoint.`,
    );
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEADLESS_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        // Wait for either DOMContentLoaded OR a typical event-card class
        // to appear. Browserless picks the first to resolve. Generous
        // timeout — some Kemo gates fire 2-3 redirects before settling.
        waitFor: 1500,
        gotoOptions: { waitUntil: "networkidle2", timeout: 25_000 },
      }),
    });
    if (!res.ok) {
      console.warn(
        `[headless-fetch] ${url}: HTTP ${res.status} from ${endpoint}`,
      );
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(
      `[headless-fetch] ${url}: ${(err as Error).message || "request failed"}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** True when the env var is set and headlessFetch is expected to work. */
export function isHeadlessConfigured(): boolean {
  return !!process.env.HEADLESS_FETCH_URL?.trim();
}
