import { useEffect, useRef, useState } from 'react';
import { Check, Eraser, Trash2, Undo2, X } from 'lucide-react';
import { useLang } from '../lib/i18n';

const COLORS = [
  '#ffffff', '#171717', '#f87171', '#fb923c',
  '#fbbf24', '#34d399', '#60a5fa', '#a78bfa',
];

const CANVAS_W = 900;
const CANVAS_H = 900;

interface Point { x: number; y: number; }
interface Stroke { points: Point[]; color: string; size: number; erase: boolean; }

/**
 * Freehand drawing tool for a box side. Draws on a transparent canvas so the
 * result reads as a sticker, then hands back a PNG File through the same
 * pipeline as an uploaded photo (handleImageFile) — no new element type.
 */
export default function DrawingModal({
  onCancel,
  onInsert,
}: {
  onCancel: () => void;
  onInsert: (file: File) => void;
}) {
  const { t } = useLang();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const drawingRef = useRef<Stroke | null>(null);
  const [color, setColor] = useState('#171717');
  const [size, setSize] = useState(8);
  const [erasing, setErasing] = useState(false);

  const redraw = (list: Stroke[]) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of list) {
      if (stroke.points.length === 0) continue;
      ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const [first, ...rest] = stroke.points;
      ctx.moveTo(first.x, first.y);
      if (rest.length === 0) ctx.lineTo(first.x + 0.01, first.y + 0.01);
      for (const p of rest) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  };

  useEffect(() => { redraw(strokes); }, [strokes]);

  const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * CANVAS_W,
      y: ((e.clientY - rect.top) / rect.height) * CANVAS_H,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const stroke: Stroke = {
      points: [pointFromEvent(e)],
      color,
      size: erasing ? size * 3 : size,
      erase: erasing,
    };
    drawingRef.current = stroke;
    setStrokes(prev => [...prev, stroke]);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = drawingRef.current;
    if (!stroke) return;
    stroke.points.push(pointFromEvent(e));
    redraw([...strokes.slice(0, -1), stroke]);
  };

  const handlePointerUp = () => { drawingRef.current = null; };

  const undo = () => setStrokes(prev => prev.slice(0, -1));
  const clear = () => setStrokes([]);

  const insert = () => {
    const canvas = canvasRef.current;
    if (!canvas || strokes.length === 0) return;
    canvas.toBlob(blob => {
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
          <button
            type="button"
            onClick={undo}
            disabled={strokes.length === 0}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20 disabled:opacity-40"
          >
            <Undo2 className="w-3.5 h-3.5" />
            {t('undo')}
          </button>
          <button
            type="button"
            onClick={clear}
            disabled={strokes.length === 0}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20 disabled:opacity-40"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t('clear')}
          </button>
          <button
            type="button"
            onClick={insert}
            disabled={strokes.length === 0}
            className="inline-flex items-center gap-1.5 rounded-full bg-pink-600 px-3 py-1.5 text-xs font-medium hover:bg-pink-500 disabled:opacity-40"
          >
            <Check className="w-3.5 h-3.5" />
            {t('insert')}
          </button>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-auto p-4">
        <div
          className="relative w-full shrink-0 touch-none rounded-xl shadow-2xl"
          style={{
            aspectRatio: `${CANVAS_W} / ${CANVAS_H}`,
            maxWidth: 'min(90vw, 460px)',
            maxHeight: '100%',
            backgroundImage:
              'linear-gradient(45deg, #262626 25%, transparent 25%), linear-gradient(-45deg, #262626 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #262626 75%), linear-gradient(-45deg, transparent 75%, #262626 75%)',
            backgroundSize: '20px 20px',
            backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
            backgroundColor: '#171717',
          }}
        >
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            className="h-full w-full touch-none"
          />
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-white/10 bg-black/40 px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          {COLORS.map(c => (
            <button
              key={c}
              type="button"
              onClick={() => { setColor(c); setErasing(false); }}
              className={`h-6 w-6 rounded-full border-2 ${!erasing && color === c ? 'border-pink-500' : 'border-white/25'}`}
              style={{ backgroundColor: c }}
              aria-label={c}
            />
          ))}
          <input
            type="color"
            value={color}
            onChange={e => { setColor(e.target.value); setErasing(false); }}
            className="h-6 w-6 cursor-pointer rounded-full border-2 border-white/25 bg-transparent p-0"
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-white/60">
          {t('brushSize')}
          <input
            type="range"
            min={2}
            max={40}
            value={size}
            onChange={e => setSize(Number(e.target.value))}
            className="w-24"
          />
        </label>
        <button
          type="button"
          onClick={() => setErasing(v => !v)}
          className={`ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ${erasing ? 'bg-pink-600' : 'bg-white/10 hover:bg-white/20'}`}
        >
          <Eraser className="w-3.5 h-3.5" />
          {t('eraser')}
        </button>
      </div>
    </div>
  );
}
