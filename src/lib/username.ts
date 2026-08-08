export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase().replace(/^@+/, "");
}

// Returns an error message, or null if valid.
export function validateUsername(input: string): string | null {
  const u = normalizeUsername(input);
  if (u.length < 3) return "Too short — at least 3 characters.";
  if (u.length > 20) return "Too long — max 20 characters.";
  if (!/^[a-z0-9_]+$/.test(u)) return "Only letters, numbers, and underscores.";
  return null;
}
