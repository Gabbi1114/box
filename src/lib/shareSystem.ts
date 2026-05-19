/**
 * Explosion Box Studio — Share System
 * Handles creating / loading / updating shares and uploading media for AVIF conversion.
 * The Vite dev server proxies /api → http://localhost:3001 so there are no CORS issues.
 */
import { BoxConfig, BoxSide } from '../types';

const API = (import.meta.env.VITE_API_BASE ?? '') + '/api';

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Returns the ?share=<id> value from the current URL, or null. */
export function getShareId(): string | null {
  return new URLSearchParams(window.location.search).get('share');
}

/** Builds a shareable URL for a given ID. */
export function buildShareUrl(id: string): string {
  const u = new URL(window.location.href);
  u.search = `?share=${encodeURIComponent(id)}`;
  u.hash   = '';
  return u.toString();
}

// ---------------------------------------------------------------------------
// Share CRUD
// ---------------------------------------------------------------------------

export interface ShareResult {
  ok: true;
  id: string;
  url: string;
  editUntil: string;
}

/** Create a new share. Returns the ID and a shareable URL. */
export async function createShare(
  config: BoxConfig,
  sides: BoxSide[],
): Promise<ShareResult | { ok: false; error: string }> {
  try {
    const r = await fetch(`${API}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, sides }),
    });
    if (!r.ok) return { ok: false, error: await r.text() };
    const json = await r.json() as { id: string; editUntil: string };
    return { ok: true, id: json.id, url: buildShareUrl(json.id), editUntil: json.editUntil };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Update an existing share with fresh state (within its edit window). */
export async function updateShare(
  id: string,
  config: BoxConfig,
  sides: BoxSide[],
): Promise<boolean> {
  try {
    const r = await fetch(`${API}/share/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, sides }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Fetch a share by ID and return its config + sides. */
export async function loadShare(
  id: string,
): Promise<{ config: BoxConfig; sides: BoxSide[] } | null> {
  try {
    const r = await fetch(`${API}/share/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const json = await r.json() as { config?: BoxConfig; sides?: BoxSide[] };
    if (!json.config || !json.sides) return null;
    return { config: json.config, sides: json.sides };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Media upload (image → AVIF via server)
// ---------------------------------------------------------------------------

/**
 * Upload a File to the share server for AVIF conversion.
 * Returns the persistent server URL of the converted image, or null on failure.
 *
 * @param shareId  The share this image belongs to.
 * @param file     The File object from an <input type="file"> or drag-drop.
 * @param hd       Set true for background / hero images (higher quality, larger max-size).
 */
export async function uploadMedia(
  shareId: string,
  file: File,
  hd = false,
): Promise<string | null> {
  try {
    const r = await fetch(
      `${API}/share/${encodeURIComponent(shareId)}/upload-media?hd=${hd ? 1 : 0}`,
      {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      },
    );
    if (!r.ok) return null;
    const json = await r.json() as { url?: string };
    return json.url ?? null;
  } catch {
    return null;
  }
}
