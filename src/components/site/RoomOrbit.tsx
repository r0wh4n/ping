"use client";
/* eslint-disable react-hooks/immutability -- a three.js frame loop mutates its scene
   objects (and the chips it steers) every frame by design; none of it is React state. */

// The room, drawn: a ring of light, and every agent's messages streaming into it.
// three.quarks moves the particles and react-postprocessing blooms the light.
// Client-only and loaded on demand by RoomStage; it renders only while on screen.

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import * as THREE from "three";
import {
  BatchedRenderer,
  Bezier,
  ColorOverLife,
  ConeEmitter,
  ConstantColor,
  ConstantValue,
  DonutEmitter,
  Gradient,
  IntervalValue,
  ParticleSystem,
  PiecewiseBezier,
  RenderMode,
  SizeOverLife,
  Vector3 as QV3,
  Vector4 as QV4,
} from "three.quarks";
import { ORBIT_AGENTS, ORBIT_ANGLES, ORBIT_DRIFT, ORBIT_RY, orbitRX } from "./orbit";

type Hooks = {
  chips: React.RefObject<(HTMLElement | null)[]>;
  onSend: (i: number) => void;
  onLand: (i: number) => void;
};

const LIFE = 1.5; // seconds a message takes to cross into the room
const TRICKLE = 1.6; // particles a second from an agent that is only working
const BURST = 48; // ...and while it is sending
const TILT = -1.02; // the ring leans back, so it reads as a place, not a logo
const RING = new THREE.Color("#ffffff").multiplyScalar(1.5); // over 1, so bloom catches it
const ARC = new THREE.Color("#ffffff").multiplyScalar(2.6);
const NODE = new THREE.Color("#ffffff").multiplyScalar(1.8);

// A soft round dot, drawn once, for every particle.
function dotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.3, "rgba(255,255,255,0.75)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// White at birth, cooling to grey on the way in, gone on arrival.
const fade = () =>
  new Gradient(
    [
      [new QV3(1, 1, 1), 0],
      [new QV3(0.82, 0.82, 0.86), 0.5],
      [new QV3(0.55, 0.55, 0.6), 1],
    ],
    [
      [0, 0],
      [1, 0.1],
      [1, 0.75],
      [0, 1],
    ]
  );

function Scene({ chips, onSend, onLand }: Hooks) {
  const { viewport, size } = useThree();
  const ring = useRef<THREE.Group>(null);
  const ringMat = useRef<THREE.MeshBasicMaterial>(null);
  const arc = useRef<THREE.Mesh>(null);
  const nodes = useRef<(THREE.Mesh | null)[]>([]);
  const clock = useRef({ t: 0, next: 0.6, burstI: -1, burstUntil: 0, lands: [] as { i: number; at: number }[], pulse: 0 });

  const fx = useMemo(() => {
    const tex = dotTexture();
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const batch = new BatchedRenderer();
    const streams = ORBIT_AGENTS.map(() => {
      const ps = new ParticleSystem({
        looping: true,
        duration: 1,
        worldSpace: true,
        startLife: new ConstantValue(LIFE),
        startSpeed: new ConstantValue(2),
        startSize: new IntervalValue(0.05, 0.13),
        startColor: new ConstantColor(new QV4(1, 1, 1, 1)),
        emissionOverTime: new ConstantValue(TRICKLE),
        shape: new ConeEmitter({ radius: 0.04, angle: 0.06, thickness: 1, arc: Math.PI * 2 }),
        material: mat,
        renderMode: RenderMode.BillBoard,
        behaviors: [new ColorOverLife(fade()), new SizeOverLife(new PiecewiseBezier([[new Bezier(0.4, 1, 1, 0.2), 0]]))],
      });
      batch.addSystem(ps);
      return ps;
    });
    // Dust that lives on the ring itself, so the room is never a still frame.
    const dust = new ParticleSystem({
      looping: true,
      duration: 2,
      startLife: new IntervalValue(1.2, 2.8),
      startSpeed: new IntervalValue(0.02, 0.1),
      startSize: new IntervalValue(0.015, 0.05),
      startColor: new ConstantColor(new QV4(0.9, 0.9, 0.92, 1)),
      emissionOverTime: new ConstantValue(70),
      shape: new DonutEmitter({ radius: 1, thickness: 0.2, arc: Math.PI * 2, donutRadius: 0.06 }),
      material: mat,
      renderMode: RenderMode.BillBoard,
      behaviors: [new ColorOverLife(fade())],
    });
    batch.addSystem(dust);
    return { tex, mat, batch, streams, dust };
  }, []);

  useEffect(
    () => () => {
      fx.streams.forEach((s) => s.dispose());
      fx.dust.dispose();
      fx.tex.dispose();
      fx.mat.dispose();
    },
    [fx]
  );

  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 30); // a background tab must not fast-forward the scene
    const c = clock.current;
    c.t += dt;
    const W = viewport.width;
    const H = viewport.height;
    const R = Math.min(H * 0.23, W * 0.2);
    const RX = orbitRX(size.width);

    // The agents drift around the room; their chips follow them.
    for (let i = 0; i < ORBIT_AGENTS.length; i++) {
      const a = ORBIT_ANGLES[i] + c.t * ORBIT_DRIFT;
      const x = RX * Math.cos(a) * W;
      const y = ORBIT_RY * Math.sin(a) * H;
      nodes.current[i]?.position.set(x, y, 0);
      const ps = fx.streams[i];
      ps.emitter.position.set(x, y, 0);
      ps.emitter.lookAt(0, 0, 0);
      (ps.startSpeed as ConstantValue).value = Math.max(0.5, Math.hypot(x, y) - R * 0.3) / LIFE;
      const chip = chips.current?.[i];
      if (chip) chip.style.transform = `translate3d(${(0.5 + x / W) * size.width}px, ${(0.5 - y / H) * size.height}px, 0) translate(-50%, -50%)`;
    }

    // A message every second or two, never twice in a row from the same agent.
    if (c.t >= c.next) {
      let i = Math.floor(Math.random() * ORBIT_AGENTS.length);
      if (i === c.burstI) i = (i + 1) % ORBIT_AGENTS.length;
      c.burstI = i;
      c.burstUntil = c.t + 0.32;
      (fx.streams[i].emissionOverTime as ConstantValue).value = BURST;
      c.lands.push({ i, at: c.t + LIFE * 0.9 });
      c.next = c.t + 1.5 + Math.random() * 1.1;
      onSend(i);
    }
    if (c.burstI >= 0 && c.t >= c.burstUntil) (fx.streams[c.burstI].emissionOverTime as ConstantValue).value = TRICKLE;
    while (c.lands.length && c.lands[0].at <= c.t) {
      onLand(c.lands.shift()!.i);
      c.pulse = 1;
    }

    // The room answers each arrival: it swells at once, then settles.
    c.pulse = Math.max(0, c.pulse - dt * 1.6);
    const swell = c.pulse * c.pulse;
    ring.current?.scale.setScalar(R * (1 + 0.05 * swell));
    ringMat.current?.color.copy(RING).multiplyScalar(1 + 0.9 * swell);
    if (arc.current) arc.current.rotation.z -= dt * 0.9;

    fx.batch.update(dt);
  });

  return (
    <>
      <primitive object={fx.batch} />
      {fx.streams.map((s, i) => (
        <primitive key={i} object={s.emitter} />
      ))}
      {ORBIT_AGENTS.map((a, i) => (
        <mesh key={a.client} ref={(m: THREE.Mesh | null) => { nodes.current[i] = m; }} scale={0.05}>
          <sphereGeometry args={[1, 16, 16]} />
          <meshBasicMaterial color={NODE} toneMapped={false} />
        </mesh>
      ))}
      <group ref={ring} rotation={[TILT, 0, 0]}>
        <mesh>
          <torusGeometry args={[1, 0.012, 16, 256]} />
          <meshBasicMaterial ref={ringMat} color={RING} toneMapped={false} />
        </mesh>
        <mesh>
          <torusGeometry args={[1, 0.1, 16, 192]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.05} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh ref={arc}>
          <torusGeometry args={[1, 0.02, 16, 160, Math.PI * 0.5]} />
          <meshBasicMaterial color={ARC} toneMapped={false} />
        </mesh>
        <primitive object={fx.dust.emitter} />
      </group>
    </>
  );
}

export default function RoomOrbit({ running, onReady, ...hooks }: Hooks & { running: boolean; onReady: () => void }) {
  return (
    <Canvas
      camera={{ position: [0, 0, 11], fov: 35 }}
      dpr={[1, 1.75]}
      gl={{ antialias: false, alpha: false, powerPreference: "high-performance" }}
      frameloop={running ? "always" : "never"}
      onCreated={onReady}
    >
      <color attach="background" args={["#000000"]} />
      <Scene {...hooks} />
      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur intensity={1.2} luminanceThreshold={0.22} luminanceSmoothing={0.25} radius={0.72} />
      </EffectComposer>
    </Canvas>
  );
}
