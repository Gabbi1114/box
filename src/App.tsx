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
  Layers, Settings, ChevronLeft, ChevronRight, Share2, Box as BoxIcon,
  Copy, Check, Loader, Eye, Pencil, X, Play, RotateCcw, Lock,
} from 'lucide-react';
import { createShare, updateShare, loadShare, getShareId, buildShareUrl } from './lib/shareSystem.ts';
import LoadingScreen from './components/LoadingScreen.tsx';

const EDITOR_PASSWORD = import.meta.env.VITE_STUDIO_PASSWORD as string | undefined;

function PasswordGate({ onUnlock }: { onUnlock: () => void }) {
  const [value, setValue] = useState('');
  const [shake, setShake]   = useState(false);

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
    <div className="relative w-full h-screen bg-neutral-950 flex items-center justify-center font-sans">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-80 flex flex-col items-center gap-6"
      >
        <div className="w-14 h-14 bg-gradient-to-br from-pink-500 to-violet-500 rounded-2xl flex items-center justify-center shadow-lg shadow-pink-500/20">
          <Lock className="w-7 h-7 text-white" />
        </div>
        <div className="text-center">
          <h1 className="text-xl font-bold text-white tracking-tight">Explosion Box Studio</h1>
          <p className="text-xs text-neutral-500 mt-1">Enter password to continue</p>
        </div>
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
            placeholder="Password"
            autoFocus
            className="w-full px-4 py-3 rounded-xl bg-white/8 border border-white/10 text-white placeholder-neutral-600 text-sm outline-none focus:border-pink-500/60 focus:bg-white/10 transition-all text-center tracking-widest"
          />
        </motion.div>
        <button
          onClick={submit}
          className="w-full py-3 rounded-xl bg-pink-600 hover:bg-pink-500 text-white text-sm font-semibold transition-all active:scale-95"
        >
          Unlock
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
  const isShareLink = !!getShareId();
  const needsPassword = !!EDITOR_PASSWORD && !isShareLink;
  const [unlocked, setUnlocked] = useState(() => !needsPassword);

  // Loading screen — shown until 3D first frame fires AND min time passes
  const [sceneReady, setSceneReady]   = useState(false);
  const [minTimeDone, setMinTimeDone] = useState(false);
  const loadingDone = sceneReady && minTimeDone;

  useEffect(() => {
    const t = setTimeout(() => setMinTimeDone(true), 1800);
    return () => clearTimeout(t);
  }, []);

  const [config, setConfig] = useState<BoxConfig>(DEFAULT_CONFIG);
  const [sides, setSides] = useState<BoxSide[]>([]);
  const [activeMode, setActiveMode] = useState<AppMode>('BOX_EDIT');
  const [selectedSideId, setSelectedSideId] = useState<string | null>(null);
  const [showUI, setShowUI] = useState(true);

  // Share state
  const [shareId, setShareId]         = useState<string | null>(null);
  const [shareUrl, setShareUrl]       = useState<string | null>(null);
  const [showShareToast, setShowShareToast] = useState(false);
  const [toastCopied, setToastCopied] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);

  // View-only mode (set when loading from ?share= URL, or after clicking "Done Editing")
  const [isViewOnly, setIsViewOnly]   = useState(false);
  // Once the user confirms "Done Editing", editing is permanently locked for this session
  const [editingLocked, setEditingLocked] = useState(false);
  const [showFinishConfirm, setShowFinishConfirm] = useState(false);

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

    let cancelled = false;          // guards against StrictMode double-fire
    isLoadingShare.current = true;
    setShareLoading(true);

    loadShare(id).then(data => {
      if (cancelled) return;        // StrictMode unmounted this run — ignore
      isLoadingShare.current = false;
      setShareLoading(false);
      if (!data) return;
      setConfig(data.config);
      setSides(data.sides);
      setShareId(id);
      setShareUrl(buildShareUrl(id));
      setIsViewOnly(true);
      // Restore permanent lock from localStorage (survives page refresh)
      if (localStorage.getItem(`editingLocked_${id}`) === '1') {
        setEditingLocked(true);
      }
    });

    return () => {
      cancelled = true;
      isLoadingShare.current = false;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Auto-save: push updates 2 s after last change (edit mode only)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!shareId || isLoadingShare.current || isViewOnly) return;
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
    const result = await createShare(config, sides);
    setShareLoading(false);

    if (!result.ok) return;

    setShareId(result.id);
    setShareUrl(result.url);
    setShowShareToast(true);
    setToastCopied(false);
  }, [shareLoading, shareUrl, config, sides]);

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

      {/* 3D Canvas */}
      <div className={`absolute inset-0 transition-all duration-1000 ${activeMode === 'SIDE_EDIT' ? 'opacity-20 pointer-events-none scale-110 blur-sm' : 'opacity-100'}`}>
        <Box3D config={config} sides={sides} onSideClick={handleSideClick} onReady={() => setSceneReady(true)} />
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
          <div className={`absolute inset-x-0 bottom-0 p-6 flex justify-center pointer-events-none transition-all duration-500 ${showUI ? 'translate-y-0 opacity-100' : 'translate-y-20 opacity-0'}`}>
            <AnimatePresence mode="wait">
              {activeMode === 'BOX_EDIT' ? (
                <motion.div key="box-editor" initial={{ y: 100, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 100, opacity: 0 }} className="pointer-events-auto w-full max-w-4xl">
                  <BoxEditor config={config} setConfig={setConfig} onToggleOpen={handleToggleOpen} onPrevStep={handlePrevStep} />
                </motion.div>
              ) : (
                <motion.div key="side-editor-back" initial={{ y: 100, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 100, opacity: 0 }} className="pointer-events-auto">
                  <button onClick={handleBackToBox} className="mb-4 px-6 py-3 bg-white/10 hover:bg-white/20 backdrop-blur-xl border border-white/20 rounded-full flex items-center gap-2 transition-colors group">
                    <ChevronLeft className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
                    Return to View
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Top-right controls */}
          <div className="absolute top-6 right-6 z-50 flex items-center gap-2">

            {/* Share button — only shown in edit mode, not on shared links */}
            {!shareId && (
              <motion.button
                onClick={handleShare}
                whileTap={{ scale: 0.92 }}
                className="flex items-center gap-2 px-4 py-2 rounded-full backdrop-blur-md border bg-white/10 hover:bg-white/20 border-white/10 text-white text-sm font-medium transition-all"
              >
                {shareLoading
                  ? <Loader className="w-4 h-4 animate-spin" />
                  : <Share2  className="w-4 h-4" />}
                <span>{shareLoading ? 'Saving…' : 'Share'}</span>
              </motion.button>
            )}

            {/* Done Editing — simple reversible view toggle */}
            <motion.button
              onClick={() => setIsViewOnly(true)}
              whileTap={{ scale: 0.92 }}
              className="flex items-center gap-2 px-4 py-2 rounded-full backdrop-blur-md border bg-white/10 hover:bg-white/20 border-white/10 text-white text-sm font-medium transition-all"
            >
              <Eye className="w-4 h-4" />
              <span>Preview</span>
            </motion.button>

            {/* End Editing — permanent lock, only on shared links */}
            {shareId && (
              <motion.button
                onClick={() => setShowFinishConfirm(true)}
                whileTap={{ scale: 0.92 }}
                className="flex items-center gap-2 px-4 py-2 rounded-full backdrop-blur-md border bg-pink-600/80 hover:bg-pink-600 border-pink-500/40 text-white text-sm font-semibold transition-all"
              >
                <Check className="w-4 h-4" />
                <span>End Editing</span>
              </motion.button>
            )}

            {/* Show/Hide UI */}
            <button
              onClick={() => setShowUI(!showUI)}
              className="p-2.5 bg-white/10 hover:bg-white/20 backdrop-blur-md rounded-full border border-white/10 transition-all active:scale-90"
              title={showUI ? 'Hide Editor' : 'Show Editor'}
            >
              {showUI ? <Settings className="w-5 h-5 text-neutral-400" /> : <Layers className="w-5 h-5 text-pink-500" />}
            </button>
          </div>
        </>
      )}

      {/* ── VIEW-ONLY UI ── */}
      {isViewOnly && unlocked && (
        <>
          {/* Top-right: share + edit */}
          <div className="absolute top-6 right-6 z-50 flex items-center gap-2">
            {shareUrl && (
              <button
                onClick={() => { setShowShareToast(true); setToastCopied(false); }}
                className="flex items-center gap-2 px-4 py-2 rounded-full backdrop-blur-md border bg-white/10 hover:bg-white/20 border-white/10 text-white text-sm font-medium transition-all"
              >
                <Share2 className="w-4 h-4" />
                <span>Share</span>
              </button>
            )}
            {!editingLocked && (
              <button
                onClick={() => setIsViewOnly(false)}
                className="p-2.5 bg-white/10 hover:bg-white/20 backdrop-blur-md rounded-full border border-white/10 transition-all active:scale-90"
                title="Edit"
              >
                <Pencil className="w-4 h-4 text-neutral-400" />
              </button>
            )}
          </div>

          {/* Bottom: box navigation only */}
          <div className="absolute inset-x-0 bottom-0 p-6 flex justify-center">
            <motion.div initial={{ y: 100, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.3 }}>
              <div className="flex items-center gap-2 bg-black/70 backdrop-blur-xl rounded-full px-3 py-2 border border-white/[0.07]">
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
                      ? 'bg-pink-600 shadow-[0_0_12px_rgba(236,72,153,0.5)]'
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
            className="absolute inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => setShowFinishConfirm(false)}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 16 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.92, opacity: 0, y: 16 }}
              transition={{ duration: 0.2 }}
              className="w-80 bg-neutral-900/98 backdrop-blur-xl border border-white/10 rounded-2xl p-6 shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <div className="w-12 h-12 bg-pink-500/15 rounded-2xl flex items-center justify-center mb-4 mx-auto">
                <Eye className="w-6 h-6 text-pink-400" />
              </div>
              <h2 className="text-base font-bold text-white text-center mb-1">Finish editing?</h2>
              <p className="text-xs text-neutral-400 text-center mb-5 leading-relaxed">
                This will lock the box in view-only mode.<br />
                You won't be able to edit it again.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowFinishConfirm(false)}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-white/8 hover:bg-white/12 text-neutral-300 transition-all border border-white/10"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setShowFinishConfirm(false);
                    setEditingLocked(true);
                    setIsViewOnly(true);
                    if (shareId) localStorage.setItem(`editingLocked_${shareId}`, '1');
                  }}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold bg-pink-600 hover:bg-pink-500 text-white transition-all"
                >
                  Yes, finish
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── SHARE TOAST ── */}
      <AnimatePresence>
        {showShareToast && shareUrl && (
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.96 }}
            transition={{ duration: 0.18 }}
            className="absolute top-20 right-6 z-[100] w-80 bg-neutral-900/95 backdrop-blur-xl border border-white/10 rounded-2xl p-4 shadow-2xl"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-white">Share link</span>
              <button onClick={() => setShowShareToast(false)} className="p-1 text-neutral-500 hover:text-white transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* URL display */}
            <div className="flex items-center gap-2 bg-white/5 rounded-xl px-3 py-2.5 mb-3">
              <span className="flex-1 text-xs text-neutral-300 truncate font-mono">{shareUrl}</span>
            </div>

            {/* Copy button */}
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
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Title */}
      <div className="absolute top-6 left-6 pointer-events-none">
        <motion.div initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-pink-500 to-violet-500 rounded-xl flex items-center justify-center shadow-lg shadow-pink-500/20">
            <BoxIcon className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Explosion Box Studio</h1>
            <p className="text-xs text-neutral-400 font-mono uppercase tracking-widest">
              {shareLoading
                ? 'Loading share…'
                : isViewOnly
                ? 'View only'
                : activeMode === 'SIDE_EDIT'
                ? `Editing Layer ${(selectedSide?.layer ?? 0) + 1} · ${selectedSide?.index === -1 ? 'Base' : `Side ${(selectedSide?.index ?? 0) + 1}`}`
                : shareId
                ? 'Editing · auto-saving'
                : 'Customize Your 3D Box'}
            </p>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
