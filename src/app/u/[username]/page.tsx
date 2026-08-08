import type { Metadata } from "next";
import ProfileClient from "./ProfileClient";

// Server-side profile lookup (public read) so shared links unfurl richly.
async function fetchProfile(username: string): Promise<{ username: string; status: string } | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  const uname = username.trim().toLowerCase().replace(/^@+/, "");
  try {
    const r = await fetch(
      `${url}/rest/v1/profiles?username=eq.${encodeURIComponent(uname)}&select=username,status`,
      { headers: { apikey: anon, Authorization: `Bearer ${anon}` }, cache: "no-store" }
    );
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ username: string }>;
}): Promise<Metadata> {
  const { username } = await params;
  const p = await fetchProfile(username);
  if (!p) return { title: "Not on Ping yet · Ping" };
  const title = `Add @${p.username} on Ping`;
  const description = p.status
    ? `“${p.status}” — say hi to @${p.username} on Ping.`
    : `@${p.username} is on Ping. Add them and start chatting.`;
  return {
    title,
    description,
    openGraph: { title, description, type: "profile" },
    twitter: { card: "summary", title, description },
  };
}

export default async function Page({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  return <ProfileClient username={username} />;
}
