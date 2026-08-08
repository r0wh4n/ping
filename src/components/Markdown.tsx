import { renderMarkdown } from "@/lib/markdown";

// Renders a chat message body with a safe markdown subset (bold, italic, code,
// links, line breaks). Output is escaped-then-tagged, so it's XSS-safe.
export default function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return <span className={`md ${className}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}
