"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useCall } from "@/hooks/useCall";
import type { Profile } from "@/hooks/useProfile";

type CallApi = { start: (username: string, video?: boolean) => void; busy: boolean };
const Ctx = createContext<CallApi>({ start: () => {}, busy: false });

/** Call a friend from anywhere under /app. */
export const useCallUI = () => useContext(Ctx);

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const Video = ({ stream, muted, className }: { stream: MediaStream | null; muted?: boolean; className?: string }) => {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} className={className} />;
};

// Remote audio needs an element to actually play; on a voice call there is no
// visible video tile to carry it.
const Audio = ({ stream }: { stream: MediaStream | null }) => {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay />;
};

const Round = ({
  onClick,
  label,
  danger,
  active,
  children,
}: {
  onClick: () => void;
  label: string;
  danger?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) => (
  <button
    onClick={onClick}
    aria-label={label}
    title={label}
    className={`flex h-14 w-14 items-center justify-center rounded-full border transition ${
      danger
        ? "border-transparent bg-[color:var(--danger)] text-black"
        : active
          ? "border-transparent bg-white text-black"
          : "border-[color:var(--border-strong)] bg-[color:var(--panel)] hover:border-[color:var(--focus)]"
    }`}
  >
    {children}
  </button>
);

const Icon = ({ d, slash }: { d: string; slash?: boolean }) => (
  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
    {slash && <line x1="3" y1="3" x2="21" y2="21" />}
  </svg>
);

const PHONE = "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.4 2.1L8 9.6a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2z";
const MIC = "M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM5 10a7 7 0 0 0 14 0M12 19v3";
const CAM = "M23 7l-7 5 7 5V7zM14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z";

export function CallProvider({ profile, children }: { profile: Profile | null; children: React.ReactNode }) {
  const call = useCall(profile);
  const { state, peer, withVideo, muted, camOn, error, localStream, remoteStream, startedAt, debug, tracelog } = call;
  // Tick a clock while connected and derive the duration from it, rather than
  // storing elapsed seconds — that would mean a setState in the effect body.
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [startedAt]);
  const secs = startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;

  const open = state !== "idle";
  const line =
    state === "calling" ? "Calling…"
    : state === "ringing" ? `Incoming ${withVideo ? "video" : "voice"} call`
    : state === "connected" ? mmss(secs)
    : error ?? "Call ended";

  return (
    <Ctx.Provider value={{ start: call.start, busy: open }}>
      {children}
      {open && (
        <div className="fixed inset-0 z-[60] flex flex-col items-center justify-between bg-black/95 px-6 py-12 backdrop-blur-sm">
          <Audio stream={remoteStream} />

          <div className="flex flex-col items-center gap-2 text-center">
            <p className="label">{line}</p>
            <p className="mono text-2xl">@{peer?.username ?? ""}</p>
            {state === "connected" && (
              <p className="text-xs text-[color:var(--faint)]">End-to-end encrypted</p>
            )}
            {/* A failed call used to look identical to a ringing one. Say what went wrong. */}
            {error && state !== "connected" && (
              <p className="mono mt-1 max-w-xs text-sm text-[color:var(--danger)]">{error}</p>
            )}
            {debug && tracelog.length > 0 && (
              <pre className="mono mt-3 max-h-40 max-w-full overflow-auto whitespace-pre-wrap rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--panel)] p-2 text-left text-[10px] leading-snug text-[color:var(--faint)]">
                {tracelog.join("\n")}
              </pre>
            )}
          </div>

          {withVideo && state === "connected" ? (
            <div className="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-[color:var(--border-strong)] bg-black">
              <Video stream={remoteStream} className="h-full w-full object-cover" />
              <Video
                stream={localStream}
                muted
                className="absolute bottom-3 right-3 h-28 w-20 rounded-lg border border-[color:var(--border-strong)] object-cover"
              />
            </div>
          ) : (
            <div className="mono text-6xl text-[color:var(--faint)]">@</div>
          )}

          <div className="flex items-center gap-4">
            {state === "ringing" ? (
              <>
                <Round onClick={call.decline} label="Decline call" danger>
                  <Icon d={PHONE} slash />
                </Round>
                <Round onClick={call.accept} label="Accept call" active>
                  <Icon d={PHONE} />
                </Round>
              </>
            ) : (
              <>
                {state === "connected" && (
                  <>
                    <Round onClick={call.toggleMute} label={muted ? "Unmute" : "Mute"} active={muted}>
                      <Icon d={MIC} slash={muted} />
                    </Round>
                    {withVideo && (
                      <Round onClick={call.toggleCam} label={camOn ? "Turn camera off" : "Turn camera on"} active={!camOn}>
                        <Icon d={CAM} slash={!camOn} />
                      </Round>
                    )}
                  </>
                )}
                {state !== "ended" && (
                  <Round onClick={call.hangup} label="End call" danger>
                    <Icon d={PHONE} slash />
                  </Round>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
