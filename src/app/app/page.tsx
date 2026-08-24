"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useProfile, type Profile } from "@/hooks/useProfile";
import { useFriends } from "@/hooks/useFriends";
import { usePresence } from "@/hooks/usePresence";
import { useUnread } from "@/hooks/useUnread";
import { useGroups } from "@/hooks/useGroups";
import { enablePush, pushSupported } from "@/lib/push";
import { supabase } from "@/lib/supabase";
import { normalizeUsername } from "@/lib/username";
import Onboarding from "./Onboarding";
import NewGroup from "./NewGroup";

export default function AppHome() {
  const { profile, ready, signUp, logIn, signOut, deleteAccount } = useProfile();

  if (!ready) return <main className="min-h-dvh" />;
  if (!profile) return <AuthScreen signUp={signUp} logIn={logIn} />;
  return <SignedInHome profile={profile} onSignOut={signOut} onDeleteAccount={deleteAccount} />;
}

// ---- Login / sign up -----------------------------------------------------
type AuthFn = (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;

function AuthScreen({ signUp, logIn }: { signUp: AuthFn; logIn: AuthFn }) {
  const [mode, setMode] = useState<"signup" | "login">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSignup = mode === "signup";

  const submit = async () => {
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError(null);
    const res = await (isSignup ? signUp : logIn)(username, password);
    if (!res.ok) setError(res.error ?? "Something went wrong.");
    setBusy(false);
  };

  return (
    <main className="flex min-h-dvh flex-col">
      <nav className="wrap flex items-center justify-between py-4">
        <Link href="/" className="mono text-[15px] font-semibold">
          ping<span className="text-[color:var(--faint)]">.chat</span>
        </Link>
      </nav>
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="idcard w-full max-w-md">
          <p className="label">{isSignup ? "CREATE YOUR ACCOUNT" : "WELCOME BACK"}</p>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">
            {isSignup ? (
              <>
                Claim your <span className="gradient-text">@username</span>
              </>
            ) : (
              <>
                Log in to <span className="gradient-text">Ping</span>
              </>
            )}
          </h1>
          <p className="mt-2 text-sm text-muted">
            {isSignup
              ? "Pick a handle and a password. Use them on any device — no email needed."
              : "Enter your handle and password from any device."}
          </p>

          {/* username */}
          <div className="mt-6 flex items-center rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg)] px-3 focus-within:border-[color:var(--focus)]">
            <span className="mono text-lg text-muted">@</span>
            <input
              autoFocus
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setError(null);
              }}
              placeholder="spiderman"
              maxLength={20}
              autoCapitalize="none"
              autoCorrect="off"
              className="mono w-full bg-transparent px-1.5 py-3 text-lg outline-none placeholder:text-[color:var(--faint)]"
            />
          </div>

          {/* password */}
          <div className="mt-3 flex items-center rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg)] px-3 focus-within:border-[color:var(--focus)]">
            <span className="text-muted">🔒</span>
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder={isSignup ? "choose a password (8+ chars)" : "your password"}
              className="w-full bg-transparent px-2 py-3 outline-none placeholder:text-[color:var(--faint)]"
            />
          </div>

          {error && <p className="mt-3 text-sm text-[color:var(--danger)]">{error}</p>}

          <button
            onClick={submit}
            disabled={busy || !username.trim() || !password}
            className="btn mt-6 w-full justify-center py-3 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "…" : isSignup ? "Create account →" : "Log in →"}
          </button>

          <button
            onClick={() => {
              setMode(isSignup ? "login" : "signup");
              setError(null);
            }}
            className="mt-4 w-full text-sm text-muted transition hover:text-text"
          >
            {isSignup ? "Already have a handle? Log in" : "New here? Create an account"}
          </button>
        </div>
      </div>
    </main>
  );
}

// ---- Signed-in home ------------------------------------------------------
function SignedInHome({
  profile,
  onSignOut,
  onDeleteAccount,
}: {
  profile: Profile;
  onSignOut: () => void;
  onDeleteAccount: () => Promise<{ ok: boolean; error?: string }>;
}) {
  const router = useRouter();
  const { friends, incoming, outgoing, addByHandle, respond, removeFriend } = useFriends(profile);
  const online = usePresence(profile.id);
  const { counts: unread, clear: clearUnread } = useUnread(profile);
  const { groups, createGroup } = useGroups(profile);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [handle, setHandle] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // remove-friend inline confirm (which friend row is asking to confirm)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  // delete-account danger zone
  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const canDelete = deleteConfirm.trim().replace(/^@/, "").toLowerCase() === profile.username;
  const removeAccount = async () => {
    if (deleting || !canDelete) return;
    setDeleting(true);
    setDeleteErr(null);
    const res = await onDeleteAccount();
    if (!res.ok) {
      setDeleteErr(res.error ?? "Couldn't delete your account.");
      setDeleting(false);
    }
    // on success the auth state flips and this screen unmounts to the login view
  };

  const [status, setStatus] = useState("");
  const [editingStatus, setEditingStatus] = useState(false);
  const [statusDraft, setStatusDraft] = useState("");
  const [pushState, setPushState] = useState<"unsupported" | "off" | "on" | "denied" | "busy">("off");
  const [pushErr, setPushErr] = useState<string | null>(null);
  const [showOnboard, setShowOnboard] = useState(false);

  useEffect(() => {
    if (!pushSupported()) {
      setPushState("unsupported");
      return;
    }
    if (Notification.permission === "granted") setPushState("on");
    else if (Notification.permission === "denied") setPushState("denied");
    else setPushState("off");
  }, []);

  const enable = async () => {
    setPushState("busy");
    setPushErr(null);
    const res = await enablePush(profile.id);
    if (res.ok) setPushState("on");
    else if (res.error === "denied") setPushState("denied");
    else if (res.error === "unsupported") setPushState("unsupported");
    else {
      setPushState("off");
      setPushErr(res.error ?? "Couldn't enable notifications.");
    }
  };

  useEffect(() => {
    supabase
      .from("profiles")
      .select("status")
      .eq("id", profile.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.status) setStatus(String(data.status));
      });
  }, [profile.id]);

  // Invite link + QR nametag for sharing.
  const [link, setLink] = useState("");
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const l = `${window.location.origin}/u/${profile.username}`;
    setLink(l);
    QRCode.toDataURL(l, { margin: 1, width: 220, color: { dark: "#08080a", light: "#f5f5f6" } })
      .then(setQr)
      .catch(() => {});
  }, [profile.username]);

  const share = async () => {
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: "Add me on Ping", text: `Add me on Ping — @${profile.username}`, url: link });
      } catch {
        /* user dismissed */
      }
    } else {
      copyLink();
    }
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  // Arriving from someone's /u/<handle> link → auto-send them a friend request.
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("add");
    if (!raw) return;
    window.history.replaceState({}, "", "/app");
    const uname = normalizeUsername(raw);
    if (!uname || uname === profile.username) return;
    addByHandle(uname).then((res) => {
      if (res.ok) setNote(res.note ?? "Friend added!");
      else setErr(res.error ?? null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First-run onboarding (once per browser).
  useEffect(() => {
    try {
      if (!localStorage.getItem("ping_onboarded_v1")) setShowOnboard(true);
    } catch {
      /* storage blocked */
    }
  }, []);
  const finishOnboard = () => {
    try {
      localStorage.setItem("ping_onboarded_v1", "1");
    } catch {
      /* storage blocked */
    }
    setShowOnboard(false);
  };

  const saveStatus = async () => {
    const s = statusDraft.trim().slice(0, 60);
    setStatus(s);
    setEditingStatus(false);
    await supabase.from("profiles").update({ status: s }).eq("id", profile.id);
  };

  const add = async () => {
    if (busy || !handle.trim()) return;
    setBusy(true);
    setNote(null);
    setErr(null);
    const res = await addByHandle(handle);
    if (res.ok) {
      setNote(res.note ?? "Done.");
      setHandle("");
    } else {
      setErr(res.error ?? "Something went wrong.");
    }
    setBusy(false);
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col">
      {showOnboard && (
        <Onboarding
          username={profile.username}
          link={link}
          pushState={pushState}
          onEnablePush={enable}
          onDone={finishOnboard}
        />
      )}
      {showNewGroup && (
        <NewGroup
          friends={friends}
          onClose={() => setShowNewGroup(false)}
          onCreate={async (name, ids) => {
            const res = await createGroup(name, ids);
            if (res.ok && res.id) {
              setShowNewGroup(false);
              router.push(`/app/group/${res.id}`);
            }
            return res;
          }}
        />
      )}
      <nav className="flex items-center justify-between border-b border-border px-5 py-4">
        <Link href="/" className="mono text-[15px] font-semibold">
          ping<span className="text-[color:var(--faint)]">.chat</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <span className="mono text-muted">@{profile.username}</span>
          <button onClick={onSignOut} className="text-muted transition hover:text-text">
            Sign out
          </button>
        </div>
      </nav>

      <div className="flex flex-col gap-5 px-5 py-7">
        {pushState === "unsupported" ? (
          <div className="card p-4 text-sm text-muted">
            🔔 To get notifications, add Ping to your Home Screen. On iPhone:{" "}
            <span className="text-text">Safari → Share → Add to Home Screen</span>, then open Ping
            from that icon and tap Enable.
          </div>
        ) : pushState === "off" || pushState === "busy" ? (
          <button
            onClick={enable}
            disabled={pushState === "busy"}
            className="card flex items-center justify-between gap-3 p-4 text-left text-sm transition hover:border-[color:var(--border-strong)] disabled:opacity-60"
          >
            <span className="flex items-center gap-2.5">
              <span>🔔</span>
              <span className="text-muted">Get notified when a friend messages you</span>
            </span>
            <span className="btn px-3 py-1.5 text-xs">{pushState === "busy" ? "…" : "Enable"}</span>
          </button>
        ) : pushState === "denied" ? (
          <div className="card p-4 text-sm text-muted">
            🔔 Notifications are blocked. Turn them on in your browser&apos;s site settings, then tap
            Enable again.
          </div>
        ) : null}
        {pushErr && <p className="text-sm text-[color:var(--danger)]">{pushErr}</p>}

        {/* identity */}
        <div className="idcard">
          <div className="flex items-center justify-between">
            <span className="text-lg font-semibold">@{profile.username}</span>
            <span className="flex items-center gap-2 text-xs text-muted">
              <span className="live-dot" /> online
            </span>
          </div>
          <div className="my-4 hair" />
          <dl className="kv">
            <dt>handle</dt>
            <dd>@{profile.username}</dd>
            <dt>friends</dt>
            <dd>{friends.length} connected</dd>
            <dt>status</dt>
            <dd>
              {editingStatus ? (
                <input
                  autoFocus
                  value={statusDraft}
                  onChange={(e) => setStatusDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveStatus()}
                  onBlur={saveStatus}
                  maxLength={60}
                  placeholder="what's up?"
                  className="w-full bg-transparent outline-none placeholder:text-[color:var(--faint)]"
                />
              ) : (
                <button
                  onClick={() => {
                    setStatusDraft(status);
                    setEditingStatus(true);
                  }}
                  className="text-left transition hover:text-[color:var(--text)]"
                >
                  {status ? `"${status}"` : <span className="text-[color:var(--faint)]">set a status…</span>}
                </button>
              )}
            </dd>
          </dl>
        </div>

        {/* invite / share */}
        <div className="card p-5">
          <p className="label">INVITE FRIENDS</p>
          <p className="mt-3 text-sm text-muted">
            Share your link — anyone who opens it can add you in one tap.
          </p>
          <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row">
            {qr && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt="Your Ping QR code" width={116} height={116} className="shrink-0 rounded-lg" />
            )}
            <div className="min-w-0 flex-1 self-stretch">
              <div className="mono truncate rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg)] px-3 py-2.5 text-sm text-muted">
                {link || "…"}
              </div>
              <div className="mt-3 flex gap-2">
                <button onClick={share} className="btn flex-1 justify-center py-2.5 text-sm">
                  Share
                </button>
                <button onClick={copyLink} className="btn-ghost justify-center px-4 py-2.5 text-sm">
                  {copied ? "Copied ✓" : "Copy"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* add friend */}
        <div className="card p-5">
          <p className="label">ADD A FRIEND</p>
          <div className="mt-4 flex items-center gap-2">
            <div className="mono flex flex-1 items-center rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg)] px-3 focus-within:border-[color:var(--focus)]">
              <span className="text-muted">@</span>
              <input
                value={handle}
                onChange={(e) => {
                  setHandle(e.target.value);
                  setErr(null);
                  setNote(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && add()}
                placeholder="handle"
                maxLength={20}
                autoCapitalize="none"
                autoCorrect="off"
                className="w-full bg-transparent px-1.5 py-2.5 outline-none placeholder:text-[color:var(--faint)]"
              />
            </div>
            <button
              onClick={add}
              disabled={busy || !handle.trim()}
              className="btn disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "…" : "Send"}
            </button>
          </div>
          {note && <p className="mt-2 text-sm text-[color:var(--ok)]">{note}</p>}
          {err && <p className="mt-2 text-sm text-[color:var(--danger)]">{err}</p>}
        </div>

        {/* incoming requests */}
        {incoming.length > 0 && (
          <div className="card p-5">
            <p className="label">REQUESTS · {incoming.length}</p>
            <ul className="mt-4 flex flex-col gap-3">
              {incoming.map((r) => (
                <li key={r.friendshipId} className="flex items-center justify-between">
                  <span className="mono">@{r.person.username}</span>
                  <div className="flex gap-2">
                    <button onClick={() => respond(r, true)} className="btn px-3 py-1.5 text-sm">
                      Accept
                    </button>
                    <button
                      onClick={() => respond(r, false)}
                      className="btn-ghost px-3 py-1.5 text-sm"
                    >
                      Ignore
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* friends list */}
        <div className="card p-5">
          <p className="label">FRIENDS · {friends.length}</p>
          {friends.length === 0 ? (
            <p className="mt-4 text-sm text-muted">
              No friends yet. Add someone by their <span className="mono text-text">@handle</span>{" "}
              above — the moment they accept, they show up here.
            </p>
          ) : (
            <ul className="mt-4 flex flex-col divide-y divide-[color:var(--border)]">
              {friends.map((f) => {
                const isOnline = online.has(f.id);
                return (
                  <li key={f.id} className="flex items-center justify-between gap-3 py-3">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span
                        className={
                          isOnline
                            ? "live-dot shrink-0"
                            : "inline-block h-2 w-2 shrink-0 rounded-full bg-[color:var(--faint)]"
                        }
                        title={isOnline ? "online" : "offline"}
                      />
                      <span className="min-w-0">
                        <span className="mono flex items-center gap-2">
                          <span className={unread[f.id] ? "font-semibold text-[color:var(--text)]" : ""}>@{f.username}</span>
                          {unread[f.id] > 0 && (
                            <span className="grid h-5 min-w-[1.25rem] place-items-center rounded-full bg-[color:var(--bubble-out-bg)] px-1.5 text-[11px] font-semibold text-[color:var(--bubble-out-fg)]">
                              {unread[f.id] > 9 ? "9+" : unread[f.id]}
                            </span>
                          )}
                        </span>
                        {f.status ? (
                          <span className="block truncate text-xs text-muted">{f.status}</span>
                        ) : (
                          <span className="block text-xs text-[color:var(--faint)]">
                            {isOnline ? "online" : "offline"}
                          </span>
                        )}
                      </span>
                    </span>
                    {confirmRemove === f.id ? (
                      <span className="flex shrink-0 items-center gap-2 text-sm">
                        <span className="text-muted">Remove?</span>
                        <button
                          onClick={() => {
                            setConfirmRemove(null);
                            removeFriend(f);
                          }}
                          className="btn-ghost px-3 py-1.5 text-sm !border-red-500/40 text-[color:var(--danger)] hover:!border-red-400"
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setConfirmRemove(null)}
                          className="btn-ghost px-3 py-1.5 text-sm"
                        >
                          No
                        </button>
                      </span>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1">
                        <Link
                          href={`/app/dm/${f.username}`}
                          onClick={() => clearUnread(f.id)}
                          className="btn-ghost px-3 py-1.5 text-sm"
                        >
                          Message →
                        </Link>
                        <button
                          onClick={() => setConfirmRemove(f.id)}
                          title={`Remove @${f.username}`}
                          aria-label={`Remove @${f.username}`}
                          className="rounded-md px-2 py-1.5 text-sm text-[color:var(--faint)] transition hover:text-[color:var(--danger)]"
                        >
                          ✕
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* groups */}
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <p className="label">GROUPS · {groups.length}</p>
            <button onClick={() => setShowNewGroup(true)} className="btn-ghost px-3 py-1.5 text-xs">
              + New group
            </button>
          </div>
          {groups.length === 0 ? (
            <p className="mt-4 text-sm text-muted">
              No groups yet. Start one with a few friends — tap <span className="text-text">New group</span>.
            </p>
          ) : (
            <ul className="mt-4 flex flex-col divide-y divide-[color:var(--border)]">
              {groups.map((g) => (
                <li key={g.id} className="flex items-center justify-between gap-3 py-3">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{g.name}</span>
                    <span className="mono block text-xs text-[color:var(--faint)]">{g.count} members</span>
                  </span>
                  <Link href={`/app/group/${g.id}`} className="btn-ghost shrink-0 px-3 py-1.5 text-sm">
                    Open →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* outgoing */}
        {outgoing.length > 0 && (
          <div className="card p-5">
            <p className="label">PENDING · {outgoing.length}</p>
            <ul className="mt-4 flex flex-col gap-2 text-sm text-muted">
              {outgoing.map((r) => (
                <li key={r.friendshipId} className="mono flex items-center justify-between">
                  <span>@{r.person.username}</span>
                  <span className="flex items-center gap-3">
                    <span className="text-[color:var(--faint)]">waiting…</span>
                    <button
                      onClick={() => removeFriend(r.person)}
                      className="text-[color:var(--faint)] transition hover:text-[color:var(--danger)]"
                    >
                      Cancel
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* danger zone — delete account */}
        <div className="mt-2 pb-4">
          {!showDelete ? (
            <button
              onClick={() => setShowDelete(true)}
              className="text-xs text-[color:var(--faint)] transition hover:text-[color:var(--danger)]"
            >
              Delete account
            </button>
          ) : (
            <div className="card p-5 !border-red-500/20">
              <p className="label text-[color:var(--danger)]">DELETE ACCOUNT</p>
              <p className="mt-3 text-sm text-muted">
                This permanently deletes your account, your friends, and every message — for good.
                It can&apos;t be undone.
              </p>
              <p className="mt-3 text-sm text-muted">
                Type <span className="mono text-text">@{profile.username}</span> to confirm.
              </p>
              <input
                value={deleteConfirm}
                onChange={(e) => {
                  setDeleteConfirm(e.target.value);
                  setDeleteErr(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && removeAccount()}
                placeholder={`@${profile.username}`}
                autoCapitalize="none"
                autoCorrect="off"
                className="mono mt-3 w-full rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg)] px-3 py-2.5 outline-none placeholder:text-[color:var(--faint)] focus:border-red-400"
              />
              {deleteErr && <p className="mt-2 text-sm text-[color:var(--danger)]">{deleteErr}</p>}
              <div className="mt-4 flex items-center gap-2">
                <button
                  onClick={removeAccount}
                  disabled={deleting || !canDelete}
                  className="btn-ghost justify-center !border-red-500/50 text-[color:var(--danger)] hover:!border-red-400 hover:!bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {deleting ? "Deleting…" : "Delete everything"}
                </button>
                <button
                  onClick={() => {
                    setShowDelete(false);
                    setDeleteConfirm("");
                    setDeleteErr(null);
                  }}
                  className="btn-ghost"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
