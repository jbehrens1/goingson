import { auth } from "@clerk/nextjs/server";
import { SignInButton } from "@clerk/nextjs";
import { authIsConfigured } from "@/lib/auth";
import { listRegions } from "@/lib/sources-config";
import { SuggestForm } from "./SuggestForm";

export const dynamic = "force-dynamic";

export default async function SuggestPage() {
  const configured = authIsConfigured();
  const regions = await listRegions();

  let signedIn = false;
  if (configured) {
    const a = await auth();
    signedIn = Boolean(a.userId);
  }

  return (
    <main className="sources-page">
      <header>
        <h1>Suggest a venue</h1>
        <p className="muted">
          Know an event source we&rsquo;re missing? Tell us the name and URL.
          We&rsquo;ll probe the site to figure out how to pull events, and an admin
          will review before it goes live.
        </p>
      </header>

      {!configured && (
        <p className="hint hint-error">
          Auth is not configured. Suggestions are unavailable until Clerk env vars are set.
        </p>
      )}

      {configured && !signedIn && (
        <div className="suggest-signin">
          <p className="hint">
            Please sign in to submit a suggestion. We use your account to keep spam out
            and to credit you if the venue is added.
          </p>
          <SignInButton mode="modal">
            <button type="button" className="primary-btn">
              Sign in to suggest
            </button>
          </SignInButton>
        </div>
      )}

      {configured && signedIn && <SuggestForm regions={regions} />}
    </main>
  );
}
