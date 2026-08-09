import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { useLang } from '../lib/i18n';

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';
type RatioId = 'free' | 'orig' | 'sq' | '16:9';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PREVIEW = 340;

/**
 * Rectangular crop tool, ported from book's PageEditor.jsx EditorCropModal —
 * same drag-box-and-handles interaction, but generic over any image URL
 * instead of a Fabric.js image object.
 */
export default function CropModal({
  imageSrc,
  onApply,
  onCancel,
}: {
  imageSrc: string;
  onApply: (file: File) => void;
  onCancel: () => void;
}) {
  const { t } = useLang();

  const imgElRef = useRef<HTMLImageElement | null>(null);
  const [natSize, setNatSize] = useState<{ w: number; h: number } | null>(null);
  const [ratioId, setRatioId] = useState<RatioId>('free');
  const [box, setBox] = useState<Box>({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  const [dragging, setDragging] = useState<Handle | null>(null);
  const originRef = useRef({ mx: 0, my: 0, bx: 0, by: 0, bw: 0, bh: 0 });

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imgElRef.current = img;
      setNatSize({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = imageSrc;
  }, [imageSrc]);

  const natW = natSize?.w || 800;
  const natH = natSize?.h || 800;
  const aspect = natW / natH;
  const pw = aspect >= 1 ? PREVIEW : Math.round(PREVIEW * aspect);
  const ph = aspect >= 1 ? Math.round(PREVIEW / aspect) : PREVIEW;

  const clampBox = (b: Box): Box => {
    const MIN = 0.05;
    let { x, y, w, h } = b;
    w = Math.max(MIN, Math.min(w, 1 - x));
    h = Math.max(MIN, Math.min(h, 1 - y));
    x = Math.max(0, Math.min(x, 1 - w));
    y = Math.max(0, Math.min(y, 1 - h));
    return { x, y, w, h };
  };

  const applyRatio = (rid: RatioId, b: Box): Box => {
    const ratioMap: Record<RatioId, number | null> = {
      free: null,
      orig: natW / natH,
      sq: 1,
      '16:9': 16 / 9,
    };
    const r = ratioMap[rid];
    if (!r) return b;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const curR = (b.w * pw) / (b.h * ph);
    let nw = b.w;
    let nh = b.h;
    if (curR > r) nw = (b.h * ph * r) / pw;
    else nh = (b.w * pw) / (r * ph);
    return clampBox({ x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh });
  };

  const onHandleDown = (e: { clientX: number; clientY: number }, handle: Handle) => {
    setDragging(handle);
    originRef.current = { mx: e.clientX, my: e.clientY, bx: box.x, by: box.y, bw: box.w, bh: box.h };
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (clientX: number, clientY: number) => {
      const { mx, my, bx, by, bw, bh } = originRef.current;
      const dx = (clientX - mx) / pw;
      const dy = (clientY - my) / ph;
      let nb: Box = { x: bx, y: by, w: bw, h: bh };
      if (dragging === 'move') {
        nb.x = bx + dx;
        nb.y = by + dy;
      }
      if (dragging.includes('e')) nb.w = bw + dx;
      if (dragging.includes('w')) {
        nb.x = bx + dx;
        nb.w = bw - dx;
      }
      if (dragging.includes('s')) nb.h = bh + dy;
      if (dragging.includes('n')) {
        nb.y = by + dy;
        nb.h = bh - dy;
      }
      nb = clampBox(nb);
      if (ratioId !== 'free') nb = applyRatio(ratioId, nb);
      setBox(nb);
    };
    const onMouseMove = (e: MouseEvent) => onMove(e.clientX, e.clientY);
    const onTouchMove = (e: TouchEvent) => {
      const tt = e.touches[0];
      if (tt) onMove(tt.clientX, tt.clientY);
    };
    const onUp = () => setDragging(null);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onTouchMove);
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onUp);
    };
  }, [dragging, ratioId, pw, ph]);

  const handleApply = () => {
    const el = imgElRef.current;
    if (!el) return;
    const srcX = box.x * natW;
    const srcY = box.y * natH;
    const srcW = box.w * natW;
    const srcH = box.h * natH;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(srcW);
    canvas.height = Math.round(srcH);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(el, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      blob => {
        if (!blob) return;
        onApply(new File([blob], 'cropped.jpg', { type: 'image/jpeg' }));
      },
      'image/jpeg',
      0.95,
    );
  };

  const bpx = box.x * pw;
  const bpy = box.y * ph;
  const bpw = box.w * pw;
  const bph = box.h * ph;

  const handles: { id: Handle; left: number; top: number; cursor: string }[] = [
    { id: 'nw', left: bpx - 5, top: bpy - 5, cursor: 'nwse-resize' },
    { id: 'ne', left: bpx + bpw - 5, top: bpy - 5, cursor: 'nesw-resize' },
    { id: 'sw', left: bpx - 5, top: bpy + bph - 5, cursor: 'nesw-resize' },
    { id: 'se', left: bpx + bpw - 5, top: bpy + bph - 5, cursor: 'nwse-resize' },
    { id: 'n', left: bpx + bpw / 2 - 5, top: bpy - 5, cursor: 'ns-resize' },
    { id: 's', left: bpx + bpw / 2 - 5, top: bpy + bph - 5, cursor: 'ns-resize' },
    { id: 'w', left: bpx - 5, top: bpy + bph / 2 - 5, cursor: 'ew-resize' },
    { id: 'e', left: bpx + bpw - 5, top: bpy + bph / 2 - 5, cursor: 'ew-resize' },
  ];

  const ratioOptions: { id: RatioId; label: string }[] = [
    { id: 'free', label: t('cropFree') },
    { id: 'orig', label: t('cropOriginal') },
    { id: 'sq', label: t('cropSquare') },
    { id: '16:9', label: '16:9' },
  ];

  return (
    <div className="fixed inset-0 z-[260] flex flex-col items-center justify-center gap-4 bg-neutral-950/95 p-4 text-white">
      <div className="flex w-full max-w-[420px] items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">{t('cropPhoto')}</h3>
          <p className="mt-0.5 text-xs text-white/40">{t('cropDragHint')}</p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg p-1.5 text-white/40 hover:bg-white/10 hover:text-white"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex flex-wrap justify-center gap-1.5">
        {ratioOptions.map(r => (
          <button
            key={r.id}
            type="button"
            onClick={() => {
              setRatioId(r.id);
              setBox(b => applyRatio(r.id, b));
            }}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              ratioId === r.id
                ? 'border-pink-500 bg-pink-600 text-white'
                : 'border-white/10 bg-white/5 text-white/50 hover:bg-white/10'
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div
        className="relative select-none overflow-hidden rounded-xl bg-black/60"
        style={{ width: pw, height: ph, touchAction: 'none' }}
      >
        <img
          src={imageSrc}
          alt=""
          draggable={false}
          style={{ width: pw, height: ph, display: 'block', pointerEvents: 'none' }}
        />
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute bg-black/55" style={{ left: 0, top: 0, width: pw, height: bpy }} />
          <div
            className="absolute bg-black/55"
            style={{ left: 0, top: bpy + bph, width: pw, height: ph - bpy - bph }}
          />
          <div className="absolute bg-black/55" style={{ left: 0, top: bpy, width: bpx, height: bph }} />
          <div
            className="absolute bg-black/55"
            style={{ left: bpx + bpw, top: bpy, width: pw - bpx - bpw, height: bph }}
          />
          <div className="absolute border-2 border-white/80" style={{ left: bpx, top: bpy, width: bpw, height: bph }}>
            <div className="absolute border-r border-white/20" style={{ left: '33%', top: 0, height: '100%' }} />
            <div className="absolute border-r border-white/20" style={{ left: '66%', top: 0, height: '100%' }} />
            <div className="absolute border-b border-white/20" style={{ top: '33%', left: 0, width: '100%' }} />
            <div className="absolute border-b border-white/20" style={{ top: '66%', left: 0, width: '100%' }} />
          </div>
        </div>
        <div
          className="absolute cursor-grab active:cursor-grabbing"
          style={{ left: bpx, top: bpy, width: bpw, height: bph }}
          onMouseDown={e => onHandleDown(e, 'move')}
          onTouchStart={e => e.touches[0] && onHandleDown(e.touches[0], 'move')}
        />
        {handles.map(h => (
          <div
            key={h.id}
            className="absolute z-10 h-[13px] w-[13px] rounded-sm border border-black/30 bg-white"
            style={{ left: h.left, top: h.top, cursor: h.cursor }}
            onMouseDown={e => onHandleDown(e, h.id)}
            onTouchStart={e => e.touches[0] && onHandleDown(e.touches[0], h.id)}
          />
        ))}
      </div>

      <p className="text-[10px] text-white/30">
        {Math.round(box.w * natW)} × {Math.round(box.h * natH)} px
      </p>

      <div className="flex w-full max-w-[420px] gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-xl border border-white/10 bg-white/[0.06] py-2.5 text-sm text-white/70 hover:bg-white/10 hover:text-white"
        >
          {t('cancel')}
        </button>
        <button
          type="button"
          onClick={handleApply}
          disabled={!natSize}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-pink-600 py-2.5 text-sm font-semibold text-white hover:bg-pink-500 disabled:opacity-40"
        >
          <Check className="w-4 h-4" />
          {t('applyCrop')}
        </button>
      </div>
    </div>
  );
}
