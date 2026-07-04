import React, { useRef, useMemo, useState, useEffect, useCallback, Suspense } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, ContactShadows, Edges, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { BoxConfig, BoxSide, GraphicElement } from '../types';

// Draco decoder hosted locally (public/draco/) rather than drei's default CDN
// path — avoids a third-party dependency at runtime for a feature this core.
const DRACO_PATH = '/draco/';
const CAKE_MODEL_URL = '/models/birthday_cake.glb';
const ROSE_MODEL_URL = '/models/flower_bouquet.glb';
const HEART_MODEL_URL = '/models/heart_with_arrow.glb';
useGLTF.preload(CAKE_MODEL_URL, DRACO_PATH);
useGLTF.preload(ROSE_MODEL_URL, DRACO_PATH);
useGLTF.preload(HEART_MODEL_URL, DRACO_PATH);

// iOS Safari has a ~150 MB WebGL texture limit; 512px textures use 1 MB each vs 4 MB at 1024px
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const RES = isIOS ? 512 : 1024;

// Track active video elements so we can clean them up on unmount.
// No hard cap — short looping Tenor clips use efficient software decoders
// on modern devices. The browser will fire onerror if it truly runs out.
let _activeVideoCount = 0;

const isGifUrl   = (url: string) => /\.gif(\?|$)/i.test(url);
// blob: URLs (local fallback) carry no extension to sniff, so the explicit
// isVideo flag is authoritative there; extension check covers hosted URLs.
const isVideoUrl = (el: GraphicElement) =>
  el.isVideo === true || /\.(mp4|webm|ogg|mov)(\?|$)/i.test(el.content);
const isAnimated = (el: GraphicElement) => isGifUrl(el.content) || isVideoUrl(el);

// ---------------------------------------------------------------------------
// Single shared RAF ticker — all animated sides share one loop instead of
// each running its own setInterval. Throttled to GIF_FPS to avoid hammering
// the GPU with texture uploads on every frame.
// ---------------------------------------------------------------------------
const GIF_FPS   = isIOS ? 6 : 8;           // lower on iOS to save battery
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

  const { canvas, ctx, staticCanvas, staticCtx, texture } = useMemo(() => {
    // Composite canvas — what gets uploaded to GPU as a texture
    const canvas = document.createElement('canvas');
    canvas.width = RES;
    canvas.height = RES;
    const ctx = canvas.getContext('2d')!;

    // Static cache canvas — holds background + text + stickers + static images.
    // Redrawn only when those elements change, not on every animated frame.
    const staticCanvas = document.createElement('canvas');
    staticCanvas.width = RES;
    staticCanvas.height = RES;
    const staticCtx = staticCanvas.getContext('2d')!;
    staticCtx.fillStyle = '#ffffff';
    staticCtx.fillRect(0, 0, RES, RES);

    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY = true;
    texture.channel = 0;
    // Skip mipmap chain — saves GPU memory and avoids regeneration on every upload
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    return { canvas, ctx, staticCanvas, staticCtx, texture };
  }, []);

  const media          = useRef(new Map<string, HTMLImageElement | HTMLVideoElement>());
  const gifImgs        = useRef<HTMLImageElement[]>([]);
  const videoElems     = useRef<HTMLVideoElement[]>([]);
  const drawFn         = useRef<() => void>(() => {});
  const lastVideoTime  = useRef(new Map<string, number>());
  const registeredDraw = useRef<DrawCallback | null>(null);

  useEffect(() => {
    // Force re-check of video frames on any element/color change so position/scale
    // updates aren't silently skipped by the currentTime guard in drawFn.
    lastVideoTime.current.clear();

    const windowCanvasSize = Math.min(window.innerHeight * 0.55, window.innerWidth * 0.55);

    // ── Build static cache: background + text + stickers + static images ──────
    // Called once per element/color change, not on every animated frame tick.
    const buildStaticLayer = () => {
      staticCtx.imageSmoothingEnabled = true;
      staticCtx.imageSmoothingQuality = 'high';
      staticCtx.fillStyle = innerColor;
      staticCtx.fillRect(0, 0, RES, RES);

      for (const el of side.elements) {
        if (el.type === 'image' && isAnimated(el)) continue; // animated: handled in drawFn

        const dcs = el.designCanvasSize ?? windowCanvasSize;
        const texScale = RES / dcs;

        staticCtx.save();
        staticCtx.translate((el.x / 100) * RES, (el.y / 100) * RES);
        staticCtx.rotate((el.rotation * Math.PI) / 180);
        staticCtx.scale(el.scale, el.scale);

        if (el.type === 'text') {
          staticCtx.font = `bold ${(el.fontSize ?? 24) * texScale}px sans-serif`;
          staticCtx.fillStyle = el.color ?? '#ffffff';
          staticCtx.textAlign = 'center';
          staticCtx.textBaseline = 'middle';
          staticCtx.shadowColor = 'rgba(0,0,0,0.5)';
          staticCtx.shadowBlur = 4;
          staticCtx.fillText(el.content, 0, 0);
        } else if (el.type === 'image') {
          const src = media.current.get(el.content);
          if (src) {
            const w = (src as HTMLImageElement).naturalWidth;
            const h = (src as HTMLImageElement).naturalHeight;
            if (w && h) {
              const fitScale = Math.min(1, dcs / w, dcs / h);
              const drawW = w * fitScale * texScale;
              const drawH = h * fitScale * texScale;
              staticCtx.drawImage(src as CanvasImageSource, -drawW / 2, -drawH / 2, drawW, drawH);
            }
          }
        } else if (el.type === 'sticker') {
          const emojiMap: Record<string, string> = { heart: '❤️', star: '⭐', sparkle: '✨', face: '😊' };
          staticCtx.font = `${72 * texScale}px serif`;
          staticCtx.textAlign = 'center';
          staticCtx.textBaseline = 'middle';
          staticCtx.fillText(emojiMap[el.content] ?? '❤️', 0, 0);
        }
        staticCtx.restore();
      }
    };

    // ── Animated draw: copies static cache then overlays video/GIF frames ─────
    // This is called by the RAF ticker on every animated tick — it is kept cheap
    // by skipping the static elements (already in staticCanvas) and by guarding
    // against uploading the same video frame twice.
    drawFn.current = () => {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(staticCanvas, 0, 0); // fast copy — no text/sticker redraw needed

      let dirty = false;
      for (const el of side.elements) {
        if (el.type !== 'image' || !isAnimated(el)) continue;
        const src = media.current.get(el.content);
        if (!src) continue;

        if (isVideoUrl(el)) {
          // Skip GPU upload if the video decoder hasn't produced a new frame yet
          const vid = src as HTMLVideoElement;
          const prev = lastVideoTime.current.get(el.content) ?? -1;
          if (vid.currentTime === prev) continue;
          lastVideoTime.current.set(el.content, vid.currentTime);
        }

        dirty = true;
        const dcs = el.designCanvasSize ?? windowCanvasSize;
        const texScale = RES / dcs;

        ctx.save();
        ctx.translate((el.x / 100) * RES, (el.y / 100) * RES);
        ctx.rotate((el.rotation * Math.PI) / 180);
        ctx.scale(el.scale, el.scale);

        const w = (src as HTMLVideoElement).videoWidth  || (src as HTMLImageElement).naturalWidth;
        const h = (src as HTMLVideoElement).videoHeight || (src as HTMLImageElement).naturalHeight;
        if (w && h) {
          const fitScale = Math.min(1, dcs / w, dcs / h);
          const drawW = w * fitScale * texScale;
          const drawH = h * fitScale * texScale;
          ctx.drawImage(src as CanvasImageSource, -drawW / 2, -drawH / 2, drawW, drawH);
        }
        ctx.restore();
      }

      if (dirty) {
        texture.needsUpdate = true;
        invalidate();
      }
    };

    // Initial paint: build static layer, blit to composite, then composite any
    // already-loaded animated elements on top in one shot.
    buildStaticLayer();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(staticCanvas, 0, 0);
    texture.needsUpdate = true;
    invalidate();
    drawFn.current(); // overlay any already-loaded videos/GIFs immediately

    const toLoad = side.elements.filter(
      el => el.type === 'image' && !media.current.has(el.content),
    );
    if (toLoad.length === 0) return;

    let pending = toLoad.length;
    for (const el of toLoad) {
      if (isVideoUrl(el)) {
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
          if (!isGifUrl(el.content)) {
            // Static image: rebuild static layer and upload immediately for instant feedback
            buildStaticLayer();
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(staticCanvas, 0, 0);
            texture.needsUpdate = true;
            invalidate();
          }
          if (--pending === 0) drawFn.current();
        };
        img.onerror = () => { if (--pending === 0) drawFn.current(); };
        img.src = el.content;
      }
    }
  }, [side.elements, innerColor]);

  // Animated textures: register with the shared RAF ticker (throttled to GIF_FPS)
  const hasAnimated = side.elements.some(el => el.type === 'image' && isAnimated(el));
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
// Floating shape — a decorative object that pops up once the box is fully
// exploded. Several selectable variants share the same bob/spin/scale-in
// animation; only the geometry composition below the outer group differs.
// ---------------------------------------------------------------------------
// Draco-compressed GLB models (see public/models/). Licenses:
// "Birthday Cake" by 3DMish (CC-BY-4.0, credit required) and "Flower Bouquet"
// by icecool (CC-BY-4.0, credit required), both via Sketchfab — "Heart with
// Arrow" by minimoku (Sketchfab Standard license, no attribution required).
function CakeModel() {
  const { scene } = useGLTF(CAKE_MODEL_URL, DRACO_PATH);
  return <primitive object={scene} scale={6.5} position={[0, -0.9, 0]} />;
}

function RoseModel() {
  const { scene } = useGLTF(ROSE_MODEL_URL, DRACO_PATH);
  return <primitive object={scene} scale={5.5} position={[0, -0.95, 0]} />;
}

function HeartModel() {
  const { scene } = useGLTF(HEART_MODEL_URL, DRACO_PATH);
  return <primitive object={scene} scale={0.85} position={[0, -0.05, 0]} />;
}

function FloatingShape({ config }: { config: BoxConfig }) {
  const { invalidate } = useThree();
  const shapeRef = useRef<THREE.Group>(null);
  const { openLevel, numLayers, floatingShape = 'heart' } = config;

  useFrame((state) => {
    if (!shapeRef.current) return;
    const visible = openLevel > numLayers;
    const targetScale = visible ? 0.5 : 0;
    const s = THREE.MathUtils.lerp(shapeRef.current.scale.x, targetScale, 0.1);
    shapeRef.current.scale.set(s, s, s);

    if (visible || shapeRef.current.scale.x > 0.01) {
      const t = state.clock.getElapsedTime();
      const basePos = -config.size / 2 + config.numLayers * 0.1;
      shapeRef.current.position.y = THREE.MathUtils.lerp(
        shapeRef.current.position.y, basePos + 0.8 + Math.sin(t * 2) * 0.1, 0.05,
      );
      shapeRef.current.rotation.y = t * 1.2;
      invalidate();
    }
  });

  return (
    <group ref={shapeRef} scale={[0, 0, 0]}>
      {floatingShape === 'heart' && (
        <Suspense fallback={null}>
          <HeartModel />
        </Suspense>
      )}

      {floatingShape === 'cake' && (
        <Suspense fallback={null}>
          <CakeModel />
        </Suspense>
      )}

      {floatingShape === 'rose' && (
        <Suspense fallback={null}>
          <RoseModel />
        </Suspense>
      )}
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
// Recovers from a lost WebGL context (GPU driver reset, laptop switching
// between integrated/discrete graphics, tab backgrounded too long, etc).
// Without calling preventDefault() on the loss event, the browser considers
// the context permanently dead and never fires 'webglcontextrestored' — the
// canvas just stays black/frozen forever, and R3F hooks that fire afterward
// throw "Hooks can only be used within the Canvas component" because the
// underlying GL store is gone. This has nothing to do with what triggered
// the loss; every WebGL app needs this handler.
// ---------------------------------------------------------------------------
function ContextLossGuard() {
  const { gl, invalidate } = useThree();
  useEffect(() => {
    const canvas = gl.domElement;
    const onLost = (event: Event) => {
      event.preventDefault();
      console.warn('[Box3D] WebGL context lost — waiting for restore.');
    };
    const onRestored = () => {
      console.warn('[Box3D] WebGL context restored.');
      invalidate();
    };
    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    };
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
        dpr={[1, isIOS ? 1 : 2]}
        performance={{ min: 0.5 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
      >
        <VisibilityGuard />
        <ContextLossGuard />
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
          <FloatingShape config={config} />
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
