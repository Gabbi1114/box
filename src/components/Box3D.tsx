import React, { useRef, useMemo, useState, useEffect, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, ContactShadows, Edges } from '@react-three/drei';
import * as THREE from 'three';
import { BoxConfig, BoxSide } from '../types';

// iOS Safari has a ~150 MB WebGL texture limit; 512px textures use 1 MB each vs 4 MB at 1024px
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const RES = isIOS ? 512 : 1024;

// iOS Safari hard-limits concurrent hardware video decoders to 4 — keep 1 spare
let _activeVideoCount = 0;
const MAX_VIDEOS = isIOS ? 2 : 4;

const isGifUrl   = (url: string) => /\.gif(\?|$)/i.test(url);
const isVideoUrl = (url: string) =>
  /\.(mp4|webm|ogg|mov)(\?|$)/i.test(url) || url.startsWith('blob:');
const isAnimated = (url: string) => isGifUrl(url) || isVideoUrl(url);

// ---------------------------------------------------------------------------
// Single shared RAF ticker — all animated sides share one loop instead of
// each running its own setInterval. Throttled to GIF_FPS to avoid hammering
// the GPU with texture uploads on every frame.
// ---------------------------------------------------------------------------
const GIF_FPS   = isIOS ? 6 : 10;          // lower on iOS to save battery
const GIF_FRAME = 1000 / GIF_FPS;          // ms between texture uploads

type DrawCallback = () => void;
const _animDrawers = new Set<DrawCallback>();
let   _rafId: number | null = null;
let   _lastTick = 0;

function _tick(now: number) {
  _rafId = requestAnimationFrame(_tick);
  if (now - _lastTick < GIF_FRAME) return;   // throttle
  _lastTick = now;
  _animDrawers.forEach(fn => fn());
}

function registerAnimDraw(fn: DrawCallback) {
  if (_animDrawers.size === 0) _rafId = requestAnimationFrame(_tick);
  _animDrawers.add(fn);
}
function unregisterAnimDraw(fn: DrawCallback) {
  _animDrawers.delete(fn);
  if (_animDrawers.size === 0 && _rafId !== null) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
}

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

  const media      = useRef(new Map<string, HTMLImageElement | HTMLVideoElement>());
  const gifImgs    = useRef<HTMLImageElement[]>([]);
  const videoElems = useRef<HTMLVideoElement[]>([]);
  const drawFn     = useRef<() => void>(() => {});
  const registeredDraw = useRef<DrawCallback | null>(null);

  useEffect(() => {
    drawFn.current = () => {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = innerColor;
      ctx.fillRect(0, 0, RES, RES);

      // Scale factor: editor canvas px → texture px.
      // Use the designCanvasSize stamped on each element (exact size when it was placed)
      // so text/images look identical regardless of which device the editor was on.
      const windowCanvasSize = Math.min(window.innerHeight * 0.55, window.innerWidth * 0.55);

      for (const el of side.elements) {
        // Per-element scale: use stored canvas size (phone/desktop aware), fall back to window
        const dcs = el.designCanvasSize ?? windowCanvasSize;
        const texScale = RES / dcs;

        ctx.save();
        ctx.translate((el.x / 100) * RES, (el.y / 100) * RES);
        ctx.rotate((el.rotation * Math.PI) / 180);
        ctx.scale(el.scale, el.scale);

        if (el.type === 'text') {
          ctx.font = `bold ${(el.fontSize ?? 24) * texScale}px sans-serif`;
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
              // Mirror editor behaviour: scale down if larger than canvas, don't scale up small items
              const fitScale = Math.min(1, dcs / w, dcs / h);
              const drawW = w * fitScale * texScale;
              const drawH = h * fitScale * texScale;
              ctx.drawImage(src as CanvasImageSource, -drawW / 2, -drawH / 2, drawW, drawH);
            }
          }
        } else if (el.type === 'sticker') {
          const emojiMap: Record<string, string> = { heart: '❤️', star: '⭐', sparkle: '✨', face: '😊' };
          ctx.font = `${72 * texScale}px serif`;  // 72px in editor → scaled to texture
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
        // Enforce decoder cap — skip if at limit
        if (_activeVideoCount >= MAX_VIDEOS) {
          if (--pending === 0) drawFn.current();
          continue;
        }
        _activeVideoCount++;
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
        vid.onerror = () => { _activeVideoCount = Math.max(0, _activeVideoCount - 1); if (--pending === 0) drawFn.current(); };
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

  // Animated textures: register with the shared RAF ticker (throttled to GIF_FPS)
  const hasAnimated = side.elements.some(el => el.type === 'image' && isAnimated(el.content));
  useEffect(() => {
    if (!hasAnimated) {
      if (registeredDraw.current) { unregisterAnimDraw(registeredDraw.current); registeredDraw.current = null; }
      return;
    }
    const fn: DrawCallback = () => drawFn.current();
    registeredDraw.current = fn;
    registerAnimDraw(fn);
    return () => { unregisterAnimDraw(fn); registeredDraw.current = null; };
  }, [hasAnimated]);

  useEffect(() => () => {
    texture.dispose();
    gifImgs.current.forEach(img => img.parentNode?.removeChild(img));
    gifImgs.current = [];
    videoElems.current.forEach(v => {
      v.pause();
      v.src = '';   // forces iOS to release the hardware decoder immediately
      v.load();
      v.parentNode?.removeChild(v);
      _activeVideoCount = Math.max(0, _activeVideoCount - 1);
    });
    videoElems.current = [];
    if (registeredDraw.current) { unregisterAnimDraw(registeredDraw.current); registeredDraw.current = null; }
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
// Pauses the render loop when the tab is hidden (iOS doesn't always do this)
// ---------------------------------------------------------------------------
function VisibilityGuard() {
  const { gl, invalidate } = useThree();
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        gl.domElement.style.visibility = 'hidden';
      } else {
        gl.domElement.style.visibility = '';
        invalidate();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [gl, invalidate]);
  return null;
}

// ---------------------------------------------------------------------------
// Signals parent when the first frame has been rendered
// ---------------------------------------------------------------------------
function FirstFrameReady({ onReady }: { onReady: () => void }) {
  const { invalidate } = useThree();
  const done = useRef(false);
  useEffect(() => { invalidate(); }, []);
  useFrame(() => {
    if (!done.current) {
      done.current = true;
      setTimeout(onReady, 100);
    }
  });
  return null;
}

// ---------------------------------------------------------------------------
// Scene root
// ---------------------------------------------------------------------------
export default function Box3D({
  config, sides, onSideClick, onReady, suspended = false,
}: {
  config: BoxConfig;
  sides: BoxSide[];
  onSideClick: (id: string) => void;
  onReady?: () => void;
  suspended?: boolean;
}) {
  const layersArray = Array.from({ length: config.numLayers }, (_, i) => i);
  const autoRotate  = config.openLevel === 0;

  return (
    <div className="w-full h-full">
      <Canvas
        frameloop="demand"
        dpr={[1, isIOS ? 1 : 1.5]}
        performance={{ min: 0.5 }}
        gl={{ antialias: !isIOS, powerPreference: 'low-power' }}
      >
        <VisibilityGuard />
        <AutoRotateDriver active={autoRotate && !suspended} />
        {onReady && <FirstFrameReady onReady={onReady} />}
        <PerspectiveCamera makeDefault position={[7, 7, 7]} fov={45} />
        <OrbitControls
          enablePan={false}
          minDistance={3}
          maxDistance={12}
          autoRotate={autoRotate && !suspended}
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

        {/* ContactShadows disabled on iOS — off-screen framebuffer doubles GPU draw calls */}
        {!isIOS && (
          <ContactShadows position={[0, -config.size / 2, 0]} opacity={0.4} scale={12} blur={1.5} far={8} />
        )}
      </Canvas>
    </div>
  );
}
