// A handle's first letter in a ring, with a white dot while they're online.
// The home page's phone mockup and the app draw the same one.
export default function Avatar({ name, live, size }: { name: string; live?: boolean; size?: number }) {
  const dot = size ? Math.round(size / 4) : undefined;
  return (
    <span className="ps-avatar" style={size ? { width: size, height: size, fontSize: Math.round(size * 0.4) } : undefined} aria-hidden="true">
      {name.charAt(0).toUpperCase()}
      {live && <span className="ps-avatar-dot" style={dot ? { width: dot, height: dot } : undefined} />}
    </span>
  );
}
