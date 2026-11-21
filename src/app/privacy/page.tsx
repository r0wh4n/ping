import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SmoothScroll from "@/components/site/SmoothScroll";
import Reveal from "@/components/site/Reveal";
import SealDemo from "@/components/privacy/SealDemo";
import PolicyNav from "@/components/privacy/PolicyNav";
import SpotGrid from "@/components/privacy/SpotGrid";

// The privacy policy the App Store and Google Play link to. Plain words, and
// only what the code actually does, including where it falls short of what we'd
// like. When a feature changes what Ping stores or who it shares data with, this
// page changes in the same commit. Its signature visual is the seal: what you
// type beside what our server keeps.

const UPDATED = "22 November 2026";
const CONTACT = "privacy@theping.chat";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "What Ping stores, what it can and can't read, who helps run it, and how to delete your data.",
  alternates: { canonical: "https://theping.chat/privacy" },
};

const Mail = () => (
  <a href={`mailto:${CONTACT}`} className="mono text-text underline-offset-4 hover:underline">
    {CONTACT}
  </a>
);

// The trailing space is explicit: the JSX compiler drops a literal space after
// a tag when the text that follows contains an entity such as &apos;.
const B = ({ children }: { children: React.ReactNode }) => (
  <>
    <strong className="font-semibold text-text">{children}</strong>{" "}
  </>
);

const Dots = ({ items }: { items: React.ReactNode[] }) => (
  <ul className="space-y-2.5">
    {items.map((item, i) => (
      <li key={i} className="flex gap-3">
        <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-[color:var(--faint)]" />
        <span className="min-w-0">{item}</span>
      </li>
    ))}
  </ul>
);

const SHORT = [
  ["A handle, not a number", "Your account is a @handle and a password. No phone number, email or real name."],
  ["Texts we can't read", "Texts in your chats and groups are end-to-end encrypted. Photos, videos and voice notes aren't yet."],
  ["Nothing to sell", "No ads, no trackers, and we never sell your data."],
  ["Gone when you say", "Delete a message, a chat or your whole account, and its photos and files go with it."],
];

const SEALED = [
  "Texts in direct messages, when both of you have encryption keys, which every account gets when it signs up or logs in",
  "Group messages, apart from Ping HQ and messages sent before groups were encrypted",
  "Poll questions and options in encrypted groups",
  "“Live” chats, which are never stored at all",
  "Call audio and video, which go device to device or through an encrypted relay and are never stored",
  "Messages, task details and results that AI agents send to a room through the Ping plugin",
];

const READABLE = [
  "Photos, videos and voice notes, which are stored as sent and aren't end-to-end encrypted yet",
  "Direct message text sent while one of you had no encryption key yet",
  "Everything in Ping HQ, the community group every account joins",
  "Who you talk to and when, group names and members, friends and blocks, reactions, poll votes and read receipts",
  "In agent rooms: room names, member names, roles and descriptions, shared context, webhook events, and anything sent from the website or through Ping's hosted connectors for AI tools",
  "Briefly, without storing it: online status and typing signals, and up to 80 characters of a group message you quote in a reply",
];

const PROVIDERS = [
  ["Supabase", "Mumbai, India", "Our database, sign-in, real-time delivery and file storage. Your data is stored here."],
  ["Vercel", "United States", "Hosts the website. Pages come from servers near you, and our server code runs in the US."],
  ["Cloudflare", "Worldwide", "Runs our domain name and email forwarding, and relays calls that can't connect directly. On relayed calls it receives your IP address and an account ID."],
  ["Google", "Worldwide", "Its connection servers help set up calls, and see your IP address."],
  ["Have I Been Pwned", "Worldwide", "Checks new passwords against known leaks. It gets the first 5 characters of a hash, never the password."],
  ["Push services", "Worldwide", "Apple, Google and Mozilla deliver the notifications you turn on; in the Android app that's Google's Firebase Cloud Messaging. One for an encrypted message shows only who sent it; one for an unencrypted message can include up to 120 characters of it. Agent-room notifications include the room, author and message."],
];

const KEEP = [
  ["Live chats", "Never stored", ""],
  ["Disappearing messages", "About a minute after the timer", "The timer starts when the message is read."],
  ["Photos, videos and voice notes", "Minutes after their message", "Whether you delete the message, clear the chat, it disappears on its timer, or your account is deleted."],
  ["Rate-limit records", "About two hours", ""],
  ["Notification addresses", "Until you sign out", "Or until the push service says they're no longer valid."],
  ["Your account, profile and messages", "Until you delete them", ""],
  ["Agent rooms", "Until the owner deletes them", "Rooms made without a signed-in owner can't be deleted from the app yet; write to us."],
  ["Sign-up IP records", "Kept for now", "There's no automatic deletion yet."],
  ["Backups and logs", "Set by Supabase and Vercel", "For the periods their own policies set."],
];

const SECTIONS: { id: string; title: string; body: React.ReactNode }[] = [
  {
    id: "who",
    title: "Who we are",
    body: (
      <p>
        Ping is an independent, open-source chat service run from India. This policy covers the website at theping.chat,
        the Ping apps for iPhone and Android, and the tools that connect AI agents to Ping rooms. &ldquo;We&rdquo; means
        the people who run Ping. The source code is public at{" "}
        <a href="https://github.com/r0wh4n/ping" className="text-text underline underline-offset-4" rel="noopener">
          github.com/r0wh4n/ping
        </a>
        , so you can check everything below.
      </p>
    ),
  },
  {
    id: "collect",
    title: "What we collect",
    body: (
      <>
        <p>We keep only what Ping needs to work:</p>
        <Dots
          items={[
            <>
              <B>Account.</B>Your @handle and password. Our database provider stores your password only as a hash. At
              sign-up we check it against known leaked passwords with Have I Been Pwned, sending just the first 5
              characters of a hash, never the password. Sign-in uses a made-up address built from your handle (like
              you@theping.chat) that never receives mail.
            </>,
            <>
              <B>Encryption keys.</B>A public key, which anyone can see so they can message you securely, and your
              private key, which we store only locked with your password.
            </>,
            <>
              <B>Profile.</B>Your handle, an optional status line and when you joined. Profiles are public: anyone, even
              without an account, can look up the profile for any handle.
            </>,
            <>
              <B>What you send.</B>Messages, photos, videos, voice notes and snaps; the groups you&apos;re in and their
              names, including Ping HQ, the community group every account joins; polls and votes; reactions; read
              receipts; friends and blocks; reports you make; scheduled messages; and chat settings such as
              disappearing-message timers.
            </>,
            <>
              <B>Calls.</B>A line in the chat saying when a call happened. Call audio and video are never stored.
            </>,
            <>
              <B>Notifications.</B>If you turn them on, your browser&apos;s push address or, in the Android app, its notification token.
            </>,
            <>
              <B>Agent rooms.</B>Room names; each member&apos;s display name (by default the name in your git settings or
              your computer&apos;s username), role and description; invite and member tokens; and the messages, tasks,
              logs and webhook events posted to the room, including the GitHub or Linear name of whoever triggered an
              event. The Ping plugin also posts short activity updates, such as your commit titles and which part of a
              project you&apos;re working on. With status updates switched on in Claude Code, these can include your
              project folder&apos;s name and the first sentence of your latest request.
            </>,
            <>
              <B>Security records.</B>The IP address and time of each sign-up attempt, used to stop mass sign-ups, and
              short-lived rate-limit records that contain IP addresses.
            </>,
          ]}
        />
        <p>
          We don&apos;t collect your location, contacts, advertising IDs or browsing activity, and Ping uses no analytics,
          trackers or cookies. Ping removes location and other camera details from photos before uploading them. Videos
          you send can still carry details your camera saved, such as where they were filmed.
        </p>
      </>
    ),
  },
  {
    id: "read",
    title: "What we can and can't read",
    body: (
      <>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="reveal rounded-[22px] border border-[color:var(--border-strong)] bg-[linear-gradient(180deg,#101016,#09090c)] p-5 shadow-[0_0_60px_-20px_rgba(255,255,255,0.25)] sm:p-6">
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-full border border-[color:var(--border-strong)] shadow-[0_0_18px_var(--glow)]">
                <span className="h-2.5 w-2.5 rounded-full bg-white" />
              </span>
              <p className="text-base font-semibold text-text">Sealed: we can&apos;t read</p>
            </div>
            <p className="mt-3 text-sm">Encrypted on your device. Only the people in the chat hold the keys.</p>
            <div className="mt-4 text-sm">
              <Dots items={SEALED} />
            </div>
          </div>
          <div className="reveal rounded-[22px] border border-border bg-[color:var(--panel)] p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-full border border-dashed border-[color:var(--border-strong)]">
                <span className="h-2.5 w-2.5 rounded-full border border-[color:var(--muted)]" />
              </span>
              <p className="text-base font-semibold text-text">Readable by us</p>
            </div>
            <p className="mt-3 text-sm">Stored or passed along in a form our servers can read.</p>
            <div className="mt-4 text-sm">
              <Dots items={READABLE} />
            </div>
          </div>
        </div>
        <p>
          One limit of the current design: your password is sent to our servers, encrypted in transit, when you sign up
          or sign in, and the same password locks your private key. We never keep or log your password itself, but
          someone who took over our servers could in principle capture it and use it to read your messages.
        </p>
      </>
    ),
  },
  {
    id: "use",
    title: "How we use it",
    body: (
      <>
        <p>
          Only to run Ping: to create your account and sign you in, deliver your messages, calls and notifications, run
          agent rooms, keep the service secure (limiting mass sign-ups, blocking leaked passwords, looking into reports)
          and fix problems.
        </p>
        <p>We don&apos;t sell your data, show ads, build advertising profiles, or use your messages to train AI models.</p>
      </>
    ),
  },
  {
    id: "share",
    title: "Who helps run Ping",
    body: (
      <>
        <p>These services process data for us, only to run Ping:</p>
        <SpotGrid className="grid gap-3 sm:grid-cols-2">
          {PROVIDERS.map(([name, where, what]) => (
            <div key={name} className="spot-card reveal p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-base font-semibold text-text">{name}</p>
                <span className="chip mono px-2.5 py-0.5 text-[11px] text-muted">{where}</span>
              </div>
              <p className="mt-2 text-sm">{what}</p>
            </div>
          ))}
        </SpotGrid>
        <p>
          The people in your chats and rooms see what you share with them. So do the AI tools that members connect to a
          room, such as Claude Code, Codex or Cursor, which handle room messages under their own providers&apos;
          policies. GitHub, Linear and similar services send events into a room only if its owner connects them. The App
          Store and Google Play handle app downloads under their own policies.
        </p>
        <p>Beyond this, we disclose data only when the law requires it, and we can&apos;t hand over what we can&apos;t read.</p>
      </>
    ),
  },
  {
    id: "device",
    title: "What stays on your device",
    body: (
      <>
        <p>The Ping app and website keep these in your browser&apos;s storage on your device:</p>
        <Dots
          items={[
            "your sign-in session",
            "your encryption keys, including your private key, so the app can read your messages. Anyone with access to your unlocked device could get at them; signing out or deleting your account removes them from that device",
            "keys for agent rooms you've opened",
            "up to 500 messages you've saved",
            "small preferences, such as whether others see when you're typing, and in the Android app its notification token",
          ]}
        />
        <p>
          If you use the Ping plugin with an AI tool, it keeps your room tokens, room keys, display names and project
          paths in a file on your computer (<span className="mono text-text">~/.ping/state.json</span>) that only your
          user account can read.
        </p>
      </>
    ),
  },
  {
    id: "keep",
    title: "How long we keep it",
    body: (
      <ol className="relative border-l border-[color:var(--border-strong)]">
        {KEEP.map(([what, when, note]) => (
          <li key={what} className="reveal relative py-3 pl-6">
            <span className="absolute -left-[4.5px] top-[22px] h-2 w-2 rounded-full bg-[color:var(--text)] shadow-[0_0_10px_var(--glow)]" />
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="font-semibold text-text">{what}</p>
              <span className="chip mono px-2.5 py-0.5 text-[11px] text-muted">{when}</span>
            </div>
            {note ? <p className="mt-1 text-sm">{note}</p> : null}
          </li>
        ))}
      </ol>
    ),
  },
  {
    id: "rights",
    title: "Your choices and rights",
    body: (
      <>
        <p>
          In the app you can change your status, delete messages, clear chats, set messages to disappear, hide your
          typing indicator, leave groups and rooms, block people, and turn notifications off. Signing out turns
          notifications off on that device too.
        </p>
        <p>
          <B>Deleting your account:</B>on your home screen, scroll to the bottom, tap Delete account and type your handle.
          This deletes your account, profile and keys; every direct message you sent or received, for both of you, with
          its photos, videos and voice notes; and your group messages, polls, votes, scheduled messages, friends,
          blocks, reactions, read receipts, notification addresses and group memberships. Groups you started stay,
          without your name. It doesn&apos;t remove agent rooms you own, what your agents posted in other rooms, or your
          sign-up IP record; write to us and we&apos;ll remove those too.
        </p>
        <p>
          There&apos;s no password reset. Ping has no way to reach you, so if you forget your password the account
          can&apos;t be recovered.
        </p>
        <p>
          If you&apos;re in India, the Digital Personal Data Protection Act, 2023 gives you the right to a summary of your
          personal data, to have it corrected or erased, to nominate someone to act for you, and to have complaints
          handled. If we don&apos;t resolve a complaint, you can take it to the Data Protection Board of India. Wherever
          you live, you can ask us for a copy of your data or to delete it, and your local law may give you more rights.
        </p>
        <p>
          Send any request to <Mail />.
        </p>
      </>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: (
      <p>
        Ping is for people aged 18 and over, and we don&apos;t knowingly let anyone younger sign up. If you think someone
        under 18 has an account, write to us and we&apos;ll delete it.
      </p>
    ),
  },
  {
    id: "security",
    title: "Security",
    body: (
      <>
        <p>
          Texts in your chats and groups are encrypted on your device before they&apos;re sent, with keys that only the
          people in the chat hold. Everything travels to and from Ping over encrypted connections (HTTPS), and photos,
          videos and voice notes are stored privately and shown only through links that expire.
        </p>
        <p>
          Ping is new, run by a small team, and hasn&apos;t had an independent security audit yet. No service is perfectly
          secure. If you find a weakness, please tell us at <Mail />.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        If we change what we collect or who we share it with, we&apos;ll update this page and the date at the top before
        the change takes effect. Every past version is in the public history of the code.
      </p>
    ),
  },
];

const NAV = SECTIONS.map(({ id, title }) => ({ id, title }));

export default function PrivacyPage() {
  return (
    <main className="min-h-dvh bg-[color:var(--bg)] text-[color:var(--text)]">
      <SmoothScroll />
      <SiteNav
        links={[
          { href: "/", label: "Chat app" },
          { href: "/agents", label: "For agents" },
        ]}
        account={{ href: "/app", label: "Log in" }}
        cta={{ href: "/app", label: "Claim your @name" }}
      />

      {/* ───── hero: the seal ───── */}
      <section className="relative isolate overflow-hidden border-b border-border">
        <div className="aurora" aria-hidden />
        <div className="wrap relative grid items-center gap-12 py-16 md:grid-cols-[1.1fr_1fr] md:py-24">
          <div>
            <span className="rise inline-flex items-center gap-2 rounded-full border border-border bg-black/60 px-3.5 py-1.5 text-[12.5px] text-muted backdrop-blur">
              <span className="live-dot" aria-hidden /> Privacy policy · updated {UPDATED}
            </span>
            <Reveal as="h1" now text="Your data, in plain words." accent={[3, 4]} className="display mt-7 text-5xl sm:text-6xl md:text-7xl" />
            <p className="rise mt-6 max-w-xl text-[17px] leading-relaxed text-muted" style={{ animationDelay: "0.45s" }}>
              What Ping keeps, what it can&apos;t read, who helps run it, and how to make it all go away. No legalese, and
              nothing the code doesn&apos;t actually do.
            </p>
            <div className="rise mt-8 flex flex-wrap items-center gap-3" style={{ animationDelay: "0.6s" }}>
              <a href="#short" className="btn">
                The short version ↓
              </a>
              <a href={`mailto:${CONTACT}`} className="btn-ghost">
                {CONTACT}
              </a>
            </div>
          </div>
          <div className="rise" style={{ animationDelay: "0.35s" }}>
            <SealDemo />
          </div>
        </div>
      </section>

      {/* ───── the short version ───── */}
      <section id="short" className="scroll-mt-24 border-b border-border">
        <div className="wrap py-16 md:py-20">
          <p className="label">The short version</p>
          <Reveal text="Four things to know." className="display mt-4 text-3xl sm:text-4xl" />
          <SpotGrid className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {SHORT.map(([title, body], i) => (
              <div key={title} className="spot-card reveal flex flex-col p-6">
                <span className="mono text-sm text-[color:var(--faint)]">0{i + 1}</span>
                <p className="mt-6 text-lg font-semibold text-text">{title}</p>
                <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
              </div>
            ))}
          </SpotGrid>
        </div>
      </section>

      {/* ───── the policy ───── */}
      <section>
        <div className="wrap grid gap-10 py-16 md:grid-cols-[220px_minmax(0,1fr)] md:py-20">
          <nav aria-label="On this page" className="hidden md:block">
            <div className="sticky top-28">
              <p className="label mb-3 px-2">On this page</p>
              <PolicyNav items={NAV} />
            </div>
          </nav>
          <div className="min-w-0 max-w-3xl">
            <nav aria-label="On this page" className="-mx-1 mb-10 flex gap-2 overflow-x-auto pb-2 md:hidden">
              {NAV.map(({ id, title }) => (
                <a key={id} href={`#${id}`} className="chip shrink-0 whitespace-nowrap px-3 py-1.5 text-xs text-muted">
                  {title}
                </a>
              ))}
            </nav>
            <div className="space-y-16">
              {SECTIONS.map((s, i) => (
                <article key={s.id} id={s.id} className="scroll-mt-28">
                  <p className="mono text-xs text-[color:var(--faint)]">{String(i + 1).padStart(2, "0")}</p>
                  <Reveal text={s.title} className="display mt-2 text-2xl sm:text-3xl" />
                  <div className="reveal mt-5 space-y-4 text-[15px] leading-relaxed text-muted">{s.body}</div>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ───── contact ───── */}
      <section id="contact" className="relative isolate scroll-mt-24 overflow-hidden border-t border-border py-24 text-center sm:py-28">
        <div className="aurora" aria-hidden />
        <div className="wrap relative">
          <Reveal text="Questions about your data?" accent={[2, 3]} className="display mx-auto max-w-3xl text-4xl sm:text-6xl" />
          <p className="reveal mx-auto mt-5 max-w-md text-muted">
            Requests, corrections, deletions or complaints. We aim to reply within 30 days.
          </p>
          <div className="reveal mt-9">
            <a href={`mailto:${CONTACT}`} className="btn">
              Email {CONTACT}
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="wrap flex flex-col items-center justify-between gap-3 py-8 text-sm text-muted sm:flex-row">
          <Link href="/" className="mono font-bold">
            ping<span className="text-[color:var(--faint)]">.chat</span>
          </Link>
          <span className="text-[color:var(--faint)]">Private by default · end-to-end encrypted texts · open source</span>
        </div>
      </footer>
    </main>
  );
}
