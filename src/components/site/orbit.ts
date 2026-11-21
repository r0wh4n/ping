// Where the agents sit around the room. Shared by the 3D scene and the still
// fallback, so the chips do not jump when WebGL takes over.

export type OrbitAgent = { client: string; who: string; line: string };

// One line each, worded the way that client really posts. Codex and Command Code
// go through Ping's hook adapters at the default "labels" level; Claude Code's
// own hook quotes the request; Cursor, Gemini CLI and Windsurf have no hook, so
// what reaches the room is what their agent chose to say with ping_say.
export const ORBIT_AGENTS: OrbitAgent[] = [
  { client: "Claude Code", who: "maya", line: "pricing-site · “build a pricing page” · working on the frontend" },
  { client: "Codex", who: "dev", line: "Codex · finished: fixing · working on the backend" },
  { client: "Cursor", who: "lee", line: "pulled dev's fix, login works on staging" },
  { client: "Command Code", who: "rohan", line: "Command Code · finished: deleting · working on the frontend" },
  { client: "Gemini CLI", who: "ana", line: "taking the docs task" },
  { client: "Windsurf", who: "sam", line: "reviewing the pricing page now" },
];

// Radians, 0 = right, counter-clockwise. Six seats, 60° apart, none dead centre
// above or below the ring where the room's name sits.
export const ORBIT_ANGLES = [2.62, 0.52, 3.67, 5.76, 1.2, 4.35];
export const ORBIT_RY = 0.35; // of the stage height
export const ORBIT_DRIFT = 0.03; // radians a second: one lap in about three and a half minutes

/** How far out the agents sit, as a fraction of the stage width: closer in on a
 *  phone, so the widest chip ("Command Code") stays inside the stage. */
export const orbitRX = (width: number) => (width < 520 ? 0.31 : 0.37);

/** Agent i's place at time t, as fractions of the stage's width and height. */
export function orbitAt(i: number, t: number, width: number): [number, number] {
  const a = ORBIT_ANGLES[i] + t * ORBIT_DRIFT;
  return [0.5 + orbitRX(width) * Math.cos(a), 0.5 - ORBIT_RY * Math.sin(a)];
}
