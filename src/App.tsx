/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { BoxConfig, BoxSide, AppMode, GraphicElement } from './types.ts';
import Box3D from './components/Box3D.tsx';
import BoxEditor from './components/BoxEditor.tsx';
import SideEditor from './components/SideEditor.tsx';
import { motion, AnimatePresence } from 'motion/react';
import {
  Layers, Settings, ChevronLeft, ChevronRight, Share2,
  Copy, Check, Loader, Eye, Pencil, X, Play, RotateCcw,
} from 'lucide-react';
import { createShare, updateShare, loadShare, finalizeShare, getShareId, buildShareUrl } from './lib/shareSystem.ts';
import { isDemoShareId, buildDemoContent, getDemoEditUntil } from './lib/demoShare.ts';
import { useLang, Lang } from './lib/i18n.ts';
import LoadingScreen from './components/LoadingScreen.tsx';

const EDITOR_PASSWORD = import.meta.env.VITE_STUDIO_PASSWORD as string | undefined;

function LangToggle() {
  const { lang, setLang } = useLang();
  const options: { key: Lang; label: string }[] = [
    { key: 'mn', label: 'MN' },
    { key: 'en', label: 'EN' },
  ];
  return (
    <div className="flex items-center gap-1 p-1 rounded-full safe-blur border border-white/10 bg-white/10">
      {options.map(o => (
        <button
          key={o.key}
          onClick={() => setLang(o.key)}
          className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
            lang === o.key ? 'bg-white text-black' : 'text-neutral-300 hover:text-white'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PasswordGate({ onUnlock }: { onUnlock: () => void }) {
  const [value, setValue] = useState('');
  const [shake, setShake]   = useState(false);
  const { t } = useLang();

  const submit = () => {
    if (value === EDITOR_PASSWORD) {
      onUnlock();
    } else {
      setShake(true);
      setValue('');
      setTimeout(() => setShake(false), 500);
    }
  };

  return (
    <div className="relative w-full h-screen bg-slate-900 flex items-center justify-center font-sans overflow-hidden">
      {/* Subtle radial glow, matching the reference lock screen */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ backgroundImage: 'radial-gradient(circle at 50% 40%, rgba(139,92,246,0.35), rgba(15,23,42,0) 60%)' }}
      />
      <div className="absolute top-6 left-6 z-10">
        <LangToggle />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative w-80 flex flex-col items-center gap-6"
      >
        <img src="/logo-56moments.png" alt="" className="w-24 h-24 rounded-full" />
        <p className="text-[13px] text-white/50 -mt-2">{t('passwordPrompt')}</p>
        <motion.div
          animate={shake ? { x: [-8, 8, -6, 6, -4, 4, 0] } : {}}
          transition={{ duration: 0.4 }}
          className="w-full"
        >
          <input
            type="password"
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder={t('passwordPlaceholder')}
            autoFocus
            className="w-full px-4 py-3 rounded-xl bg-white/[0.07] border border-white/15 text-white placeholder-neutral-500 text-sm outline-none focus:border-white/30 focus:bg-white/10 transition-all"
          />
        </motion.div>
        <button
          onClick={submit}
          className="w-full py-3 rounded-xl bg-white hover:bg-neutral-100 text-black text-sm font-bold transition-all active:scale-95"
        >
          {t('unlock')}
        </button>
      </motion.div>
    </div>
  );
}

const DEFAULT_CONFIG: BoxConfig = {
  numLayers: 3,
  numSides: 4,
  baseColor: '#0ABAB5',
  innerColor: '#ffffff',
  size: 3,
  openLevel: 0,
};

export default function App() {
  const { t } = useLang();
  const isShareLink = !!getShareId();
  const needsPassword = !!EDITOR_PASSWORD && !isShareLink;
  // No persistence by design — the password is required on every visit and
  // every reload, not just once per tab session.
  const [unlocked, setUnlocked] = useState(() => !needsPassword);

  // Loading screen — shown until 3D first frame fires AND min time passes
  const [sceneReady, setSceneReady]   = useState(false);
  const [minTimeDone, setMinTimeDone] = useState(false);
  const loadingDone = sceneReady && minTimeDone;

  useEffect(() => {
    const timer = setTimeout(() => setMinTimeDone(true), 1800);
    return () => clearTimeout(timer);
  }, []);

  const [config, setConfig] = useState<BoxConfig>(DEFAULT_CONFIG);
  const [sides, setSides] = useState<BoxSide[]>([]);
  const [activeMode, setActiveMode] = useState<AppMode>('BOX_EDIT');
  const [selectedSideId, setSelectedSideId] = useState<string | null>(null);
  const [showUI, setShowUI] = useState(true);
  // Explicit side picker — the alternative to tapping a face directly on the
  // rotating 3D box, which is easy to mistake for a rotate/drag gesture
  // instead of a selection (this is what made the editor hard to use).
  const [showSidePicker, setShowSidePicker] = useState(false);

  // Share state
  const [shareId, setShareId]         = useState<string | null>(null);
  const [shareUrl, setShareUrl]       = useState<string | null>(null);
  const [showShareToast, setShowShareToast] = useState(false);
  const [toastCopied, setToastCopied] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareError, setShareError]   = useState<string | null>(null);
  // A real ?share= id that failed to load (invalid, expired, or the create
  // call never actually reached the server) — blocks the editor entirely
  // instead of silently falling back to a blank, unsaved default box that
  // looks identical to a working one.
  const [shareLoadFailed, setShareLoadFailed] = useState(false);

  // View-only mode (set when loading from ?share= URL, or after clicking "Done Editing")
  const [isViewOnly, setIsViewOnly]   = useState(false);
  // Server-enforced permanent lock (POST /api/share/:id/finalize) — true for
  // every device that opens the link, not just the one that clicked "Finish".
  const [editingLocked, setEditingLocked] = useState(false);
  const [showFinishConfirm, setShowFinishConfirm] = useState(false);
  // Edit-window countdown — null until a loaded share reports its editUntil.
  const [editUntil, setEditUntil] = useState<string | null>(null);
  // Storage used/limit for this share — null until a loaded/created share reports it.
  const [mediaBytes, setMediaBytes] = useState<number | null>(null);
  const [bytesLimit, setBytesLimit] = useState<number | null>(null);

  const autoSaveTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLoadingShare = useRef(false);

  // ---------------------------------------------------------------------------
  // Initialize sides when config changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    setSides(prev => {
      const filtered = prev.filter(
        s => s.layer < config.numLayers && (s.index === -1 || s.index < config.numSides)
      );
      for (let l = 0; l < config.numLayers; l++) {
        for (let i = 0; i < config.numSides; i++) {
          if (!filtered.find(s => s.layer === l && s.index === i))
            filtered.push({ id: uuidv4(), layer: l, index: i, elements: [] });
        }
        if (!filtered.find(s => s.layer === l && s.index === -1))
          filtered.push({ id: uuidv4(), layer: l, index: -1, elements: [] });
      }
      return filtered;
    });
  }, [config.numLayers, config.numSides]);

  // ---------------------------------------------------------------------------
  // Load share from ?share=<id> on mount → straight to view-only
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const id = getShareId();
    if (!id) return;

    // Public demo sandbox — 100% client-built, never calls loadShare(). Every
    // visit starts fresh from pristine content; edits live only in this page's
    // React state and are gone on the next reload. Real share links below are
    // completely untouched.
    if (isDemoShareId(id)) {
      const content = buildDemoContent();
      setConfig({ ...content.config, openLevel: 0 });
      setSides(content.sides);
      setShareId(id);
      setShareUrl(buildShareUrl(id));
      setEditUntil(getDemoEditUntil());
      setEditingLocked(false);
      setIsViewOnly(false);
      return;
    }

    let cancelled = false;          // guards against StrictMode double-fire
    isLoadingShare.current = true;
    setShareLoading(true);

    loadShare(id).then(data => {
      if (cancelled) return;        // StrictMode unmounted this run — ignore
      isLoadingShare.current = false;
      setShareLoading(false);
      if (!data) { setShareLoadFailed(true); return; }
      setConfig({ ...data.config, openLevel: 0 }); // always start closed
      setSides(data.sides);
      setShareId(id);
      setShareUrl(buildShareUrl(id));
      setIsViewOnly(true);
      setEditUntil(data.editUntil);
      setMediaBytes(data.mediaBytes);
      setBytesLimit(data.bytesLimit);
      // Server-verified lock — true for every visitor once anyone finalizes,
      // not just the browser that clicked it. localStorage is a legacy/instant
      // fallback for a browser that finalized before this field existed.
      if (data.finalized || localStorage.getItem(`editingLocked_${id}`) === '1') {
        setEditingLocked(true);
      }
    });

    return () => {
      cancelled = true;
      isLoadingShare.current = false;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Edit-window countdown — self-adjusting tick: 1/min while >1h left,
  // 1/sec once under 1h (so the display is smooth when it matters, without
  // re-rendering every second for a window that might last days).
  // ---------------------------------------------------------------------------
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  useEffect(() => {
    if (!editUntil || editingLocked) return;
    let timeoutId: ReturnType<typeof setTimeout>;
    const tick = () => {
      setCountdownNow(Date.now());
      const remaining = new Date(editUntil).getTime() - Date.now();
      if (remaining <= 0) return; // window closed — stop ticking
      timeoutId = setTimeout(tick, remaining < 3600_000 ? 1000 : 60_000);
    };
    tick();
    return () => clearTimeout(timeoutId);
  }, [editUntil, editingLocked]);

  const countdown = useMemo(() => {
    if (!editUntil || editingLocked) return null;
    const remainingMs = new Date(editUntil).getTime() - countdownNow;
    if (remainingMs <= 0) return null;
    const totalSec = Math.floor(remainingMs / 1000);
    const urgent = remainingMs < 3600_000;
    let text: string;
    if (!urgent) {
      const days  = Math.floor(totalSec / 86400);
      const hours = Math.floor((totalSec % 86400) / 3600);
      const mins  = Math.floor((totalSec % 3600) / 60);
      text = `${days}d ${hours}h ${mins}m`;
    } else {
      const pad = (n: number) => String(n).padStart(2, '0');
      text = `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor((totalSec % 3600) / 60))}:${pad(totalSec % 60)}`;
    }
    return { text, urgent };
  }, [editUntil, editingLocked, countdownNow]);

  // Storage-left display — mirrors the countdown badge's shape so both can
  // sit side by side; hidden until a share has actually reported real numbers.
  const storageText = useMemo(() => {
    if (mediaBytes == null || bytesLimit == null || bytesLimit <= 0) return null;
    const leftMb = Math.max(0, bytesLimit - mediaBytes) / (1024 * 1024);
    return `${leftMb.toFixed(1)}MB left`;
  }, [mediaBytes, bytesLimit]);

  // ---------------------------------------------------------------------------
  // Auto-save: push updates 2 s after last change (edit mode only)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!shareId || isLoadingShare.current || isViewOnly) return;
    if (isDemoShareId(shareId)) return; // demo edits live only in React state — nothing to persist
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      updateShare(shareId, config, sides);
    }, 2000);
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [shareId, config, sides, isViewOnly]);

  // ---------------------------------------------------------------------------
  // Share button — creates share & shows a toast with the URL (no navigation)
  // ---------------------------------------------------------------------------
  const handleShare = useCallback(async () => {
    if (shareLoading) return;

    // Already have a share URL — just re-show the toast
    if (shareUrl) {
      setShowShareToast(true);
      setToastCopied(false);
      return;
    }

    setShareLoading(true);
    setShareError(null);
    const result = await createShare(config, sides);
    setShareLoading(false);

    if (!result.ok) {
      console.error('[share] create failed:', result.error);
      const hint = !import.meta.env.VITE_API_BASE
        ? 'VITE_API_BASE is not set — add it to Cloudflare env vars and redeploy.'
        : (result.error ?? '').toLowerCase().includes('fetch')
          ? 'Cannot reach server. Check that box-api is running on Render.'
          : result.error ?? 'Unknown error';
      setShareError(hint);
      setShowShareToast(true);
      return;
    }

    setShareError(null);
    setShareId(result.id);
    setShareUrl(result.url);
    setMediaBytes(0);
    setBytesLimit(result.bytesLimit);
    setShowShareToast(true);
    setToastCopied(false);
  }, [shareLoading, shareUrl, config, sides]);

  // Lazily creates a share the first time media needs to be uploaded.
  // Called from SideEditor when the user picks a photo but no share exists yet.
  const getOrCreateShareId = useCallback(async (): Promise<string | null> => {
    if (shareId && isDemoShareId(shareId)) return null; // demo uploads fall back to local blob: URLs
    if (shareId) return shareId;
    const result = await createShare(config, sides);
    if (!result.ok) return null;
    setShareId(result.id);
    setShareUrl(result.url);
    setMediaBytes(0);
    setBytesLimit(result.bytesLimit);
    return result.id;
  }, [shareId, config, sides]);

  const handleCopyToast = useCallback(async () => {
    if (!shareUrl) return;
    try { await navigator.clipboard.writeText(shareUrl); } catch { /* ignore */ }
    setToastCopied(true);
    setTimeout(() => setToastCopied(false), 2000);
  }, [shareUrl]);

  // ---------------------------------------------------------------------------
  // Side editing helpers
  // ---------------------------------------------------------------------------
  const selectedSide = useMemo(
    () => sides.find(s => s.id === selectedSideId),
    [sides, selectedSideId],
  );

  const handleSideClick = (sideId: string) => {
    if (config.openLevel === 0 || isViewOnly) return;
    setSelectedSideId(sideId);
    setActiveMode('SIDE_EDIT');
  };

  // Picker version of the same selection — the box only exposes sides to
  // click once it's open (see the guard above), which a picker shouldn't
  // require the user to know or do manually first.
  const selectSideFromPicker = (sideId: string) => {
    if (isViewOnly) return;
    setConfig(prev => (prev.openLevel === 0 ? { ...prev, openLevel: 1 } : prev));
    setSelectedSideId(sideId);
    setActiveMode('SIDE_EDIT');
    setShowSidePicker(false);
  };

  const updateSideElements = (sideId: string, elements: GraphicElement[]) =>
    setSides(prev => prev.map(s => s.id === sideId ? { ...s, elements } : s));

  const handleBackToBox = () => { setActiveMode('BOX_EDIT'); setSelectedSideId(null); };

  const handleToggleOpen = () =>
    setConfig(prev => ({
      ...prev,
      openLevel: prev.openLevel >= prev.numLayers + 1 ? 0 : prev.openLevel + 1,
    }));

  const handlePrevStep = () =>
    setConfig(prev => ({ ...prev, openLevel: Math.max(0, prev.openLevel - 1) }));

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="relative w-full h-screen bg-neutral-950 overflow-hidden font-sans text-white">

      {/* 3D Canvas — never apply filter:blur to a WebGL canvas, use opacity only */}
      <div className={`absolute inset-0 transition-all duration-1000 ${activeMode === 'SIDE_EDIT' ? 'opacity-10 pointer-events-none scale-110' : 'opacity-100'}`}>
        <Box3D
          config={config}
          sides={sides}
          onSideClick={handleSideClick}
          onReady={() => setSceneReady(true)}
          suspended={activeMode === 'SIDE_EDIT'}
        />
      </div>

      <LoadingScreen done={loadingDone} />

      {/* Password gate — appears after loading screen fades, covers the app */}
      <AnimatePresence>
        {loadingDone && !unlocked && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            className="absolute inset-0 z-[500]"
          >
            <PasswordGate onUnlock={() => setUnlocked(true)} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── EDIT MODE UI ── */}
      {!isViewOnly && unlocked && (
        <>
          {/* Bottom editor bar */}
          <div className={`absolute inset-x-0 bottom-0 p-2 sm:p-6 flex justify-center pointer-events-none transition-all duration-500 ${showUI ? 'translate-y-0 opacity-100' : 'translate-y-20 opacity-0'}`}>
            <AnimatePresence mode="wait">
              {activeMode === 'BOX_EDIT' ? (
                <motion.div key="box-editor" initial={{ y: 100, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 100, opacity: 0 }} className="pointer-events-auto w-full max-w-4xl">
                  <BoxEditor config={config} setConfig={setConfig} onToggleOpen={handleToggleOpen} onPrevStep={handlePrevStep} />
                </motion.div>
              ) : (
                <motion.div key="side-editor-back" initial={{ y: 100, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 100, opacity: 0 }} className="pointer-events-auto">
                  <button onClick={handleBackToBox} className="mb-4 px-6 py-3 bg-white/10 hover:bg-white/20 safe-blur border border-white/20 rounded-full flex items-center gap-2 transition-colors group">
                    <ChevronLeft className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
                    Return to View
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Top-left: language toggle, in the space freed up by removing the old title block */}
          <div className="absolute top-3 left-3 sm:top-6 sm:left-6 z-50">
            <LangToggle />
          </div>

          {/* Top-right controls — icon-only + tighter spacing below sm, wraps
              to a second line rather than overflowing if it still doesn't fit */}
          <div className="absolute top-3 right-3 sm:top-6 sm:right-6 z-50 flex flex-wrap items-center justify-end gap-1.5 sm:gap-2 max-w-[calc(100vw-1.5rem)]">

            {/* Edit a side — explicit picker instead of requiring a tap
                directly on the rotating 3D box, which is easy to trigger a
                rotate/drag gesture on by mistake instead of a selection. */}
            <motion.button
              onClick={() => setShowSidePicker(true)}
              whileTap={{ scale: 0.92 }}
              className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-2 rounded-full safe-blur border bg-pink-600/80 hover:bg-pink-600 border-pink-500/40 text-white text-xs sm:text-sm font-semibold transition-all"
            >
              <Layers className="w-4 h-4" />
              <span className="hidden sm:inline">{t('editSide')}</span>
            </motion.button>

            {/* Share button — only on the main studio, not on ?share= links */}
            {!isShareLink && (
              <motion.button
                onClick={handleShare}
                whileTap={{ scale: 0.92 }}
                className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-2 rounded-full safe-blur border bg-white/10 hover:bg-white/20 border-white/10 text-white text-xs sm:text-sm font-medium transition-all"
              >
                {shareLoading
                  ? <Loader className="w-4 h-4 animate-spin" />
                  : <Share2  className="w-4 h-4" />}
                <span className="hidden sm:inline">{shareLoading ? t('starting') : shareUrl ? t('copyLink') : t('share')}</span>
              </motion.button>
            )}

            {/* Done Editing — simple reversible view toggle */}
            <motion.button
              onClick={() => setIsViewOnly(true)}
              whileTap={{ scale: 0.92 }}
              className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-2 rounded-full safe-blur border bg-white/10 hover:bg-white/20 border-white/10 text-white text-xs sm:text-sm font-medium transition-all"
            >
              <Eye className="w-4 h-4" />
              <span className="hidden sm:inline">{t('preview')}</span>
            </motion.button>

            {/* Edit-window countdown — only meaningful once a share is loaded */}
            {countdown && (
              <span
                className={`px-2 sm:px-3 py-2 rounded-full text-[10px] sm:text-xs font-mono safe-blur border ${
                  countdown.urgent
                    ? 'bg-red-500/15 border-red-500/30 text-red-300'
                    : 'bg-white/10 border-white/10 text-neutral-300'
                }`}
                title="Time left to edit this box before it locks automatically"
              >
                {countdown.text}
              </span>
            )}

            {/* Storage used/left for this box's uploaded photos & videos */}
            {storageText && (
              <span
                className="px-2 sm:px-3 py-2 rounded-full text-[10px] sm:text-xs font-mono safe-blur border bg-white/10 border-white/10 text-neutral-300"
                title="Storage remaining for photos and videos on this box"
              >
                {storageText}
              </span>
            )}

            {/* End Editing — permanent lock, only on shared links */}
            {shareId && (
              <motion.button
                onClick={() => setShowFinishConfirm(true)}
                whileTap={{ scale: 0.92 }}
                className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-2 rounded-full safe-blur border bg-pink-600/80 hover:bg-pink-600 border-pink-500/40 text-white text-xs sm:text-sm font-semibold transition-all"
              >
                <Check className="w-4 h-4" />
                <span className="hidden sm:inline">{t('endEditing')}</span>
              </motion.button>
            )}

            {/* Show/Hide UI */}
            <button
              onClick={() => setShowUI(!showUI)}
              className="p-2 sm:p-2.5 bg-white/10 hover:bg-white/20 safe-blur rounded-full border border-white/10 transition-all active:scale-90"
              title={showUI ? t('hideEditor') : t('showEditor')}
            >
              {showUI ? <Settings className="w-4 h-4 sm:w-5 sm:h-5 text-neutral-400" /> : <Layers className="w-4 h-4 sm:w-5 sm:h-5 text-pink-500" />}
            </button>
          </div>
        </>
      )}

      {/* ── VIEW-ONLY UI ── */}
      {isViewOnly && unlocked && (
        <>
          {/* Top-left: language toggle */}
          <div className="absolute top-3 left-3 sm:top-6 sm:left-6 z-50">
            <LangToggle />
          </div>

          {/* Top-right: countdown, storage, share + edit — this is the toolbar
              a customer actually sees on first opening their link (share links
              land in view-only by default), so the countdown/storage badges
              belong here, not just in the edit-mode toolbar. */}
          <div className="absolute top-3 right-3 sm:top-6 sm:right-6 z-50 flex flex-wrap items-center justify-end gap-1.5 sm:gap-2 max-w-[calc(100vw-1.5rem)]">
            {countdown && (
              <span
                className={`px-2 sm:px-3 py-2 rounded-full text-[10px] sm:text-xs font-mono safe-blur border ${
                  countdown.urgent
                    ? 'bg-red-500/15 border-red-500/30 text-red-300'
                    : 'bg-white/10 border-white/10 text-neutral-300'
                }`}
                title="Time left to edit this box before it locks automatically"
              >
                {countdown.text}
              </span>
            )}
            {storageText && (
              <span
                className="px-2 sm:px-3 py-2 rounded-full text-[10px] sm:text-xs font-mono safe-blur border bg-white/10 border-white/10 text-neutral-300"
                title="Storage remaining for photos and videos on this box"
              >
                {storageText}
              </span>
            )}
            {shareUrl && !isShareLink && (
              <button
                onClick={() => { setShowShareToast(true); setToastCopied(false); }}
                className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-2 rounded-full safe-blur border bg-white/10 hover:bg-white/20 border-white/10 text-white text-xs sm:text-sm font-medium transition-all"
              >
                <Share2 className="w-4 h-4" />
                <span className="hidden sm:inline">{t('share')}</span>
              </button>
            )}
            {!editingLocked && (
              <button
                onClick={() => setIsViewOnly(false)}
                className="p-2 sm:p-2.5 bg-white/10 hover:bg-white/20 safe-blur rounded-full border border-white/10 transition-all active:scale-90"
                title={t('edit')}
              >
                <Pencil className="w-4 h-4 text-neutral-400" />
              </button>
            )}
          </div>

          {/* Bottom: box navigation only */}
          <div className="absolute inset-x-0 bottom-0 p-6 flex justify-center">
            <motion.div initial={{ y: 100, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.3 }}>
              <div className="flex items-center gap-2 bg-black/70 safe-blur rounded-full px-3 py-2 border border-white/[0.07]">
                {config.openLevel > 0 && (
                  <>
                    <button
                      onClick={() => setConfig(prev => ({ ...prev, openLevel: 0 }))}
                      className="p-1 text-neutral-600 hover:text-neutral-300 transition-colors"
                      title="Close box"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={handlePrevStep}
                      className="p-1 text-neutral-600 hover:text-neutral-300 transition-colors"
                      title="Previous step"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                  </>
                )}
                <button
                  onClick={handleToggleOpen}
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition-all active:scale-90 ${
                    config.openLevel > 0
                      ? 'bg-pink-600'
                      : 'bg-white hover:scale-105'
                  }`}
                >
                  {config.openLevel === 0
                    ? <Play className="w-3.5 h-3.5 fill-black text-black ml-0.5" />
                    : config.openLevel > config.numLayers
                      ? <Play className="w-3.5 h-3.5 fill-white text-white ml-0.5 opacity-40" />
                      : <ChevronRight className="w-4 h-4 text-white" />
                  }
                </button>
                <span className="text-[10px] font-mono text-neutral-600 uppercase pr-1">
                  {config.openLevel === 0 ? 'closed'
                    : config.openLevel === 1 ? 'lid off'
                    : config.openLevel > config.numLayers ? 'exploded'
                    : `layer ${config.openLevel - 1}`}
                </span>
              </div>
            </motion.div>
          </div>
        </>
      )}

      {/* ── FINISH CONFIRM MODAL ── */}
      <AnimatePresence>
        {showFinishConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[200] flex items-center justify-center bg-black/60 safe-blur"
            onClick={() => setShowFinishConfirm(false)}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 16 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.92, opacity: 0, y: 16 }}
              transition={{ duration: 0.2 }}
              className="w-80 bg-neutral-900/98 safe-blur border border-white/10 rounded-2xl p-6 shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <div className="w-12 h-12 bg-pink-500/15 rounded-2xl flex items-center justify-center mb-4 mx-auto">
                <Eye className="w-6 h-6 text-pink-400" />
              </div>
              <h2 className="text-base font-bold text-white text-center mb-1">{t('finishTitle')}</h2>
              <p className="text-xs text-neutral-400 text-center mb-5 leading-relaxed">
                {t('finishBody1')}<br />
                {t('finishBody2')}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowFinishConfirm(false)}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-white/8 hover:bg-white/12 text-neutral-300 transition-all border border-white/10"
                >
                  {t('cancel')}
                </button>
                <button
                  onClick={() => {
                    setShowFinishConfirm(false);
                    setEditingLocked(true);
                    setIsViewOnly(true);
                    if (shareId && !isDemoShareId(shareId)) {
                      localStorage.setItem(`editingLocked_${shareId}`, '1');
                      finalizeShare(shareId); // server-enforced — locks it for every visitor, not just this browser
                    }
                    // demo: locks this page view only — gone on next reload, never touches the server
                  }}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold bg-pink-600 hover:bg-pink-500 text-white transition-all"
                >
                  {t('yesFinish')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── SIDE PICKER — explicit alternative to tapping a face directly on
          the rotating 3D box; see the "Edit a side" button above ── */}
      <AnimatePresence>
        {showSidePicker && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[200] flex items-center justify-center bg-black/70 safe-blur px-4"
            onClick={() => setShowSidePicker(false)}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 16 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.92, opacity: 0, y: 16 }}
              transition={{ duration: 0.2 }}
              className="w-full max-w-sm max-h-[80vh] bg-neutral-900/98 safe-blur border border-white/10 rounded-2xl p-5 shadow-2xl overflow-y-auto"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-bold text-white">{t('pickSideTitle')}</h2>
                <button
                  onClick={() => setShowSidePicker(false)}
                  className="p-1.5 rounded-full hover:bg-white/10 text-neutral-400 hover:text-white transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="space-y-4">
                {Array.from({ length: config.numLayers }, (_, i) => i).map(layerIdx => {
                  const layerSides = sides
                    .filter(s => s.layer === layerIdx)
                    .sort((a, b) => a.index - b.index);
                  return (
                    <div key={layerIdx}>
                      {config.numLayers > 1 && (
                        <div className="text-[10px] font-mono uppercase tracking-wide text-neutral-500 mb-1.5">
                          {t('layer')} {layerIdx + 1}
                        </div>
                      )}
                      <div className="grid grid-cols-3 gap-2">
                        {layerSides.map(side => {
                          const hasContent = side.elements.length > 0;
                          const label = side.index === -1 ? t('base') : `${t('side')} ${side.index + 1}`;
                          return (
                            <button
                              key={side.id}
                              onClick={() => selectSideFromPicker(side.id)}
                              title={hasContent ? t('hasContent') : undefined}
                              className={`relative flex items-center justify-center gap-1 py-3 rounded-xl text-xs font-medium transition-all border ${
                                selectedSideId === side.id
                                  ? 'bg-pink-600 border-pink-500 text-white'
                                  : 'bg-white/5 border-white/10 text-neutral-300 hover:bg-white/10 hover:border-white/20'
                              }`}
                            >
                              {label}
                              {hasContent && (
                                <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-emerald-400" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── SHARE TOAST ── */}
      <AnimatePresence>
        {showShareToast && (
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.96 }}
            transition={{ duration: 0.18 }}
            className="absolute top-20 right-6 z-[100] w-80 bg-neutral-900/95 safe-blur border border-white/10 rounded-2xl p-4 shadow-2xl"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-white">
                {shareError ? 'Share failed' : 'Share link'}
              </span>
              <button onClick={() => { setShowShareToast(false); setShareError(null); }} className="p-1 text-neutral-500 hover:text-white transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            {shareError ? (
              /* Error state */
              <>
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2.5 mb-3">
                  <p className="text-xs text-red-300 leading-relaxed">{shareError}</p>
                </div>
                <button
                  onClick={() => { setShowShareToast(false); setShareError(null); setTimeout(handleShare, 100); }}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold bg-white text-black hover:bg-neutral-100 transition-all"
                >
                  Try again
                </button>
              </>
            ) : shareUrl ? (
              /* Success state */
              <>
                <div className="flex items-center gap-2 bg-white/5 rounded-xl px-3 py-2.5 mb-3">
                  <span className="flex-1 text-xs text-neutral-300 truncate font-mono">{shareUrl}</span>
                </div>
                <button
                  onClick={handleCopyToast}
                  className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                    toastCopied
                      ? 'bg-green-500/20 text-green-300 border border-green-500/30'
                      : 'bg-white text-black hover:bg-neutral-100'
                  }`}
                >
                  {toastCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {toastCopied ? 'Copied!' : 'Copy link'}
                </button>
                <p className="text-[10px] text-neutral-600 text-center mt-2">
                  Anyone with this link can view your box
                </p>
              </>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Side Editor overlay (edit mode only) */}
      <AnimatePresence>
        {!isViewOnly && activeMode === 'SIDE_EDIT' && selectedSide && (
          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="absolute inset-0 flex items-center justify-center p-8 z-50 pointer-events-none">
            <div className="w-full max-w-6xl h-[80vh] pointer-events-auto">
              <SideEditor
                side={selectedSide}
                onUpdate={(elements) => updateSideElements(selectedSide.id, elements)}
                onClose={handleBackToBox}
                config={config}
                shareId={shareId ?? undefined}
                getOrCreateShareId={getOrCreateShareId}
                onMediaBytesChange={setMediaBytes}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* A share link that failed to load blocks the whole app — otherwise
          this would silently fall back to a blank, unsaved default box that
          looks and behaves exactly like a real one. */}
      {shareLoadFailed && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-neutral-950/95 backdrop-blur-sm px-6">
          <div className="max-w-sm w-full text-center">
            <p className="text-white font-semibold text-lg mb-2">This link isn't working</p>
            <p className="text-white/60 text-sm leading-relaxed mb-6">
              This link is invalid or has expired. If it came from an order, please contact 56 Moments for help.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-block rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-white/90"
            >
              Try again
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
