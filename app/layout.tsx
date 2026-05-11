import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MetroWest Events",
  description: "Aggregated events from MetroWest Boston venues, towns, and calendars.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
