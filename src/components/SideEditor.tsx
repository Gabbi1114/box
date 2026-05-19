import React, { useState, useRef } from 'react';
import { BoxSide, GraphicElement, BoxConfig } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { Type, Image as ImageIcon, Sparkles, Trash2, RotateCw, ZoomIn, Check, Film, Search, X, Video, Upload, Link, Loader } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { uploadMedia } from '../lib/shareSystem';

interface SideEditorProps {
  side: BoxSide;
  config: BoxConfig;
  onUpdate: (elements: GraphicElement[]) => void;
  onClose: () => void;
  /** When set, images are uploaded to the share server and converted to AVIF */
  shareId?: string;
}

const TEXT_COLORS = ['#ffffff', '#000000', '#f87171', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa'];

const STICKER_EMOJI: Record<string, string> = {
  heart: '❤️', star: '⭐', sparkle: '✨', face: '😊',
};

const TENOR_KEY = (import.meta as any).env?.VITE_TENOR_API_KEY ?? 'LIVDSRZULELA';

interface GifResult {
  id: string;
  preview: string;
  url: string; // mp4 preferred, gif fallback
}

export default function SideEditor({ side, config, onUpdate, onClose, shareId }: SideEditorProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [canvasSize, setCanvasSize] = useState(0);
  const [uploading, setUploading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // GIF search state
  const [showGifSearch, setShowGifSearch] = useState(false);
  const [gifQuery, setGifQuery] = useState('');
  const [gifResults, setGifResults] = useState<GifResult[]>([]);
  const [gifLoading, setGifLoading] = useState(false);

  // Video state
  const [showVideoInput, setShowVideoInput] = useState(false);
  const [videoUrl, setVideoUrl] = useState('');
  const videoFileRef = useRef<HTMLInputElement>(null);
  // Photo file input (for local image uploads → AVIF via server)
  const photoFileRef = useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      setCanvasSize(entries[0].contentRect.width);
    });
    ro.observe(containerRef.current);
    setCanvasSize(containerRef.current.offsetWidth);
    return () => ro.disconnect();
  }, []);

  const addElement = (type: GraphicElement['type']) => {
    const el: GraphicElement = {
      id: uuidv4(),
      type,
      content: type === 'text' ? 'New Text' : type === 'image'
        ? 'https://images.unsplash.com/photo-1518173946687-a4c8a9b749f5?w=500&auto=format&fit=crop&q=60'
        : 'heart',
      x: 50, y: 50, scale: 1, rotation: 0, color: '#ffffff', fontSize: 24,
    };
    onUpdate([...side.elements, el]);
    setSelectedId(el.id);
  };

  const updateElement = (id: string, updates: Partial<GraphicElement>) =>
    onUpdate(side.elements.map(el => el.id === id ? { ...el, ...updates } : el));

  const removeElement = (id: string) => {
    const el = side.elements.find(e => e.id === id);
    if (el?.content?.startsWith('blob:')) URL.revokeObjectURL(el.content);
    onUpdate(side.elements.filter(el => el.id !== id));
    setSelectedId(null);
  };

  const searchGifs = async (q: string) => {
    if (!q.trim()) return;
    setGifLoading(true);
    try {
      const res = await fetch(
        `https://api.tenor.com/v1/search?q=${encodeURIComponent(q)}&key=${TENOR_KEY}&limit=12&media_filter=basic&contentfilter=medium`
      );
      const data = await res.json();
      setGifResults((data.results ?? []).map((g: any) => ({
        id: g.id,
        preview: g.media[0]?.tinygif?.url ?? g.media[0]?.gif?.url,
        // prefer mp4 — animates reliably on canvas; fall back to gif
        url: g.media[0]?.mp4?.url ?? g.media[0]?.gif?.url,
      })).filter((g: GifResult) => g.url));
    } catch {
      setGifResults([]);
    }
    setGifLoading(false);
  };

  const addGif = (url: string) => {
    const el: GraphicElement = {
      id: uuidv4(),
      type: 'image',
      content: url,
      x: 50, y: 50, scale: 0.6, rotation: 0, color: '#ffffff', fontSize: 24,
    };
    onUpdate([...side.elements, el]);
    setSelectedId(el.id);
    setShowGifSearch(false);
    setGifResults([]);
    setGifQuery('');
  };

  const addVideo = (url: string) => {
    if (!url.trim()) return;
    const el: GraphicElement = {
      id: uuidv4(),
      type: 'image',
      content: url.trim(),
      x: 50, y: 50, scale: 0.8, rotation: 0, color: '#ffffff', fontSize: 24,
    };
    onUpdate([...side.elements, el]);
    setSelectedId(el.id);
    setShowVideoInput(false);
    setVideoUrl('');
  };

  const handleVideoFile = async (file: File) => {
    // Videos go straight as blob URLs (server transcoding not yet implemented)
    const url = URL.createObjectURL(file);
    addVideo(url);
  };

  /**
   * Upload an image file. If a shareId is active the file is sent to the share
   * server for AVIF conversion; otherwise a local blob URL is used as fallback.
   */
  const handleImageFile = async (file: File) => {
    if (shareId) {
      setUploading(true);
      const serverUrl = await uploadMedia(shareId, file);
      setUploading(false);
      if (serverUrl) {
        const el: GraphicElement = {
          id: uuidv4(), type: 'image', content: serverUrl,
          x: 50, y: 50, scale: 0.8, rotation: 0, color: '#ffffff', fontSize: 24,
        };
        onUpdate([...side.elements, el]);
        setSelectedId(el.id);
        return;
      }
    }
    // Fallback: blob URL (works locally, won't survive a share reload)
    const url = URL.createObjectURL(file);
    const el: GraphicElement = {
      id: uuidv4(), type: 'image', content: url,
      x: 50, y: 50, scale: 0.8, rotation: 0, color: '#ffffff', fontSize: 24,
    };
    onUpdate([...side.elements, el]);
    setSelectedId(el.id);
  };

  const isVideoContent = (url: string) => /\.(mp4|webm|ogg)(\?|$)/i.test(url) || url.startsWith('blob:');

  const selected = side.elements.find(el => el.id === selectedId);

  // For base sides (index === -1) clip the canvas to the polygon shape
  const isBaseSide = side.index === -1;
  const polygonClipPath = React.useMemo(() => {
    if (!isBaseSide) return undefined;
    const n = config.numSides;
    // Rotate so flat side faces up (same visual orientation as looking down at the 3D base)
    const pts = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2 + Math.PI / n;
      return `${(50 + 50 * Math.cos(a)).toFixed(2)}% ${(50 + 50 * Math.sin(a)).toFixed(2)}%`;
    }).join(', ');
    return `polygon(${pts})`;
  }, [isBaseSide, config.numSides]);

  return (
    <div className="w-full h-full relative flex items-center justify-center overflow-hidden bg-neutral-950">

      {/* Floating top toolbar */}
      <div className="absolute top-5 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1 bg-black/80 backdrop-blur-xl rounded-full px-3 py-2 border border-white/[0.07]">
        <button
          onClick={() => addElement('text')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-neutral-400 hover:text-white hover:bg-white/10 transition-all"
        >
          <Type className="w-3.5 h-3.5" /> Text
        </button>
        <div className="w-px h-4 bg-white/10" />
        <button
          onClick={() => photoFileRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-neutral-400 hover:text-white hover:bg-white/10 transition-all disabled:opacity-50"
        >
          {uploading
            ? <Loader className="w-3.5 h-3.5 animate-spin" />
            : <ImageIcon className="w-3.5 h-3.5" />}
          {uploading ? 'Converting…' : 'Photo'}
        </button>
        <input
          ref={photoFileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleImageFile(f); e.target.value = ''; }}
        />
        <div className="w-px h-4 bg-white/10" />
        <button
          onClick={() => { setShowGifSearch(true); setGifResults([]); setGifQuery(''); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-neutral-400 hover:text-white hover:bg-white/10 transition-all"
        >
          <Film className="w-3.5 h-3.5" /> GIF
        </button>
        <div className="w-px h-4 bg-white/10" />
        <button
          onClick={() => { setShowVideoInput(true); setVideoUrl(''); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-neutral-400 hover:text-white hover:bg-white/10 transition-all"
        >
          <Video className="w-3.5 h-3.5" /> Video
        </button>
        <div className="w-px h-4 bg-white/10" />
        <button
          onClick={() => addElement('sticker')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-neutral-400 hover:text-white hover:bg-white/10 transition-all"
        >
          <Sparkles className="w-3.5 h-3.5" /> Sticker
        </button>
        <div className="w-px h-4 bg-white/10 mx-1" />
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-white text-black text-xs font-bold rounded-full hover:scale-105 active:scale-95 transition-all"
        >
          <Check className="w-3.5 h-3.5" /> Done
        </button>
      </div>

      {/* GIF Search Overlay */}
      <AnimatePresence>
        {showGifSearch && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-4 z-[60] bg-black/95 backdrop-blur-2xl rounded-2xl border border-white/10 flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* GIF search header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.07]">
              <div className="flex-1 flex items-center gap-2 bg-white/10 rounded-full px-3 py-2">
                <Search className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
                <input
                  autoFocus
                  value={gifQuery}
                  onChange={e => setGifQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && searchGifs(gifQuery)}
                  placeholder="Search GIFs..."
                  className="flex-1 bg-transparent text-sm text-white placeholder-neutral-600 focus:outline-none"
                />
              </div>
              <button
                onClick={() => searchGifs(gifQuery)}
                className="px-4 py-2 bg-pink-600 text-white text-xs font-bold rounded-full hover:bg-pink-500 transition-colors"
              >
                Search
              </button>
              <button
                onClick={() => setShowGifSearch(false)}
                className="p-2 text-neutral-600 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* GIF results grid */}
            <div className="flex-1 overflow-y-auto p-3">
              {gifLoading && (
                <div className="flex items-center justify-center h-32 text-neutral-600 text-sm">Searching...</div>
              )}
              {!gifLoading && gifResults.length === 0 && (
                <div className="flex items-center justify-center h-32 text-neutral-700 text-sm">
                  Search for GIFs above
                </div>
              )}
              {!gifLoading && gifResults.length > 0 && (
                <div className="grid grid-cols-3 gap-2">
                  {gifResults.map(gif => (
                    <button
                      key={gif.id}
                      onClick={() => addGif(gif.url)}
                      className="aspect-square overflow-hidden rounded-lg hover:ring-2 hover:ring-pink-500 transition-all"
                    >
                      <img
                        src={gif.preview}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                        decoding="async"
                        width={120}
                        height={120}
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Video Input Overlay */}
      <AnimatePresence>
        {showVideoInput && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-4 z-[60] bg-black/95 backdrop-blur-2xl rounded-2xl border border-white/10 flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.07]">
              <div className="flex items-center gap-2">
                <Video className="w-4 h-4 text-pink-400" />
                <span className="text-sm font-semibold text-white">Add Video</span>
              </div>
              <button onClick={() => setShowVideoInput(false)} className="p-1.5 text-neutral-600 hover:text-white transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 flex flex-col gap-5 p-5 justify-center">
              {/* File upload */}
              <button
                onClick={() => videoFileRef.current?.click()}
                className="flex flex-col items-center gap-3 p-6 rounded-xl border-2 border-dashed border-white/10 hover:border-pink-500/50 hover:bg-pink-500/5 transition-all group"
              >
                <Upload className="w-8 h-8 text-neutral-600 group-hover:text-pink-400 transition-colors" />
                <div className="text-center">
                  <p className="text-sm text-white font-medium">Upload from device</p>
                  <p className="text-xs text-neutral-600 mt-1">MP4, WebM, MOV supported</p>
                </div>
              </button>
              <input
                ref={videoFileRef}
                type="file"
                accept="video/mp4,video/webm,video/ogg,video/quicktime"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleVideoFile(f); }}
              />

              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-white/10" />
                <span className="text-xs text-neutral-600">or paste URL</span>
                <div className="flex-1 h-px bg-white/10" />
              </div>

              {/* URL input */}
              <div className="flex gap-2">
                <div className="flex-1 flex items-center gap-2 bg-white/10 rounded-xl px-3 py-2.5">
                  <Link className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
                  <input
                    autoFocus
                    value={videoUrl}
                    onChange={e => setVideoUrl(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addVideo(videoUrl)}
                    placeholder="https://example.com/video.mp4"
                    className="flex-1 bg-transparent text-sm text-white placeholder-neutral-600 focus:outline-none"
                  />
                </div>
                <button
                  onClick={() => addVideo(videoUrl)}
                  disabled={!videoUrl.trim()}
                  className="px-4 py-2.5 bg-pink-600 text-white text-xs font-bold rounded-xl hover:bg-pink-500 disabled:opacity-30 disabled:pointer-events-none transition-colors"
                >
                  Add
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Canvas — always full size; SVG overlay marks the actual layer boundary */}
      <div
        ref={containerRef}
        className="relative overflow-hidden shadow-2xl"
        style={{
          backgroundColor: config.innerColor,
          width: 'min(55vh, 55vw)',
          aspectRatio: '1 / 1',
          clipPath: polygonClipPath,
          boxShadow: polygonClipPath
            ? '0 0 0 1.5px rgba(255,255,255,0.12), 0 25px 50px rgba(0,0,0,0.8)'
            : '0 0 0 1px rgba(255,255,255,0.08), 0 25px 50px rgba(0,0,0,0.8)',
        }}
        onClick={() => setSelectedId(null)}
      >
        {side.elements.map((el) => (
          <div
            key={el.id}
            className={`absolute cursor-move select-none touch-none ${selectedId === el.id ? 'z-50' : 'z-10'}`}
            style={{
              left: `${el.x}%`,
              top: `${el.y}%`,
              transform: `translate(-50%, -50%) rotate(${el.rotation}deg) scale(${el.scale})`,
            }}
            onClick={(e) => { e.stopPropagation(); setSelectedId(el.id); }}
            onPointerDown={(e) => {
              if (isResizing) return;
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              if (!containerRef.current) return;

              const rect = containerRef.current.getBoundingClientRect();
              const offsetX = e.clientX - rect.left - (el.x / 100) * rect.width;
              const offsetY = e.clientY - rect.top - (el.y / 100) * rect.height;

              const snap = (v: number) => {
                if (Math.abs(v - 50) < 2.5) return 50;
                const g = Math.round(v / 10) * 10;
                return Math.abs(v - g) < 2.5 ? g : v;
              };

              const onMove = (me: PointerEvent) => {
                if (!containerRef.current) return;
                const r = containerRef.current.getBoundingClientRect();
                const nx = ((me.clientX - r.left - offsetX) / r.width) * 100;
                const ny = ((me.clientY - r.top - offsetY) / r.height) * 100;
                updateElement(el.id, {
                  x: snap(Math.max(0, Math.min(100, nx))),
                  y: snap(Math.max(0, Math.min(100, ny))),
                });
              };

              const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
              };

              document.addEventListener('pointermove', onMove);
              document.addEventListener('pointerup', onUp);
            }}
          >
            {el.type === 'text' && (
              <div
                style={{
                  color: el.color,
                  fontSize: `${el.fontSize}px`,
                  fontWeight: 'bold',
                  border: selectedId === el.id ? '2px solid #3b82f6' : '2px solid transparent',
                  padding: '4px 8px',
                  borderRadius: '4px',
                }}
                className="whitespace-nowrap transition-colors"
              >
                {el.content}
              </div>
            )}
            {el.type === 'image' && (
              <div className={`transition-all ${selectedId === el.id ? 'ring-2 ring-blue-500' : ''}`}>
                {isVideoContent(el.content) ? (
                  <video
                    src={el.content}
                    autoPlay
                    loop
                    muted
                    playsInline
                    draggable={false}
                    className="block"
                    style={{ width: 'auto', height: 'auto', maxWidth: canvasSize || 500, maxHeight: canvasSize || 500 }}
                  />
                ) : (
                  <img
                    src={el.content}
                    draggable={false}
                    className="block"
                    style={{ width: 'auto', height: 'auto', maxWidth: canvasSize || 500, maxHeight: canvasSize || 500 }}
                  />
                )}
              </div>
            )}
            {el.type === 'sticker' && (
              <div className={`transition-all rounded-full p-1 ${selectedId === el.id ? 'ring-2 ring-blue-500 bg-blue-500/10' : ''}`}>
                <span style={{ fontSize: '72px', lineHeight: 1, display: 'block' }}>
                  {STICKER_EMOJI[el.content] ?? '❤️'}
                </span>
              </div>
            )}

            {/* Resize handle */}
            {selectedId === el.id && (
              <div
                className="absolute -right-5 -bottom-5 w-10 h-10 flex items-center justify-center cursor-nwse-resize z-[100]"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  if (!containerRef.current) return;
                  setIsResizing(true);

                  const rect = containerRef.current.getBoundingClientRect();
                  const cx = rect.left + (el.x / 100) * rect.width;
                  const cy = rect.top + (el.y / 100) * rect.height;
                  const initDist = Math.hypot(e.clientX - cx, e.clientY - cy);
                  const initScale = el.scale;

                  const onMove = (mv: PointerEvent) => {
                    mv.preventDefault();
                    const d = Math.hypot(mv.clientX - cx, mv.clientY - cy);
                    if (initDist > 0) {
                      updateElement(el.id, { scale: Math.max(0.1, initScale * (d / initDist)) });
                    }
                  };

                  const onUp = () => {
                    setIsResizing(false);
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                  };

                  document.addEventListener('pointermove', onMove);
                  document.addEventListener('pointerup', onUp);
                }}
              >
                <div className="w-4 h-4 bg-blue-500 border-2 border-white rounded-full" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Floating context bar */}
      <AnimatePresence>
        {selected && (
          <motion.div
            key={selected.id}
            initial={{ y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-5 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-black/80 backdrop-blur-xl rounded-2xl px-5 py-3 border border-white/[0.07] flex-wrap justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            {selected.type === 'text' && (
              <input
                value={selected.content}
                onChange={(e) => updateElement(selected.id, { content: e.target.value })}
                className="bg-white/10 rounded-lg px-3 py-1.5 text-sm font-bold focus:outline-none focus:ring-1 focus:ring-pink-500 w-36 text-white"
              />
            )}
            {selected.type === 'image' && (
              <input
                value={selected.content}
                onChange={(e) => updateElement(selected.id, { content: e.target.value })}
                placeholder="Image / GIF URL"
                className="bg-white/10 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-pink-500 w-44 text-white placeholder-neutral-600"
              />
            )}
            {selected.type === 'sticker' && (
              <div className="flex gap-1">
                {Object.keys(STICKER_EMOJI).map(s => (
                  <button
                    key={s}
                    onClick={() => updateElement(selected.id, { content: s })}
                    className={`px-2.5 py-1 text-lg rounded-lg transition-all ${selected.content === s ? 'bg-pink-600' : 'bg-white/10 hover:bg-white/20'}`}
                  >
                    {STICKER_EMOJI[s]}
                  </button>
                ))}
              </div>
            )}

            <div className="w-px h-5 bg-white/10" />

            <div className="flex items-center gap-2">
              <ZoomIn className="w-3.5 h-3.5 text-neutral-600" />
              <input
                type="range" min="0.05" max="3" step="0.01"
                value={selected.scale}
                onChange={(e) => updateElement(selected.id, { scale: parseFloat(e.target.value) })}
                className="w-20 accent-pink-500 h-px bg-neutral-800 rounded appearance-none cursor-pointer"
              />
            </div>

            <div className="flex items-center gap-2">
              <RotateCw className="w-3.5 h-3.5 text-neutral-600" />
              <input
                type="range" min="0" max="360"
                value={selected.rotation}
                onChange={(e) => updateElement(selected.id, { rotation: parseInt(e.target.value) })}
                className="w-20 accent-pink-500 h-px bg-neutral-800 rounded appearance-none cursor-pointer"
              />
            </div>

            {selected.type === 'text' && (
              <>
                <div className="w-px h-5 bg-white/10" />
                <div className="flex items-center gap-2">
                  <Type className="w-3.5 h-3.5 text-neutral-600" />
                  <input
                    type="range" min="12" max="120"
                    value={selected.fontSize}
                    onChange={(e) => updateElement(selected.id, { fontSize: parseInt(e.target.value) })}
                    className="w-16 accent-pink-500 h-px bg-neutral-800 rounded appearance-none cursor-pointer"
                  />
                </div>
                <div className="flex gap-1.5">
                  {TEXT_COLORS.map(c => (
                    <button
                      key={c}
                      onClick={() => updateElement(selected.id, { color: c })}
                      className={`w-4.5 h-4.5 rounded-full border border-white/20 transition-all hover:scale-125 ${selected.color === c ? 'ring-2 ring-pink-500 scale-110' : ''}`}
                      style={{ backgroundColor: c, width: '18px', height: '18px' }}
                    />
                  ))}
                </div>
              </>
            )}

            <div className="w-px h-5 bg-white/10" />

            <button
              onClick={() => removeElement(selected.id)}
              className="text-neutral-600 hover:text-red-400 transition-colors p-1"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
