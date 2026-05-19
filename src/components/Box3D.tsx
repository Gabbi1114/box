import React, { useRef, useMemo, useState, useEffect, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, ContactShadows, Edges } from '@react-three/drei';
import * as THREE from 'three';
import { BoxConfig, BoxSide } from '../types';

const RES = 1024;
const isGifUrl   = (url: string) => /\.gif(\?|$)/i.test(url);
const isVideoUrl = (url: string) =>
  /\.(mp4|webm|ogg|mov)(\?|$)/i.test(url) || url.startsWith('blob:');
const isAnimated = (url: string) => isGifUrl(url) || isVideoUrl(url);

// ---------------------------------------------------------------------------
// Canvas texture hook
// ---------------------------------------------------------------------------
function useSideTexture(side: BoxSide, innerColor: string) {
  const { invalidate } = useThree();

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

  const media    = useRef(new Map<string, HTMLImageElement | HTMLVideoElement>());
  const gifImgs  = useRef<HTMLImageElement[]>([]);
  const videoElems = useRef<HTMLVideoElement[]>([]);
  const drawFn   = useRef<() => void>(() => {});
  const animTimer = useRef<ReturnType<typeof setInterval> | null>(null);

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
            const w = (src as HTMLVideoElement).videoWidth  || (src as HTMLImageElement).naturalWidth;
            const h = (src as HTMLVideoElement).videoHeight || (src as HTMLImageElement).naturalHeight;
            if (w && h) {
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
      invalidate();
    };

    const toLoad = side.elements.filter(
      el => el.type === 'image' && !media.current.has(el.content),
    );
    drawFn.current();
    if (toLoad.length === 0) return;

    let pending = toLoad.length;
    for (const el of toLoad) {
      if (isVideoUrl(el.content)) {
        const vid = document.createElement('video');
        vid.loop = true;
        vid.muted = true;
        vid.autoplay = true;
        vid.playsInline = true;
        vid.crossOrigin = 'anonymous';
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

  // Animated textures: redraw at 10 fps via interval, not useFrame
  const hasAnimated = side.elements.some(el => el.type === 'image' && isAnimated(el.content));
  useEffect(() => {
    if (!hasAnimated) return;
    animTimer.current = setInterval(() => { drawFn.current(); }, 100); // 10 fps
    return () => { if (animTimer.current) clearInterval(animTimer.current); };
  }, [hasAnimated]);

  useEffect(() => () => {
    texture.dispose();
    gifImgs.current.forEach(img => img.parentNode?.removeChild(img));
    gifImgs.current = [];
    videoElems.current.forEach(v => { v.pause(); v.parentNode?.removeChild(v); });
    videoElems.current = [];
    if (animTimer.current) clearInterval(animTimer.current);
  }, []);

  return { texture, drawFn };
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------
interface SideProps { side: BoxSide; config: BoxConfig; onSelect: (id: string) => void; }

function Side({ side, config, onSelect }: SideProps) {
  const { invalidate } = useThree();
  const { numSides, baseColor, innerColor, openLevel } = config;
  const layerScale  = 1 - side.layer * (1 / (config.numLayers + 1));
  const baseSize    = config.size * layerScale;
  const layerOffset = side.layer * 0.1;
  const distance    = baseSize / (2 * Math.tan(Math.PI / numSides));
  const angle       = (side.index / numSides) * Math.PI * 2;

  const groupRef   = useRef<THREE.Group>(null);
  const openTriggeredAt = useRef<number | null>(null);
  const { texture } = useSideTexture(side, innerColor);
  const staggerDelay = (side.index / numSides) * 0.35;

  useFrame((state) => {
    if (!groupRef.current) return;
    const shouldBeOpen = openLevel > side.layer + 1;

    if (shouldBeOpen && openTriggeredAt.current === null) {
      openTriggeredAt.current = state.clock.getElapsedTime();
    } else if (!shouldBeOpen) {
      openTriggeredAt.current = null;
    }

    const elapsed = openTriggeredAt.current !== null
      ? state.clock.getElapsedTime() - openTriggeredAt.current : 0;
    const isOpen = shouldBeOpen && elapsed >= staggerDelay;
    const target = isOpen ? Math.PI / 2 : 0;
    const lerpFactor = isOpen ? 0.12 : 0.08;
    const diff = target - groupRef.current.rotation.x;

    if (Math.abs(diff) > 0.001) {
      groupRef.current.rotation.x = THREE.MathUtils.lerp(groupRef.current.rotation.x, target, lerpFactor);
      invalidate();
    } else {
      groupRef.current.rotation.x = target;
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
          <boxGeometry args={[baseSize, baseSize, 0.05]} />
          <meshBasicMaterial color={baseColor} />
          <Edges color="#1a1a1a" threshold={15} />
          <mesh position={[0, 0, -(0.05 / 2 + 0.001)]} rotation={[0, Math.PI, 0]}>
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
  config: BoxConfig; layer: number; side: BoxSide; onSelect: (id: string) => void;
}) {
  const { numSides, baseColor, innerColor, openLevel } = config;
  const layerScale  = 1 - layer * (1 / (config.numLayers + 1));
  const baseSize    = config.size * layerScale;
  const r           = (baseSize / (2 * Math.tan(Math.PI / numSides))) / Math.cos(Math.PI / numSides);
  const layerOffset = layer * 0.1;

  const { texture } = useSideTexture(side, innerColor);

  const polygonShape = useMemo(() => {
    const shape = new THREE.Shape();
    for (let i = 0; i < numSides; i++) {
      const phi = (i / numSides) * Math.PI * 2;
      i === 0 ? shape.moveTo(r * Math.sin(phi), -r * Math.cos(phi))
              : shape.lineTo(r * Math.sin(phi), -r * Math.cos(phi));
    }
    shape.closePath();
    return shape;
  }, [numSides, r]);

  const baseGeo = useMemo(() => {
    const geo = new THREE.ShapeGeometry(polygonShape);
    const pos = geo.attributes.position;
    const uv  = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, (pos.getX(i) + r) / (2 * r), (pos.getY(i) + r) / (2 * r));
    }
    uv.needsUpdate = true;
    return geo;
  }, [polygonShape, r]);

  return (
    <group position={[0, -config.size / 2 + layerOffset, 0]} rotation={[0, Math.PI / numSides, 0]}>
      <mesh>
        <cylinderGeometry args={[r, r, 0.05, numSides]} />
        <meshBasicMaterial color={baseColor} />
        <Edges color="#1a1a1a" threshold={15} />
      </mesh>
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
  const { invalidate } = useThree();
  const { size, baseColor, innerColor, openLevel, numSides } = config;
  const distance  = size / (2 * Math.tan(Math.PI / numSides));
  const meshRef   = useRef<THREE.Mesh>(null);
  const lidRadius = (distance / Math.cos(Math.PI / numSides)) * 1.03;
  const lipHeight = 0.6;

  useFrame(() => {
    if (!meshRef.current) return;
    const isOff    = openLevel >= 1;
    const tY       = isOff ? size * 3.5 : size / 2;
    const tX       = isOff ? size * 1.8 : 0;
    const tRX      = isOff ? -Math.PI / 4 : 0;
    const tRY      = isOff ? 0 : Math.PI / numSides;
    const m        = meshRef.current;
    const moving   =
      Math.abs(m.position.y - tY) > 0.002 ||
      Math.abs(m.position.x - tX) > 0.002 ||
      Math.abs(m.rotation.x - tRX) > 0.001 ||
      Math.abs(m.rotation.y - tRY) > 0.001;

    if (moving) {
      m.position.y  = THREE.MathUtils.lerp(m.position.y,  tY,  0.07);
      m.position.x  = THREE.MathUtils.lerp(m.position.x,  tX,  0.07);
      m.rotation.x  = THREE.MathUtils.lerp(m.rotation.x,  tRX, 0.07);
      m.rotation.y  = THREE.MathUtils.lerp(m.rotation.y,  tRY, 0.07);
      invalidate();
    }
  });

  return (
    <group ref={meshRef} position={[0, size / 2, 0]} rotation={[0, Math.PI / numSides, 0]}>
      <mesh position={[0, lipHeight / 2, 0]}>
        <cylinderGeometry args={[lidRadius, lidRadius, 0.05, numSides]} />
        <meshBasicMaterial color={baseColor} />
        <Edges color="#1a1a1a" threshold={15} />
      </mesh>
      <mesh position={[0, lipHeight / 2 - 0.026, 0]}>
        <cylinderGeometry args={[lidRadius * 0.999, lidRadius * 0.999, 0.001, numSides]} />
        <meshBasicMaterial color={innerColor} />
      </mesh>
      <mesh position={[0, 0, 0]}>
        <cylinderGeometry args={[lidRadius, lidRadius, lipHeight, numSides, 1, true]} />
        <meshBasicMaterial color={baseColor} side={THREE.FrontSide} />
        <Edges color="#1a1a1a" threshold={15} />
      </mesh>
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
  const { invalidate } = useThree();
  const heartRef = useRef<THREE.Group>(null);
  const { openLevel, numLayers } = config;

  const heartShape = useMemo(() => {
    const s = new THREE.Shape();
    const x = 0, y = 0;
    s.moveTo(x + 0.5, y + 0.5);
    s.bezierCurveTo(x + 0.5, y + 0.5, x + 0.4, y, x, y);
    s.bezierCurveTo(x - 0.6, y, x - 0.6, y + 0.7, x - 0.6, y + 0.7);
    s.bezierCurveTo(x - 0.6, y + 1.1, x - 0.3, y + 1.54, x + 0.5, y + 1.9);
    s.bezierCurveTo(x + 1.2, y + 1.54, x + 1.6, y + 1.1, x + 1.6, y + 0.7);
    s.bezierCurveTo(x + 1.6, y + 0.7, x + 1.6, y, x + 1, y);
    s.bezierCurveTo(x + 0.7, y, x + 0.5, y + 0.5, x + 0.5, y + 0.5);
    return s;
  }, []);

  useFrame((state) => {
    if (!heartRef.current) return;
    const visible = openLevel > numLayers;
    const targetScale = visible ? 0.5 : 0;
    const s = THREE.MathUtils.lerp(heartRef.current.scale.x, targetScale, 0.1);
    heartRef.current.scale.set(s, s, s);

    if (visible || heartRef.current.scale.x > 0.01) {
      const t = state.clock.getElapsedTime();
      const basePos = -config.size / 2 + config.numLayers * 0.1;
      heartRef.current.position.y = THREE.MathUtils.lerp(
        heartRef.current.position.y, basePos + 0.8 + Math.sin(t * 2) * 0.1, 0.05,
      );
      heartRef.current.rotation.y = t * 1.2;
      invalidate();
    }
  });

  return (
    <group ref={heartRef} rotation={[Math.PI, 0, 0]} scale={[0, 0, 0]}>
      <mesh position={[-0.5, -1, 0]}>
        <extrudeGeometry
          args={[heartShape, { depth: 0.4, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.08, bevelThickness: 0.08 }]}
        />
        <meshStandardMaterial color="#ff2d55" roughness={0.3} metalness={0.5} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Layer group
// ---------------------------------------------------------------------------
function LayerGroup({ config, layer, children }: { config: BoxConfig; layer: number; children: React.ReactNode }) {
  const { invalidate } = useThree();
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    if (!groupRef.current) return;
    const isOpen  = config.openLevel > layer + 1;
    const targetY = isOpen ? layer * (Math.PI / config.numSides) : 0;
    const diff    = targetY - groupRef.current.rotation.y;
    if (Math.abs(diff) > 0.001) {
      groupRef.current.rotation.y = THREE.MathUtils.lerp(groupRef.current.rotation.y, targetY, 0.06);
      invalidate();
    } else {
      groupRef.current.rotation.y = targetY;
    }
  });

  return <group ref={groupRef}>{children}</group>;
}

// ---------------------------------------------------------------------------
// Auto-rotate invalidator — only runs when autoRotate is active
// ---------------------------------------------------------------------------
function AutoRotateDriver({ active }: { active: boolean }) {
  const { invalidate } = useThree();
  useFrame(() => { if (active) invalidate(); });
  return null;
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
  const autoRotate  = config.openLevel === 0;

  return (
    <div className="w-full h-full">
      <Canvas
        frameloop="demand"
        dpr={[1, 1.5]}
        performance={{ min: 0.5 }}
        gl={{ antialias: true, powerPreference: 'low-power' }}
      >
        <AutoRotateDriver active={autoRotate} />
        <PerspectiveCamera makeDefault position={[7, 7, 7]} fov={45} />
        <OrbitControls
          enablePan={false}
          minDistance={3}
          maxDistance={12}
          autoRotate={autoRotate}
          autoRotateSpeed={0.3}
        />

        <ambientLight intensity={1.0} />
        <directionalLight position={[10, 15, 10]} intensity={1.5} />
        <pointLight position={[-5, 5, -5]} intensity={0.8} color="#f472b6" />

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

        <ContactShadows position={[0, -config.size / 2, 0]} opacity={0.4} scale={12} blur={1.5} far={8} />
      </Canvas>
    </div>
  );
}
