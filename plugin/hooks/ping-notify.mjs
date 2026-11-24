// A desktop pop-up on this machine, for things the person must decide.
//
// Used when someone the person has NOT allowed to direct their agent asks it
// to do something: the agent asks its person in Claude Code, and this makes
// sure the person notices even when the terminal is out of sight.
//
// The text was written by another room member, so it never touches a command
// line or a script: it travels in environment variables, and the AppleScript /
// PowerShell below only ever read it from there.
import { spawn } from "node:child_process";

const MAC = 'display notification (system attribute "PING_NOTE_BODY") with title (system attribute "PING_NOTE_TITLE") sound name "Glass"';

// Windows: a real pop-up window, on top, that stays until it is dismissed.
// Toasts are silently dropped on some Windows Server setups (an EC2 box), and a
// request for approval must not be dropped.
const WIN = [
  "Add-Type -AssemblyName System.Windows.Forms;",
  "$owner = New-Object System.Windows.Forms.Form; $owner.TopMost = $true;",
  "[System.Windows.Forms.MessageBox]::Show($owner, $env:PING_NOTE_BODY, $env:PING_NOTE_TITLE, 'OK', 'Information') | Out-Null",
].join(" ");

export function popup(title, body) {
  const env = { ...process.env, PING_NOTE_TITLE: String(title).slice(0, 80), PING_NOTE_BODY: String(body).slice(0, 400) };
  const [cmd, args] =
    process.platform === "darwin" ? ["osascript", ["-e", MAC]]
    : process.platform === "win32" ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN]]
    : ["notify-send", [env.PING_NOTE_TITLE, env.PING_NOTE_BODY]];
  try {
    // Detached and not waited for: the hook finishes now, the pop-up stays up.
    const child = spawn(cmd, args, { env, detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch { /* no desktop (a server, ssh): the request still reaches Claude Code */ }
}

// One pop-up per delivery, listing what was asked (at most three).
export function popupAsks(agent, asks) {
  if (!asks?.length) return;
  const lines = asks.slice(0, 3).map((a) => `${a.from}: ${String(a.text).replace(/\s+/g, " ").slice(0, 140)}`);
  popup(`Ping: approve a request for ${agent ?? "your agent"}?`,
    `${lines.join("\n")}\n\nThey are not allowed to direct this agent. Answer in Claude Code.`);
}
