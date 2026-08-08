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
  editUntil: string | null;
  bytesLimit: number | null;
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
    const json = await r.json() as { id: string; editUntil: string | null; bytesLimit?: number };
    return { ok: true, id: json.id, url: buildShareUrl(json.id), editUntil: json.editUntil, bytesLimit: json.bytesLimit ?? null };
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

/** Locks a share permanently — enforced server-side, so it stays locked for
 *  every device/browser that opens the link, not just the one that clicked it. */
export async function finalizeShare(id: string): Promise<boolean> {
  try {
    const r = await fetch(`${API}/share/${encodeURIComponent(id)}/finalize`, { method: 'POST' });
    return r.ok;
  } catch {
    return false;
  }
}

export interface LoadedShare {
  config: BoxConfig;
  sides: BoxSide[];
  editUntil: string | null;
  finalized: boolean;
  mediaBytes: number;
  bytesLimit: number;
}

/** Fetch a share by ID. This is also what starts the server-side edit-window
 *  countdown on first call — see GET /api/share/:id on the server. */
export async function loadShare(id: string): Promise<LoadedShare | null> {
  try {
    const r = await fetch(`${API}/share/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const json = await r.json() as {
      config?: BoxConfig; sides?: BoxSide[];
      editUntil?: string | null; finalized?: boolean;
      mediaBytes?: number; bytesLimit?: number;
    };
    if (!json.config || !json.sides) return null;
    return {
      config: json.config,
      sides: json.sides,
      editUntil: json.editUntil ?? null,
      finalized: json.finalized ?? false,
      mediaBytes: json.mediaBytes ?? 0,
      bytesLimit: json.bytesLimit ?? 0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Media upload (image → WebP / video+GIF → MP4 via server)
// ---------------------------------------------------------------------------

export type UploadResult =
  | { ok: true; url: string; bytes: number; mediaBytes?: number; bytesLimit?: number }
  | { ok: false; limitReached: true; mediaBytes: number; bytesLimit: number }
  | { ok: false; limitReached: false };

/**
 * Upload a File to the share server for conversion + R2 storage.
 *
 * @param shareId  The share this image belongs to.
 * @param file     The File object from an <input type="file"> or drag-drop.
 * @param hd       Set true for background / hero images (higher quality, larger max-size).
 */
export async function uploadMedia(
  shareId: string,
  file: File,
  hd = false,
): Promise<UploadResult> {
  try {
    const r = await fetch(
      `${API}/share/${encodeURIComponent(shareId)}/upload-media?hd=${hd ? 1 : 0}`,
      {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      },
    );
    if (r.status === 413) {
      const json = await r.json().catch(() => ({} as any));
      return { ok: false, limitReached: true, mediaBytes: json.mediaBytes ?? 0, bytesLimit: json.bytesLimit ?? 0 };
    }
    if (!r.ok) return { ok: false, limitReached: false };
    const json = await r.json() as { url?: string; bytes?: number; mediaBytes?: number; bytesLimit?: number };
    if (!json.url) return { ok: false, limitReached: false };
    return { ok: true, url: json.url, bytes: json.bytes ?? 0, mediaBytes: json.mediaBytes, bytesLimit: json.bytesLimit };
  } catch {
    return { ok: false, limitReached: false };
  }
}

// ---------------------------------------------------------------------------
// Orphan cleanup — deleting an element that references our own uploaded file
// should reclaim its storage. External URLs (e.g. GIPHY GIFs) are never ours
// to delete and cost us nothing, so they're left alone.
// ---------------------------------------------------------------------------

function serverHostedKey(url: string): string | null {
  // Match by path segment rather than requiring the origin to equal API exactly —
  // the server always returns an absolute URL built from its own PUBLIC_API_BASE/
  // RENDER_EXTERNAL_URL, which won't match a relative VITE_API_BASE in local dev
  // (proxied through Vite) even though it's still genuinely our own storage.
  const r2Marker    = '/api/r2/';
  const mediaMarker = '/api/media/';
  const r2Idx    = url.indexOf(r2Marker);
  const mediaIdx = url.indexOf(mediaMarker);
  if (r2Idx    !== -1) return url.slice(r2Idx + r2Marker.length);
  if (mediaIdx !== -1) return url.slice(mediaIdx + mediaMarker.length);
  return null;
}

/** True if this URL points at our own R2/local storage (not an external CDN like GIPHY). */
export function isServerHostedUrl(url: string): boolean {
  return serverHostedKey(url) !== null;
}

/** Deletes an uploaded file and reclaims its bytes from the share's cap. No-ops for external URLs. */
export async function deleteMedia(shareId: string, url: string, bytes: number): Promise<{ ok: boolean; mediaBytes?: number }> {
  const key = serverHostedKey(url);
  if (!key) return { ok: false };
  try {
    const r = await fetch(`${API}/share/${encodeURIComponent(shareId)}/media`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, bytes }),
    });
    if (!r.ok) return { ok: false };
    const json = await r.json().catch(() => ({} as any)) as { mediaBytes?: number };
    return { ok: true, mediaBytes: json.mediaBytes };
  } catch {
    return { ok: false };
  }
}
