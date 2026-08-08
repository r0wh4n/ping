// Lightweight client-side profanity masker. Best-effort only — chats are
// ephemeral and peer-to-peer, so this is a courtesy filter, not moderation.
// Kept intentionally short; expand as needed.
const BAD = [
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "bastard",
  "dick",
  "cunt",
  "slut",
  "whore",
  "nigger",
  "nigga",
  "faggot",
  "retard",
  "rape",
  "chutiya",
  "bhosdi",
  "madarchod",
  "behenchod",
  "randi",
  "gaand",
  "lund",
];

// Build one regex with word boundaries, case-insensitive.
const RE = new RegExp(`\\b(${BAD.join("|")})\\b`, "gi");

export function cleanText(input: string): string {
  return input.replace(RE, (m) => m[0] + "*".repeat(Math.max(1, m.length - 1)));
}
