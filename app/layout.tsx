import type { Metadata } from "next";
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
