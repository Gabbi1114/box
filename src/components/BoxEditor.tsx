import React, { useState } from 'react';
import { BoxConfig, FloatingShape } from '../types';
import {
  Layers, Maximize, Box as BoxIcon, Play, ChevronRight, ChevronLeft, RotateCcw,
  Heart, Cake, Rose,
} from 'lucide-react';

interface BoxEditorProps {
  config: BoxConfig;
  setConfig: React.Dispatch<React.SetStateAction<BoxConfig>>;
  onToggleOpen: () => void;
  onPrevStep?: () => void;
}

const colors = [
  '#ec4899', '#8b5cf6', '#3b82f6', '#10b981',
  '#f59e0b', '#ef4444', '#ffffff', '#171717',
];

type ColorTarget = 'baseColor' | 'innerColor';
const COLOR_PARTS: { key: ColorTarget; label: string }[] = [
  { key: 'baseColor',  label: 'Out' },
  { key: 'innerColor', label: 'In'  },
];

const FLOATING_SHAPES: { key: FloatingShape; Icon: typeof Heart; title: string }[] = [
  { key: 'heart', Icon: Heart, title: 'Heart' },
  { key: 'cake',  Icon: Cake,  title: 'Birthday cake' },
  { key: 'rose',  Icon: Rose,  title: 'Rose bouquet' },
];

export default function BoxEditor({ config, setConfig, onToggleOpen, onPrevStep }: BoxEditorProps) {
  const [colorTarget, setColorTarget] = useState<ColorTarget>('baseColor');

  const update = (key: keyof BoxConfig, value: any) =>
    setConfig(prev => ({ ...prev, [key]: value }));

  const statusText = () => {
    if (config.openLevel === 0) return 'closed';
    if (config.openLevel === 1) return 'lid off';
    if (config.openLevel > config.numLayers) return 'exploded';
    return `layer ${config.openLevel - 1}`;
  };

  return (
    <div className="flex items-end justify-center gap-1.5 sm:gap-2.5 flex-wrap pb-2 px-1 max-w-full">
      {/* Unbox pill */}
      <div className="flex items-center gap-1.5 sm:gap-2 bg-black/70 backdrop-blur-xl rounded-full px-2 sm:px-3 py-1.5 sm:py-2 border border-white/[0.07]">
        {config.openLevel > 0 && (
          <>
            <button
              onClick={() => update('openLevel', 0)}
              className="p-1 text-neutral-600 hover:text-neutral-300 transition-colors"
              title="Reset"
            >
              <RotateCcw className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
            </button>
            <button
              onClick={onPrevStep}
              className="p-1 text-neutral-600 hover:text-neutral-300 transition-colors"
              title="Back"
            >
              <ChevronLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </button>
          </>
        )}
        <button
          onClick={onToggleOpen}
          className={`w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center transition-all active:scale-90 shrink-0 ${
            config.openLevel > 0
              ? 'bg-pink-600 shadow-[0_0_12px_rgba(236,72,153,0.5)]'
              : 'bg-white hover:scale-105'
          }`}
        >
          {config.openLevel === 0
            ? <Play className="w-3 h-3 sm:w-3.5 sm:h-3.5 fill-black text-black ml-0.5" />
            : config.openLevel > config.numLayers
              ? <Play className="w-3 h-3 sm:w-3.5 sm:h-3.5 fill-white text-white ml-0.5 opacity-40" />
              : <ChevronRight className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-white" />
          }
        </button>
        <span className="hidden sm:inline text-[10px] font-mono text-neutral-600 uppercase pr-1 whitespace-nowrap">{statusText()}</span>
      </div>

      {/* Layers pill */}
      <div className="flex items-center gap-1.5 sm:gap-2.5 bg-black/70 backdrop-blur-xl rounded-full px-2.5 sm:px-4 py-1.5 sm:py-2 border border-white/[0.07]">
        <Layers className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-neutral-600 shrink-0" />
        <input
          type="range" min="1" max="6"
          value={config.numLayers}
          onChange={(e) => update('numLayers', parseInt(e.target.value))}
          className="w-10 sm:w-20 accent-pink-500 h-px bg-neutral-800 rounded appearance-none cursor-pointer"
        />
        <span className="text-[11px] sm:text-xs font-mono text-neutral-300 w-3 text-center">{config.numLayers}</span>
      </div>

      {/* Sides pill */}
      <div className="flex items-center gap-1.5 sm:gap-2.5 bg-black/70 backdrop-blur-xl rounded-full px-2.5 sm:px-4 py-1.5 sm:py-2 border border-white/[0.07]">
        <BoxIcon className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-neutral-600 shrink-0" />
        <input
          type="range" min="3" max="12"
          value={config.numSides}
          onChange={(e) => update('numSides', parseInt(e.target.value))}
          className="w-10 sm:w-20 accent-pink-500 h-px bg-neutral-800 rounded appearance-none cursor-pointer"
        />
        <span className="text-[11px] sm:text-xs font-mono text-neutral-300 w-3 text-center">{config.numSides}</span>
      </div>

      {/* Size pill */}
      <div className="flex items-center gap-1.5 sm:gap-2.5 bg-black/70 backdrop-blur-xl rounded-full px-2.5 sm:px-4 py-1.5 sm:py-2 border border-white/[0.07]">
        <Maximize className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-neutral-600 shrink-0" />
        <input
          type="range" min="2" max="5" step="0.1"
          value={config.size}
          onChange={(e) => update('size', parseFloat(e.target.value))}
          className="w-10 sm:w-20 accent-pink-500 h-px bg-neutral-800 rounded appearance-none cursor-pointer"
        />
        <span className="text-[11px] sm:text-xs font-mono text-neutral-300 w-6 sm:w-7 text-center">{config.size.toFixed(1)}</span>
      </div>

      {/* Combined color picker pill */}
      <div className="flex items-center gap-1.5 sm:gap-2 bg-black/70 backdrop-blur-xl rounded-full px-2 sm:px-3 py-1.5 sm:py-2 border border-white/[0.07]">
        {/* Part selector tabs */}
        <div className="flex items-center gap-0.5">
          {COLOR_PARTS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setColorTarget(key)}
              className={`px-1.5 sm:px-2 py-1 rounded-full text-[9px] sm:text-[10px] font-mono uppercase transition-all ${
                colorTarget === key
                  ? 'bg-white/15 text-white'
                  : 'text-neutral-600 hover:text-neutral-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="w-px h-4 bg-white/10" />
        {/* Swatches for the active target */}
        {colors.map(color => (
          <button
            key={color}
            onClick={() => update(colorTarget, color)}
            className={`w-4 h-4 sm:w-5 sm:h-5 rounded-full transition-all hover:scale-125 active:scale-95 shrink-0 ${
              config[colorTarget] === color ? 'ring-2 ring-white ring-offset-1 ring-offset-black scale-110' : ''
            }`}
            style={{ backgroundColor: color }}
          />
        ))}
      </div>

      {/* Floating shape picker pill */}
      <div className="flex items-center gap-1 bg-black/70 backdrop-blur-xl rounded-full px-1.5 sm:px-2 py-1.5 sm:py-2 border border-white/[0.07]">
        {FLOATING_SHAPES.map(({ key, Icon, title }) => (
          <button
            key={key}
            onClick={() => update('floatingShape', key)}
            title={title}
            className={`w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center transition-all active:scale-90 shrink-0 ${
              (config.floatingShape ?? 'heart') === key
                ? 'bg-pink-600 text-white'
                : 'text-neutral-500 hover:text-neutral-200 hover:bg-white/10'
            }`}
          >
            <Icon className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
          </button>
        ))}
      </div>
    </div>
  );
}
