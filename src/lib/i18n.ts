import React, { createContext, useContext, useMemo, useState, useCallback } from 'react';

export type Lang = 'en' | 'mn';

const LANG_KEY = 'lang';

const dict = {
  passwordPrompt:   { en: 'Enter password to continue', mn: 'Үргэлжлүүлэхийн тулд нууц үг оруулна уу' },
  passwordPlaceholder: { en: 'Password', mn: 'Нууц үг' },
  unlock:           { en: 'Unlock', mn: 'Нээх' },

  share:            { en: 'Share', mn: 'Хуваалцах' },
  copyLink:         { en: 'Copy Link', mn: 'Холбоос хуулах' },
  starting:         { en: 'Starting…', mn: 'Эхэлж байна…' },
  preview:          { en: 'Preview', mn: 'Урьдчилан үзэх' },
  endEditing:       { en: 'End Editing', mn: 'Засварлахыг дуусгах' },
  hideEditor:       { en: 'Hide Editor', mn: 'Засварлагчийг нуух' },
  showEditor:       { en: 'Show Editor', mn: 'Засварлагчийг харуулах' },
  edit:             { en: 'Edit', mn: 'Засах' },

  finishTitle:      { en: 'Finish editing?', mn: 'Засварыг дуусгах уу?' },
  finishBody1:      { en: 'This will lock the box in view-only mode.', mn: 'Энэ нь хайрцгийг зөвхөн харах горимд түгжинэ.' },
  finishBody2:      { en: "You won't be able to edit it again.", mn: 'Та үүнийг дахин засварлах боломжгүй болно.' },
  cancel:           { en: 'Cancel', mn: 'Цуцлах' },
  yesFinish:        { en: 'Yes, finish', mn: 'Тийм, дуусгах' },

  text:             { en: 'Text', mn: 'Текст' },
  photo:            { en: 'Photo', mn: 'Зураг' },
  converting:       { en: 'Converting…', mn: 'Хөрвүүлж байна…' },
  gif:              { en: 'GIF', mn: 'GIF' },
  video:            { en: 'Video', mn: 'Видео' },
  sticker:          { en: 'Sticker', mn: 'Наалт' },
  done:             { en: 'Done', mn: 'Болсон' },

  editSide:         { en: 'Edit a side', mn: 'Тал засах' },
  pickSideTitle:    { en: 'Choose a side to edit', mn: 'Засах талаа сонгоно уу' },
  side:             { en: 'Side', mn: 'Тал' },
  base:             { en: 'Base', mn: 'Ёроол' },
  layer:            { en: 'Layer', mn: 'Давхарга' },
  hasContent:       { en: 'Has content', mn: 'Агуулгатай' },
  close:            { en: 'Close', mn: 'Хаах' },
} as const;

export type TKey = keyof typeof dict;

function detectInitialLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === 'en' || stored === 'mn') return stored;
  } catch { /* localStorage disabled */ }
  return 'en';
}

interface LangContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: TKey) => string;
}

const LangContext = createContext<LangContextValue | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(LANG_KEY, l); } catch { /* ignore */ }
  }, []);

  const t = useCallback((key: TKey) => dict[key][lang], [lang]);

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return React.createElement(LangContext.Provider, { value }, children);
}

export function useLang(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error('useLang must be used within a LanguageProvider');
  return ctx;
}
