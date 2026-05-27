import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { SiteHeader } from "./_components/SiteHeader";
import { authIsConfigured } from "@/lib/auth";

export const metadata: Metadata = {
  title: {
    default: "Goings On",
    template: "Goings On — %s",
  },
  description: "Local events aggregated from venues, towns, and calendars across the region.",
};

// Viewport meta tag — critical for mobile. Without `width=device-width`,
// iOS/Android browsers fall back to a 980px-wide layout viewport and shrink
// the page to fit, making everything render at ~37% scale (illegible).
// `maximumScale` is intentionally omitted so users can still pinch-zoom.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const body = (
    <body>
      <SiteHeader />
      {children}
    </body>
  );

  // ClerkProvider crashes hard if keys are missing. Allow the site to render
  // without auth during local setup / before Clerk env is configured.
  if (!authIsConfigured()) {
    return <html lang="en">{body}</html>;
  }
  return (
    <ClerkProvider>
      <html lang="en">{body}</html>
    </ClerkProvider>
  );
}
