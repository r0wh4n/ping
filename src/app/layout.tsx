import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// opsz: the same Inter draws as its display cut at headline sizes.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap", axes: ["opsz"] });
const jbmono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jbmono", display: "swap" });

const DESC =
  "Private chat built around a username you own. Claim your @handle, add people by name, and talk in real time — end-to-end encrypted DMs, no phone number, no feed, free.";

export const metadata: Metadata = {
  metadataBase: new URL("https://theping.chat"),
  title: { default: "Ping — one handle, all your people", template: "%s · Ping" },
  description: DESC,
  applicationName: "Ping",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, title: "Ping", statusBarStyle: "black-translucent" },
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
  openGraph: {
    type: "website",
    siteName: "Ping",
    url: "https://theping.chat",
    title: "Ping — one handle, all your people",
    description: DESC,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Ping — private chat" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Ping — one handle, all your people",
    description: DESC,
    images: ["/og.png"],
  },
};

// Ping is black, always: one palette, no theme to pick or to flash on load.
export const viewport: Viewport = { themeColor: "#000000", colorScheme: "dark" };

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jbmono.variable} antialiased`}
    >
      <body className="min-h-dvh flex flex-col">{children}</body>
    </html>
  );
}
