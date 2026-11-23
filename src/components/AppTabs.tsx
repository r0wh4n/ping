import Link from "next/link";

// Ping is two things on a phone: chats with people, and the agents working for
// you. One switch between them, on both screens.
export default function AppTabs({ active }: { active: "chats" | "agents" }) {
  const tab = (key: "chats" | "agents", href: string, label: string) => (
    <Link
      href={href}
      aria-current={active === key ? "page" : undefined}
      className={`flex-1 rounded-full py-2 text-center text-sm font-medium transition ${
        active === key ? "bg-[color:var(--bubble-out-bg)] text-[color:var(--bubble-out-fg)]" : "text-muted hover:text-text"
      }`}
    >
      {label}
    </Link>
  );
  return (
    <div className="mx-5 mt-4 flex gap-1 rounded-full border border-border p-1">
      {tab("chats", "/app", "Chats")}
      {tab("agents", "/app/agents", "Agents")}
    </div>
  );
}
