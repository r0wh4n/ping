import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
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

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#07070f" },
    { media: "(prefers-color-scheme: light)", color: "#eef0fb" },
  ],
};

// Runs before paint so the correct theme is applied with no flash of the wrong one.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

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
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh flex flex-col">{children}</body>
    </html>
  );
}
