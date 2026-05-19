import React, { useRef, useMemo, useState, useEffect, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Environment, ContactShadows, Edges } from '@react-three/drei';
import * as THREE from 'three';
import { BoxConfig, BoxSide } from '../types';

// ---------------------------------------------------------------------------
// Canvas texture — bakes side elements onto a THREE texture so they sit flush
// on the mesh surface instead of floating as HTML overlays.
// ---------------------------------------------------------------------------
const RES = 1024;
const isGifUrl = (url: string) => /\.gif(\?|$)/i.test(url);
const isVideoUrl = (url: string) =>
  /\.(mp4|webm|ogg|mov)(\?|$)/i.test(url) || url.startsWith('blob:');
const isAnimated = (url: string) => isGifUrl(url) || isVideoUrl(url);

function useSideTexture(side: BoxSide, innerColor: string) {
  const { canvas, ctx, texture } = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = RES;
    canvas.height = RES;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, RES, RES);
    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY = true;
    texture.channel = 0;
    return { canvas, ctx, texture };
  }, []);

  // stores HTMLImageElement for static images, HTMLVideoElement for mp4/gif
  const media = useRef(new Map<string, HTMLImageElement | HTMLVideoElement>());
  const gifImgs = useRef<HTMLImageElement[]>([]);
  const videoElems = useRef<HTMLVideoElement[]>([]);
  const drawFn = useRef<() => void>(() => {});

  useEffect(() => {
    drawFn.current = () => {
      ctx.fillStyle = innerColor;
      ctx.fillRect(0, 0, RES, RES);

      for (const el of side.elements) {
        ctx.save();
        ctx.translate((el.x / 100) * RES, (el.y / 100) * RES);
        ctx.rotate((el.rotation * Math.PI) / 180);
        ctx.scale(el.scale, el.scale);

        if (el.type === 'text') {
          ctx.font = `bold ${el.fontSize ?? 24}px sans-serif`;
          ctx.fillStyle = el.color ?? '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.shadowColor = 'rgba(0,0,0,0.5)';
          ctx.shadowBlur = 4;
          ctx.fillText(el.content, 0, 0);
        } else if (el.type === 'image') {
          const src = media.current.get(el.content);
          if (src) {
            const w = (src as HTMLVideoElement).videoWidth || (src as HTMLImageElement).naturalWidth;
            const h = (src as HTMLVideoElement).videoHeight || (src as HTMLImageElement).naturalHeight;
            if (w && h) {
              // Scale image to fill the face (same as the editor canvas).
              // scale=1 → image fills the full face; slider shrinks from there.
              const fit = Math.min(RES / w, RES / h);
              ctx.drawImage(src as CanvasImageSource, -(w * fit) / 2, -(h * fit) / 2, w * fit, h * fit);
            }
          }
        } else if (el.type === 'sticker') {
          const emojiMap: Record<string, string> = { heart: '❤️', star: '⭐', sparkle: '✨', face: '😊' };
          ctx.font = `${RES / 10}px serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(emojiMap[el.content] ?? '❤️', 0, 0);
        }
        ctx.restore();
      }
      texture.needsUpdate = true;
    };

    const toLoad = side.elements.filter(
      el => el.type === 'image' && !media.current.has(el.content),
    );
    drawFn.current();
    if (toLoad.length === 0) return;

    let pending = toLoad.length;
    for (const el of toLoad) {
      if (isVideoUrl(el.content)) {
        // Video elements animate reliably on canvas via ctx.drawImage(video)
        const vid = document.createElement('video');
        vid.loop = true;
        vid.muted = true;
        vid.autoplay = true;
        vid.playsInline = true;
        vid.crossOrigin = 'anonymous';
        // on-screen but visually clipped so browser keeps decoding frames
        vid.style.cssText =
          'position:fixed;left:0;top:0;width:200px;height:200px;clip-path:inset(0 100%);pointer-events:none;z-index:0;';
        document.body.appendChild(vid);
        videoElems.current.push(vid);
        vid.oncanplay = () => {
          media.current.set(el.content, vid);
          vid.play().catch(() => {});
          if (--pending === 0) drawFn.current();
        };
        vid.onerror = () => { if (--pending === 0) drawFn.current(); };
        vid.src = el.content;
      } else {
        const img = document.createElement('img') as HTMLImageElement;
        img.crossOrigin = 'anonymous';

        if (isGifUrl(el.content)) {
          img.style.cssText =
            'position:fixed;left:0;top:0;width:200px;height:200px;clip-path:inset(0 100%);pointer-events:none;z-index:0;';
          document.body.appendChild(img);
          gifImgs.current.push(img);
        }

        img.onload = () => {
          media.current.set(el.content, img);
          if (--pending === 0) drawFn.current();
        };
        img.onerror = () => { if (--pending === 0) drawFn.current(); };
        img.src = el.content;
      }
    }
  }, [side.elements, innerColor]);

  useEffect(() => () => {
    texture.dispose();
    gifImgs.current.forEach(img => img.parentNode?.removeChild(img));
    gifImgs.current = [];
    videoElems.current.forEach(v => { v.pause(); v.parentNode?.removeChild(v); });
    videoElems.current = [];
  }, []);

  const hasAnimated = side.elements.some(el => el.type === 'image' && isAnimated(el.content));
  return { texture, hasAnimated, drawFn };
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------
interface SideProps {
  side: BoxSide;
  config: BoxConfig;
  onSelect: (id: string) => void;
}

function Side({ side, config, onSelect }: SideProps) {
  const { numSides, baseColor, innerColor, openLevel } = config;
  const layerScale = 1 - side.layer * (1 / (config.numLayers + 1));
  const baseSize = config.size * layerScale;
  const layerOffset = side.layer * 0.1;
  const sideThickness = 0.05;

  const distance = baseSize / (2 * Math.tan(Math.PI / numSides));
  const angle = (side.index / numSides) * Math.PI * 2;

  const groupRef = useRef<THREE.Group>(null);
  const gifTimer = useRef(0);
  // tracks when this layer's open was triggered so we can stagger panels
  const openTriggeredAt = useRef<number | null>(null);
  const { texture, hasAnimated, drawFn } = useSideTexture(side, innerColor);

  // Each panel within a layer opens with a sequential delay so they bloom
  // outward one by one (like petals on a flower) instead of all at once.
  const staggerDelay = (side.index / numSides) * 0.35; // 0 → 0.35 s stagger

  useFrame((state, delta) => {
    if (groupRef.current) {
      const shouldBeOpen = openLevel > side.layer + 1;

      if (shouldBeOpen && openTriggeredAt.current === null) {
        openTriggeredAt.current = state.clock.getElapsedTime();
      } else if (!shouldBeOpen) {
        openTriggeredAt.current = null;
      }

      const elapsed = openTriggeredAt.current !== null
        ? state.clock.getElapsedTime() - openTriggeredAt.current
        : 0;
      const isOpen = shouldBeOpen && elapsed >= staggerDelay;

      const target = isOpen ? Math.PI / 2 : 0;
      // snap closed quickly; open with a snappy pop
      const lerpFactor = isOpen ? 0.12 : 0.08;
      groupRef.current.rotation.x = THREE.MathUtils.lerp(
        groupRef.current.rotation.x, target, lerpFactor,
      );
    }
    // Sample the current video/GIF frame into the canvas texture at ~15 fps
    if (hasAnimated) {
      gifTimer.current += delta;
      if (gifTimer.current >= 1 / 15) {
        gifTimer.current = 0;
        drawFn.current();
      }
    }
  });

  return (
    <group rotation={[0, -angle, 0]}>
      <group ref={groupRef} position={[0, -config.size / 2 + layerOffset, distance]}>
        <mesh
          position={[0, baseSize / 2, 0]}
          onClick={(e) => { e.stopPropagation(); onSelect(side.id); }}
          onPointerOver={() => { if (openLevel > 0) document.body.style.cursor = 'pointer'; }}
          onPointerOut={() => { document.body.style.cursor = 'auto'; }}
        >
          <boxGeometry args={[baseSize, baseSize, sideThickness]} />
          <meshBasicMaterial color={baseColor} />
          <Edges color="#1a1a1a" threshold={15} />

          {/* Inner face — canvas texture baked flush to the surface */}
          <mesh
            position={[0, 0, -(sideThickness / 2 + 0.001)]}
            rotation={[0, Math.PI, 0]}
          >
            <planeGeometry args={[baseSize, baseSize]} />
            <meshBasicMaterial map={texture} />
          </mesh>
        </mesh>
      </group>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Base platform per layer
// ---------------------------------------------------------------------------
function Base({ config, layer, side, onSelect }: {
  config: BoxConfig;
  layer: number;
  side: BoxSide;
  onSelect: (id: string) => void;
}) {
  const { numSides, baseColor, innerColor, openLevel } = config;
  const layerScale = 1 - layer * (1 / (config.numLayers + 1));
  const baseSize = config.size * layerScale;
  const r = (baseSize / (2 * Math.tan(Math.PI / numSides))) / Math.cos(Math.PI / numSides);
  const layerOffset = layer * 0.1;

  const gifTimer = useRef(0);
  const { texture, hasAnimated, drawFn } = useSideTexture(side, innerColor);

  // Polygon shape matching the cylinder top cap exactly — no overflow.
  // CylinderGeometry uses sin(φ) for X and cos(φ) for Z; after the mesh's
  // rotation=[-π/2,0,0] the shape Y maps to -Z, so shape_y = -r*cos(φ).
  const polygonShape = useMemo(() => {
    const shape = new THREE.Shape();
    for (let i = 0; i < numSides; i++) {
      const phi = (i / numSides) * Math.PI * 2;
      const x = r * Math.sin(phi);
      const y = -r * Math.cos(phi);
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    shape.closePath();
    return shape;
  }, [numSides, r]);

  // ShapeGeometry by default uses the bounding box for UVs, which stretches
  // the texture because a polygon's bounding box is not square.
  // Override UVs to use a square [-r, r] × [-r, r] mapping so the texture
  // matches the editor canvas 1:1 (no distortion).
  const baseGeo = useMemo(() => {
    const geo = new THREE.ShapeGeometry(polygonShape);
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i,
        (pos.getX(i) + r) / (2 * r),
        (pos.getY(i) + r) / (2 * r),
      );
    }
    uv.needsUpdate = true;
    return geo;
  }, [polygonShape, r]);

  useFrame((_, delta) => {
    if (hasAnimated) {
      gifTimer.current += delta;
      if (gifTimer.current >= 1 / 15) {
        gifTimer.current = 0;
        drawFn.current();
      }
    }
  });

  return (
    <group position={[0, -config.size / 2 + layerOffset, 0]} rotation={[0, Math.PI / numSides, 0]}>
      {/* Outer body */}
      <mesh>
        <cylinderGeometry args={[r, r, 0.05, numSides]} />
        <meshBasicMaterial color={baseColor} />
        <Edges color="#1a1a1a" threshold={15} />
      </mesh>
      {/* Inner top face — polygon-shaped canvas texture, clickable to edit */}
      <mesh
        position={[0, 0.027, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        geometry={baseGeo}
        onClick={(e) => { e.stopPropagation(); onSelect(side.id); }}
        onPointerOver={() => { if (openLevel > 0) document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = 'auto'; }}
      >
        <meshBasicMaterial map={texture} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Lid
// ---------------------------------------------------------------------------
function Lid({ config }: { config: BoxConfig }) {
  const { size, baseColor, innerColor, openLevel, numSides } = config;
  const distance = size / (2 * Math.tan(Math.PI / numSides));
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(() => {
    if (!meshRef.current) return;
    const isOff = openLevel >= 1;
    const targetY = isOff ? size * 3.5 : size / 2;
    const targetX = isOff ? size * 1.8 : 0;
    const targetRotX = isOff ? -Math.PI / 4 : 0;
    const targetRotY = isOff ? 0 : Math.PI / numSides;

    meshRef.current.position.y = THREE.MathUtils.lerp(meshRef.current.position.y, targetY, 0.07);
    meshRef.current.position.x = THREE.MathUtils.lerp(meshRef.current.position.x, targetX, 0.07);
    meshRef.current.rotation.x = THREE.MathUtils.lerp(meshRef.current.rotation.x, targetRotX, 0.07);
    meshRef.current.rotation.y = THREE.MathUtils.lerp(meshRef.current.rotation.y, targetRotY, 0.07);
  });

  const lidRadius = (distance / Math.cos(Math.PI / numSides)) * 1.03;
  const lipHeight = 0.6;

  return (
    <group ref={meshRef} position={[0, size / 2, 0]} rotation={[0, Math.PI / numSides, 0]}>
      {/* Top cap — outer face */}
      <mesh position={[0, lipHeight / 2, 0]}>
        <cylinderGeometry args={[lidRadius, lidRadius, 0.05, numSides]} />
        <meshBasicMaterial color={baseColor} />
        <Edges color="#1a1a1a" threshold={15} />
      </mesh>
      {/* Top cap — inner underside face, exact color unaffected by lighting */}
      <mesh position={[0, lipHeight / 2 - 0.026, 0]}>
        <cylinderGeometry args={[lidRadius * 0.999, lidRadius * 0.999, 0.001, numSides]} />
        <meshBasicMaterial color={innerColor} />
      </mesh>
      {/* Lip ring — outer */}
      <mesh position={[0, 0, 0]}>
        <cylinderGeometry args={[lidRadius, lidRadius, lipHeight, numSides, 1, true]} />
        <meshBasicMaterial color={baseColor} side={THREE.FrontSide} />
        <Edges color="#1a1a1a" threshold={15} />
      </mesh>
      {/* Lip ring — inner, exact color */}
      <mesh position={[0, 0, 0]}>
        <cylinderGeometry args={[lidRadius, lidRadius, lipHeight, numSides, 1, true]} />
        <meshBasicMaterial color={innerColor} side={THREE.BackSide} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Floating heart
// ---------------------------------------------------------------------------
function FloatingHeart({ config }: { config: BoxConfig }) {
  const heartRef = useRef<THREE.Group>(null);
  const { openLevel, numLayers } = config;

  const heartShape = useMemo(() => {
    const shape = new THREE.Shape();
    const x = 0, y = 0;
    shape.moveTo(x + 0.5, y + 0.5);
    shape.bezierCurveTo(x + 0.5, y + 0.5, x + 0.4, y, x, y);
    shape.bezierCurveTo(x - 0.6, y, x - 0.6, y + 0.7, x - 0.6, y + 0.7);
    shape.bezierCurveTo(x - 0.6, y + 1.1, x - 0.3, y + 1.54, x + 0.5, y + 1.9);
    shape.bezierCurveTo(x + 1.2, y + 1.54, x + 1.6, y + 1.1, x + 1.6, y + 0.7);
    shape.bezierCurveTo(x + 1.6, y + 0.7, x + 1.6, y, x + 1, y);
    shape.bezierCurveTo(x + 0.7, y, x + 0.5, y + 0.5, x + 0.5, y + 0.5);
    return shape;
  }, []);

  useFrame((state) => {
    if (!heartRef.current) return;
    const t = state.clock.getElapsedTime();
    const basePos = -config.size / 2 + config.numLayers * 0.1;
    heartRef.current.position.y = THREE.MathUtils.lerp(
      heartRef.current.position.y,
      basePos + 0.8 + Math.sin(t * 2) * 0.1,
      0.05,
    );
    heartRef.current.rotation.y = t * 1.2;
    const targetScale = openLevel > numLayers ? 0.5 : 0;
    const s = THREE.MathUtils.lerp(heartRef.current.scale.x, targetScale, 0.1);
    heartRef.current.scale.set(s, s, s);
  });

  return (
    <group ref={heartRef} rotation={[Math.PI, 0, 0]} scale={[0, 0, 0]}>
      <mesh position={[-0.5, -1, 0]}>
        <extrudeGeometry
          args={[heartShape, { depth: 0.4, bevelEnabled: true, bevelSegments: 3, steps: 2, bevelSize: 0.08, bevelThickness: 0.08 }]}
        />
        <meshStandardMaterial color="#ff2d55" roughness={0.1} metalness={0.9} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Layer group — rotates all panels in one layer around Y as they open,
// offsetting each layer by half a panel width to create a pinwheel effect.
// ---------------------------------------------------------------------------
function LayerGroup({ config, layer, children }: { config: BoxConfig; layer: number; children: React.ReactNode }) {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    if (!groupRef.current) return;
    const isOpen = config.openLevel > layer + 1;
    // Each inner layer rotates an extra half-panel-width on Y when open
    const targetY = isOpen ? layer * (Math.PI / config.numSides) : 0;
    groupRef.current.rotation.y = THREE.MathUtils.lerp(
      groupRef.current.rotation.y, targetY, 0.06,
    );
  });

  return <group ref={groupRef}>{children}</group>;
}

// ---------------------------------------------------------------------------
// Scene root
// ---------------------------------------------------------------------------
export default function Box3D({
  config, sides, onSideClick,
}: {
  config: BoxConfig;
  sides: BoxSide[];
  onSideClick: (id: string) => void;
}) {
  const layersArray = Array.from({ length: config.numLayers }, (_, i) => i);

  return (
    <div className="w-full h-full">
      <Canvas shadows gl={{ antialias: true }}>
        <PerspectiveCamera makeDefault position={[7, 7, 7]} fov={45} />
        <OrbitControls
          enablePan={false}
          minDistance={3}
          maxDistance={12}
          autoRotate={config.openLevel === 0}
          autoRotateSpeed={0.3}
        />

        <ambientLight intensity={0.8} />
        <spotLight position={[10, 15, 10]} angle={0.3} penumbra={1} intensity={2} castShadow />
        <pointLight position={[-5, 5, -5]} intensity={1} color="#f472b6" />
        <pointLight position={[5, -5, 5]} intensity={0.5} color="#60a5fa" />

        <group>
          <Lid config={config} />
          <FloatingHeart config={config} />
          {layersArray.map(l => {
            const baseSide = sides.find(s => s.layer === l && s.index === -1);
            if (!baseSide) return null;
            return (
              <LayerGroup key={`layer-${l}`} config={config} layer={l}>
                <Base config={config} layer={l} side={baseSide} onSelect={onSideClick} />
                {sides.filter(s => s.layer === l && s.index >= 0).map(side => (
                  <Side key={side.id} side={side} config={config} onSelect={onSideClick} />
                ))}
              </LayerGroup>
            );
          })}
        </group>

        <ContactShadows position={[0, -config.size / 2, 0]} opacity={0.6} scale={15} blur={2} far={10} />
        <Environment preset="studio" />
      </Canvas>
    </div>
  );
}
