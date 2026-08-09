import { useEffect, useRef, useState } from 'react';
import { Check, Circle, Eraser, Highlighter, Paintbrush, Pen, Pencil, SprayCan, Trash2, Undo2, X } from 'lucide-react';
import { useLang, type TKey } from '../lib/i18n';

const COLORS = [
  '#ffffff', '#171717', '#f87171', '#fb923c',
  '#fbbf24', '#34d399', '#60a5fa', '#a78bfa',
];

const DEFAULT_CANVAS_W = 900;
const DEFAULT_CANVAS_H = 900;

type BrushType = 'pen' | 'pencil' | 'brush' | 'marker' | 'spray' | 'circle' | 'eraser';

interface Point { x: number; y: number; }

const BRUSHES: { id: BrushType; icon: typeof Pen; labelKey: TKey }[] = [
  { id: 'pen', icon: Pen, labelKey: 'penBrush' },
  { id: 'pencil', icon: Pencil, labelKey: 'pencilBrush' },
  { id: 'brush', icon: Paintbrush, labelKey: 'softBrush' },
  { id: 'marker', icon: Highlighter, labelKey: 'markerBrush' },
  { id: 'spray', icon: SprayCan, labelKey: 'sprayBrush' },
  { id: 'circle', icon: Circle, labelKey: 'circleBrush' },
  { id: 'eraser', icon: Eraser, labelKey: 'eraser' },
];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Ports book's PageEditor.jsx freehand brush algorithms onto a plain 2D canvas. */
function drawSegment(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  opts: { type: BrushType; color: string; size: number; opacity: number },
) {
  const { type, color, size, opacity } = opts;
  const [r, g, b] = hexToRgb(color);

  if (type === 'eraser') {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = size * 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (type === 'brush') {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const spacing = Math.max(1, size * 0.12);
    const steps = Math.max(1, Math.ceil(dist / spacing));
    ctx.save();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      const rad = size * 0.9;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0, `rgba(${r},${g},${b},${opacity * 0.22})`);
      grad.addColorStop(0.4, `rgba(${r},${g},${b},${opacity * 0.1})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  if (type === 'spray') {
    const density = Math.max(20, size * 2.5);
    const radius = size * 2;
    ctx.save();
    for (let i = 0; i < density; i++) {
      const ang = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * radius;
      ctx.fillStyle = `rgba(${r},${g},${b},${opacity * (0.35 + Math.random() * 0.65)})`;
      ctx.beginPath();
      ctx.arc(to.x + Math.cos(ang) * d, to.y + Math.sin(ang) * d, Math.random() * size * 0.22 + 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  if (type === 'circle') {
    const minR = Math.max(0, size - 20);
    const maxR = size + 20;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.round(dist / maxR));
    ctx.save();
    for (let i = 0; i < steps; i++) {
      const t = (i + 1) / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      const radius = (minR + Math.random() * (maxR - minR)) / 2;
      const a = Math.random();
      ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.lineCap = ctx.lineJoin = 'round';
  if (type === 'marker') {
    ctx.lineCap = 'square';
    ctx.lineWidth = size * 1.9;
    ctx.strokeStyle = `rgba(${r},${g},${b},${opacity * 0.65})`;
  } else if (type === 'pencil') {
    ctx.lineWidth = size * 0.85;
    ctx.strokeStyle = `rgba(${r},${g},${b},${opacity * 0.88})`;
    ctx.shadowColor = `rgba(${r},${g},${b},${opacity * 0.28})`;
    ctx.shadowBlur = size * 0.55;
  } else {
    ctx.lineWidth = size;
    ctx.strokeStyle = `rgba(${r},${g},${b},${opacity})`;
  }
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

/**
 * Freehand drawing tool for a box side. `background` renders the side's
 * live content behind a transparent canvas so strokes land in context, then
 * hands the result back as a PNG File through the same pipeline as an
 * uploaded photo (handleImageFile) — no new element type.
 */
export default function DrawingModal({
  background,
  canvasWidth,
  canvasHeight,
  initialDrawingUrl,
  onCancel,
  onInsert,
  onRemove,
}: {
  background?: React.ReactNode;
  /** Overrides the drawing canvas' pixel size/aspect ratio — used to match
   *  a specific photo's box instead of the default whole-side square. */
  canvasWidth?: number;
  canvasHeight?: number;
  /** An existing drawing to load onto the canvas before the user draws
   *  anything new — editing ink already on the side/photo adds to it
   *  instead of starting over. */
  initialDrawingUrl?: string;
  onCancel: () => void;
  onInsert: (file: File) => void;
  /** Deletes the existing drawing outright — only offered when there is
   *  one (initialDrawingUrl is set). Bypasses the canvas entirely. */
  onRemove?: () => void;
}) {
  const { t } = useLang();
  const CANVAS_W = canvasWidth ?? DEFAULT_CANVAS_W;
  const CANVAS_H = canvasHeight ?? DEFAULT_CANVAS_H;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const historyRef = useRef<ImageData[]>([]);
  const lastPointRef = useRef<Point | null>(null);
  const isDrawingRef = useRef(false);
  const [strokeCount, setStrokeCount] = useState(0);
  const [hasInitial, setHasInitial] = useState(false);

  const [brush, setBrush] = useState<BrushType>('pen');
  const [color, setColor] = useState('#171717');
  const [size, setSize] = useState(12);
  const [opacity, setOpacity] = useState(1);

  const getCtx = () => canvasRef.current?.getContext('2d') ?? null;

  useEffect(() => {
    if (!initialDrawingUrl) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const ctx = getCtx();
      const canvas = canvasRef.current;
      if (!ctx || !canvas) return;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      setHasInitial(true);
    };
    img.src = initialDrawingUrl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDrawingUrl]);

  const pushHistory = () => {
    const ctx = getCtx();
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    historyRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (historyRef.current.length > 30) historyRef.current.shift();
  };

  const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * CANVAS_W,
      y: ((e.clientY - rect.top) / rect.height) * CANVAS_H,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = getCtx();
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pushHistory();
    isDrawingRef.current = true;
    const pt = pointFromEvent(e);
    lastPointRef.current = pt;
    drawSegment(ctx, pt, pt, { type: brush, color, size, opacity });
    setStrokeCount((c) => c + 1);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const ctx = getCtx();
    const from = lastPointRef.current;
    if (!ctx || !from) return;
    const to = pointFromEvent(e);
    drawSegment(ctx, from, to, { type: brush, color, size, opacity });
    lastPointRef.current = to;
  };

  const handlePointerUp = () => {
    isDrawingRef.current = false;
    lastPointRef.current = null;
  };

  const undo = () => {
    const ctx = getCtx();
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    const prev = historyRef.current.pop();
    if (!prev) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setStrokeCount(0);
      setHasInitial(false);
      return;
    }
    ctx.putImageData(prev, 0, 0);
    setStrokeCount((c) => Math.max(0, c - 1));
  };

  const clear = () => {
    const ctx = getCtx();
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    if (strokeCount > 0 || hasInitial) pushHistory();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setStrokeCount(0);
    setHasInitial(false);
  };

  const hasContent = strokeCount > 0 || hasInitial;

  const insert = () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasContent) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      onInsert(new File([blob], 'drawing.png', { type: 'image/png' }));
    }, 'image/png');
  };

  return (
    <div className="fixed inset-0 z-[250] flex flex-col bg-neutral-950/97 text-white">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-black/40 px-3 py-2.5">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20"
        >
          <X className="w-3.5 h-3.5" />
          {t('cancel')}
        </button>
        <span className="ml-1 text-xs font-semibold text-white/60">{t('draw')}</span>
        <div className="ml-auto flex items-center gap-2">
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="inline-flex items-center gap-1.5 rounded-full bg-red-950/60 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-900/60"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {t('removeDrawing')}
            </button>
          )}
          <button
            type="button"
            onClick={undo}
            disabled={!hasContent}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20 disabled:opacity-40"
          >
            <Undo2 className="w-3.5 h-3.5" />
            {t('undo')}
          </button>
          <button
            type="button"
            onClick={clear}
            disabled={!hasContent}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20 disabled:opacity-40"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t('clear')}
          </button>
          <button
            type="button"
            onClick={insert}
            disabled={!hasContent}
            className="inline-flex items-center gap-1.5 rounded-full bg-pink-600 px-3 py-1.5 text-xs font-medium hover:bg-pink-500 disabled:opacity-40"
          >
            <Check className="w-3.5 h-3.5" />
            {t('insert')}
          </button>
        </div>
      </div>

      <div className="flex min-h-[38dvh] flex-1 items-center justify-center overflow-auto p-4">
        <div
          className="relative w-full shrink-0 touch-none overflow-hidden rounded-xl shadow-2xl"
          style={{
            aspectRatio: `${CANVAS_W} / ${CANVAS_H}`,
            maxWidth: 'min(90vw, 460px)',
            maxHeight: '100%',
          }}
        >
          {background && <div className="pointer-events-none absolute inset-0">{background}</div>}
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            className="absolute inset-0 h-full w-full touch-none"
          />
        </div>
      </div>

      <div className="flex max-h-[46dvh] shrink-0 flex-col gap-3 overflow-y-auto border-t border-white/10 bg-black/40 px-3 py-3">
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
          {BRUSHES.map(({ id, icon: Icon, labelKey }) => (
            <button
              key={id}
              type="button"
              onClick={() => setBrush(id)}
              title={t(labelKey)}
              className={`flex flex-col items-center gap-1 rounded-xl border py-2 text-[10px] font-medium transition-colors ${
                brush === id
                  ? 'border-pink-500 bg-pink-600/20 text-pink-300'
                  : 'border-white/10 bg-white/[0.04] text-white/50 hover:bg-white/10 hover:text-white/80'
              }`}
            >
              <Icon className="w-4 h-4" />
              {t(labelKey)}
            </button>
          ))}
        </div>

        {brush !== 'eraser' && (
          <div className="flex items-center gap-1.5">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`h-6 w-6 rounded-full border-2 ${color === c ? 'border-pink-500' : 'border-white/25'}`}
                style={{ backgroundColor: c }}
                aria-label={c}
              />
            ))}
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-6 w-6 cursor-pointer rounded-full border-2 border-white/25 bg-transparent p-0"
            />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5 text-xs text-white/60">
            {t('brushSize')}
            <input
              type="range"
              min={2}
              max={60}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              className="w-24"
            />
          </label>
          {brush !== 'eraser' && (
            <label className="flex items-center gap-1.5 text-xs text-white/60">
              {t('opacity')}
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={opacity}
                onChange={(e) => setOpacity(Number(e.target.value))}
                className="w-24"
              />
            </label>
          )}
        </div>
      </div>
    </div>
  );
}
