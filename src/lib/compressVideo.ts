// Re-encode a gallery video in the browser, with no dependency and no server.
//
// The trick is all native: play the file into a detached <video>, draw each
// frame to a smaller <canvas>, and record the canvas with MediaRecorder. The
// element's audio is routed through Web Audio into the recorder instead of the
// speakers, so the clip is captured but never heard while it runs.
//
// It costs real time — a 30-second clip takes 30 seconds, because the only way
// to get frames out of a <video> is to play it — and it stalls if the tab is
// backgrounded, since requestAnimationFrame stops there. In exchange a 90 MB
// iPhone clip becomes a few MB, and the output is H.264/AAC, which also fixes
// the HEVC .mov that plays on iPhones and nowhere else.
//
// Returns null whenever it can't help (unsupported browser, undecodable file,
// or a result no smaller than the original), and the caller sends the original.

const MAX_EDGE = 1280;
const VIDEO_BPS = 1_500_000;
const AUDIO_BPS = 96_000;

// H.264 in MP4 first — it plays everywhere, iOS included. WebM is the Firefox
// fallback; Safari and Chrome both record MP4.
const pickType = () =>
  [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ].find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) ?? "";

// Anything that can hang — a decode that never ends, playback an autoplay
// policy refuses to start — must not hang the send. The caller gets null and
// uploads the original instead.
export function compressVideo(file: File, onProgress?: (fraction: number) => void): Promise<File | null> {
  return Promise.race([
    encode(file, onProgress),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 4 * 60_000)),
  ]).catch(() => null);
}

async function encode(
  file: File,
  onProgress?: (fraction: number) => void
): Promise<File | null> {
  const type = pickType();
  if (!type) return null;

  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  let ac: AudioContext | null = null;
  let raf = 0;
  try {
    v.src = url;
    v.playsInline = true;
    v.preload = "auto";
    await new Promise<void>((resolve, reject) => {
      v.onloadedmetadata = () => resolve();
      v.onerror = () => reject(new Error("cannot decode"));
    });

    const scale = Math.min(1, MAX_EDGE / Math.max(v.videoWidth, v.videoHeight));
    // H.264 wants even dimensions.
    const w = Math.max(2, Math.round((v.videoWidth * scale) / 2) * 2);
    const h = Math.max(2, Math.round((v.videoHeight * scale) / 2) * 2);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const stream = canvas.captureStream(30);
    // Routing the element through Web Audio and never connecting it to
    // ac.destination takes its sound off the speakers while keeping it in the
    // recording — the element itself stays unmuted, which is what makes the
    // captured track audible.
    try {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) {
        ac = new Ctor();
        await ac.resume().catch(() => {});
        const dest = ac.createMediaStreamDestination();
        ac.createMediaElementSource(v).connect(dest);
        dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      }
    } catch {
      // No audio route: a silent compressed clip still beats a failed send.
    }

    const chunks: Blob[] = [];
    const mr = new MediaRecorder(stream, {
      mimeType: type,
      videoBitsPerSecond: VIDEO_BPS,
      audioBitsPerSecond: AUDIO_BPS,
    });
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise<void>((resolve) => {
      mr.onstop = () => resolve();
    });

    mr.start();
    await v.play();
    const draw = () => {
      ctx.drawImage(v, 0, 0, w, h);
      if (onProgress && isFinite(v.duration) && v.duration > 0) onProgress(v.currentTime / v.duration);
      raf = requestAnimationFrame(draw);
    };
    draw();
    await new Promise<void>((resolve) => {
      v.onended = () => resolve();
    });
    cancelAnimationFrame(raf);
    mr.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());

    const outType = type.split(";")[0];
    const out = new Blob(chunks, { type: outType });
    if (!out.size || out.size >= file.size) return null;
    const ext = outType.includes("mp4") ? "mp4" : "webm";
    return new File([out], file.name.replace(/\.[^.]+$/, "") + "." + ext, { type: outType });
  } catch {
    return null;
  } finally {
    cancelAnimationFrame(raf);
    v.pause();
    v.removeAttribute("src");
    URL.revokeObjectURL(url);
    ac?.close().catch(() => {});
  }
}
