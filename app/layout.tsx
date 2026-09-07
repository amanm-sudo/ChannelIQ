import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "ChannelIQ — what to make next, backed by your own numbers",
  description:
    "Paste in a YouTube channel. ChannelIQ runs an agent pipeline over its real upload history and a scan of the creators beating it, then hands back a numbered, justified plan for the next video.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#08090c",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink-950 antialiased">{children}</body>
    </html>
  );
}
