/**
 * Explosion Box Studio — Share Server
 * Port 3001 | Handles share persistence + image → WebP / GIF → MP4 conversion + R2 upload
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'share-data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const PORT      = Number(process.env.PORT ?? process.env.SHARE_PORT ?? 3001);
// Fixed at 30 days / 15MB to match scrapbook and book exactly — hardcoded
// (not env-driven) so a stray Render env var can't silently pull one app's
// limits out of sync with the other two again.
const MAX_EDIT_DAYS = 30;
// Cumulative uploaded-media cap per share, enforced in upload-media below.
// Keeps per-share storage cost bounded regardless of how many people use the app.
const MEDIA_BYTES_LIMIT = 15 * 1024 * 1024;

fs.mkdirSync(DATA_DIR,  { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// R2 — optional, falls back to local disk if env vars not set
// ---------------------------------------------------------------------------
const R2_ENDPOINT      = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_KEY    = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET        = process.env.R2_BUCKET;
const R2_PUBLIC_URL    = process.env.R2_PUBLIC_URL?.replace(/\/$/, ''); // no trailing slash

const r2 = R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_KEY && R2_BUCKET
  ? new S3Client({
      region: 'auto',
      endpoint: R2_ENDPOINT,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_KEY },
      maxAttempts: 1,  // never retry — bad creds cause 30s+ backoff loops otherwise
    })
  : null;

if (r2) {
  console.log(`[share] ✓ R2 enabled — bucket: ${R2_BUCKET}`);
} else {
  console.warn('[share] ✗ R2 not configured — media stored on local disk');
}

function serverBase() {
  return process.env.PUBLIC_API_BASE ?? process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${PORT}`;
}

async function storeMedia(shareId, slug, body, contentType) {
  if (r2) {
    const key = `${shareId}/${slug}`;
    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    // Proxy through our server so the browser gets CORS headers (R2 token lacks PutBucketCors)
    return `${serverBase()}/api/r2/${key}`;
  }

  // Local fallback
  const dir = path.join(MEDIA_DIR, shareId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, slug), body);
  return `${serverBase()}/api/media/${shareId}/${slug}`;
}

// Deletes one uploaded media object (mirrors storeMedia's key scheme: `${shareId}/${slug}`).
async function deleteMediaObject(shareId, slug) {
  if (r2) {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: `${shareId}/${slug}` })).catch(() => {});
    return;
  }
  try { fs.unlinkSync(path.join(MEDIA_DIR, shareId, slug)); } catch {}
}

// ---------------------------------------------------------------------------
// Sharp (AVIF conversion) — optional, graceful fallback if not installed
// ---------------------------------------------------------------------------
let sharp = null;
try {
  sharp = (await import('sharp')).default;
  console.log('[share] ✓ sharp loaded — WebP conversion enabled');
} catch {
  console.warn('[share] ✗ sharp not found — images stored as-is');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const safeId  = (id) => path.basename(String(id)).replace(/[^a-zA-Z0-9_-]/g, '');
const jsonPath = (id) => path.join(DATA_DIR, `${safeId(id)}.json`);

// 'test' is the public local-only demo route — src/lib/demoShare.ts never
// calls this server for it at all (content is built entirely client-side),
// so nothing here needs to special-case that id.

// Creating a share (or pre-provisioning one for a specific paid id) requires
// this shared secret — only 56moments.store's main server knows it, so a
// browser calling this API directly can never mint a free share. Existing
// shares remain freely readable/editable (GET/PUT/finalize/upload-media are
// unauthenticated by design — that's how the customer who received a real
// link uses it).
const SHARE_CREATE_SECRET = process.env.SHARE_CREATE_SECRET;
function requireCreateSecret(req, res, next) {
  if (!SHARE_CREATE_SECRET) return next(); // not configured yet — dev convenience only
  if (req.get('x-box-create-secret') !== SHARE_CREATE_SECRET)
    return res.status(403).json({ error: 'Forbidden' });
  next();
}

// Always write to local disk. If R2 is configured, also persist there so data
// survives Render service restarts (Render free tier has ephemeral disk).
async function writeShare(id, data) {
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(jsonPath(id), json, 'utf8');
  if (r2) {
    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: `${safeId(id)}/share.json`,
      Body: json,
      ContentType: 'application/json',
      CacheControl: 'no-cache, no-store',
    })).catch(e => console.warn('[share] R2 share write failed:', e.message));
  }
}

// Try local disk first (fast, works within same Render instance). If missing —
// which happens after a restart — fall back to R2 so the data is recovered.
async function readShare(id) {
  try { return JSON.parse(fs.readFileSync(jsonPath(id), 'utf8')); } catch {}
  if (!r2) return null;
  try {
    const res = await r2.send(new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: `${safeId(id)}/share.json`,
    }));
    const text = await res.Body.transformToString();
    const data = JSON.parse(text);
    // Cache locally so subsequent reads are instant
    fs.writeFileSync(jsonPath(id), JSON.stringify(data, null, 2), 'utf8');
    return data;
  } catch {
    return null;
  }
}

function editWindowOpen(share) {
  return !share.editUntil || new Date(share.editUntil) > new Date();
}

// ---------------------------------------------------------------------------
// Self-heal: if a share isn't on disk yet, ask 56moments.store's main server
// whether this id was ever actually issued (paid for) before creating it here.
// Covers two real gaps: the background /ensure call that runs right after an
// order is approved can still be mid-retry (cold Render backend) when the
// customer clicks the link, or it can have exhausted its retries entirely —
// either way, without this, a link nobody did anything wrong to just 404s
// forever with "invalid or expired". A random unpaid id still gets rejected,
// since verify only returns true for ids that exist in a real order.
// ---------------------------------------------------------------------------
const MAIN_STORE_API_BASE = (process.env.MAIN_STORE_API_BASE ?? 'https://56moments.store').replace(/\/$/, '');

function defaultBoxPayload() {
  return {
    config: { numLayers: 1, numSides: 4, baseColor: '#8b5cf6', innerColor: '#fdf2f8', size: 3, openLevel: 0, floatingShape: 'rose' },
    sides: [0, 1, 2, 3, -1].map((index) => ({ id: `s${index}`, layer: 0, index, elements: [] })),
  };
}

async function selfHealShare(id) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const r = await fetch(`${MAIN_STORE_API_BASE}/api/webcard-verify/${encodeURIComponent(id)}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const { valid } = await r.json();
    if (!valid) return null;
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[share] self-heal verify failed for ${id}:`, e.message);
    return null;
  }
  const { config, sides } = defaultBoxPayload();
  const data = {
    v: 1, config, sides,
    editUntil: null,
    editDays: MAX_EDIT_DAYS,
    finalized: false,
    mediaBytes: 0,
    createdAt: new Date().toISOString(),
  };
  await writeShare(id, data);
  console.log(`[share] self-healed ${id} (verified with main store, was never created here)`);
  return data;
}

// ---------------------------------------------------------------------------
// ffmpeg (video → MP4) — optional, graceful fallback if not installed
// ---------------------------------------------------------------------------
let ffmpegBin = null;
let ffprobeBin = null;
try {
  ffmpegBin = (await import('ffmpeg-static')).default;
  ffprobeBin = (await import('ffprobe-static')).default.path;
  console.log('[share] ✓ ffmpeg loaded — video transcoding enabled');
} catch {
  console.warn('[share] ✗ ffmpeg-static/ffprobe-static not found — videos stored as-is');
}

// Matches scrapbook's cap — keeps the two apps' upload limits (and their
// user-facing messaging) consistent.
const MAX_VIDEO_SECONDS = 60;

async function transcodeVideo(buf, mime) {
  const srcExt = EXT_BY_MIME[mime] ?? '.mp4';

  if (!ffmpegBin) {
    return { body: buf, contentType: mime, ext: srcExt };
  }

  const tmpIn  = path.join(os.tmpdir(), `box-vin-${Date.now()}.tmp`);
  const tmpOut = path.join(os.tmpdir(), `box-vout-${Date.now()}.mp4`);

  try {
    fs.writeFileSync(tmpIn, buf);

    if (ffprobeBin) {
      const probe = await execFileAsync(ffprobeBin, [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', tmpIn,
      ]);
      const durationSec = Number.parseFloat((probe.stdout || '').trim());
      if (Number.isFinite(durationSec) && durationSec > MAX_VIDEO_SECONDS) {
        const err = new Error(`Video exceeds ${MAX_VIDEO_SECONDS}s limit.`);
        err.code = 'VIDEO_TOO_LONG';
        throw err;
      }
    }

    // H.264 MP4: universally supported (iOS, Android, desktop). Always
    // transcodes now — previously mp4/webm/ogg (i.e. almost every real
    // upload) skipped this entirely and stored the raw bytes untouched,
    // which is where box's video storage was actually going. Capped to
    // 480px wide since these are small decorative face-in-a-box loops, not
    // full-page content — matches scrapbook's scale/crf/maxrate approach,
    // just tighter given box's smaller on-screen footprint. Audio still
    // stripped (box faces are silent looping clips) — the biggest single
    // size win, since it drops the audio track entirely rather than just
    // compressing it.
    await execFileAsync(ffmpegBin, [
      '-i', tmpIn,
      '-t', String(MAX_VIDEO_SECONDS),
      // Single-quoted min(...) — not a backslash-escaped comma — because
      // the backslash form (which scrapbook's equivalent filter also uses)
      // got silently stripped by Node's argv handling when tested on
      // Windows, breaking ffmpeg's filter-graph parser ("No option name
      // near 'fast_bilinear'"). Single quotes are ffmpeg's own filter-value
      // quoting and aren't touched by any OS/child_process layer — verified
      // scale-down-only (never upscales) on both landscape and portrait
      // sources before shipping this.
      '-vf', "scale='min(480,iw)':-2:flags=fast_bilinear",
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '32',
      '-maxrate', '500k',
      '-bufsize', '1000k',
      '-an',                        // strip audio (box faces are silent looping clips)
      '-movflags', '+faststart',    // move MP4 metadata to front for instant streaming
      '-pix_fmt', 'yuv420p',
      '-y', tmpOut,
    ], { timeout: 90_000 });

    const body = fs.readFileSync(tmpOut);
    console.log(`[share] video    transcode OK  ${(buf.length / 1e6).toFixed(1)}MB → ${(body.length / 1e6).toFixed(1)}MB`);
    return { body, contentType: 'video/mp4', ext: '.mp4' };
  } catch (e) {
    if (e.code === 'VIDEO_TOO_LONG') throw e;
    console.warn('[share] Video transcode failed, storing original:', e.message?.slice(0, 120));
    return { body: buf, contentType: mime, ext: srcExt };
  } finally {
    try { fs.unlinkSync(tmpIn);  } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// GIFs have no inter-frame compression — a typical animated GIF is 5-20x
// larger than an equivalent H.264 MP4 and is decoded in software by the
// browser's image decoder rather than the hardware video decoder. Transcoding
// server-side turns every upload into the cheap <video> path instead.
async function transcodeGif(buf) {
  if (!ffmpegBin) {
    return { body: buf, contentType: 'image/gif', ext: '.gif' };
  }

  const tmpIn  = path.join(os.tmpdir(), `box-gin-${Date.now()}.gif`);
  const tmpOut = path.join(os.tmpdir(), `box-gout-${Date.now()}.mp4`);

  try {
    fs.writeFileSync(tmpIn, buf);

    await execFileAsync(ffmpegBin, [
      '-i', tmpIn,
      // libx264 + yuv420p requires even width/height >= 2
      '-vf', "scale='max(2,trunc(iw/2)*2)':'max(2,trunc(ih/2)*2)'",
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-movflags', '+faststart',
      '-y', tmpOut,
    ], { timeout: 90_000 });

    const body = fs.readFileSync(tmpOut);
    console.log(`[share] gif      transcode OK  ${(buf.length / 1e6).toFixed(1)}MB → ${(body.length / 1e6).toFixed(1)}MB`);
    return { body, contentType: 'video/mp4', ext: '.mp4' };
  } catch (e) {
    console.warn('[share] GIF transcode failed, storing original:', e.message?.slice(0, 120));
    return { body: buf, contentType: 'image/gif', ext: '.gif' };
  } finally {
    try { fs.unlinkSync(tmpIn);  } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// ---------------------------------------------------------------------------
// MIME / extension maps
// ---------------------------------------------------------------------------
const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/avif': '.avif',
  'video/mp4': '.mp4',  'video/webm': '.webm', 'video/ogg': '.ogg',
  'video/quicktime': '.mov', 'video/x-m4v': '.m4v',
};
const MIME_BY_EXT = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m])
);

async function convertImage(buf, mime, hd = false) {
  if (!sharp) {
    return { body: buf, contentType: mime, ext: EXT_BY_MIME[mime] ?? '.bin' };
  }
  try {
    const img     = sharp(buf, { failOn: 'none' }).rotate();
    const meta    = await img.metadata();
    // Back to WebP at effort:0 — AVIF at effort 4 was ~10x slower to encode
    // on Render's free-tier CPU, and that was most of what made uploads feel
    // slow. Not worth AVIF's smaller-file edge for that cost here.
    const maxSide = 1920;
    const resized = img.resize({
      width:  meta.width  > maxSide ? maxSide : undefined,
      height: meta.height > maxSide ? maxSide : undefined,
      fit: 'inside', withoutEnlargement: true,
      kernel: sharp.kernel.lanczos3,
    });
    const webp = await resized.webp({ quality: hd ? 82 : 78, effort: 0 }).toBuffer();
    return { body: webp, contentType: 'image/webp', ext: '.webp' };
  } catch (e) {
    console.warn('[share] WebP conversion failed, storing original:', e.message);
    return { body: buf, contentType: mime, ext: EXT_BY_MIME[mime] ?? '.bin' };
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

const CORS_ORIGIN = (process.env.CORS_ORIGIN ?? '*').replace(/\/$/, '');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// GET /api/health — quick liveness check (also wakes Render from sleep)
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, r2: !!r2, sharp: !!sharp, ts: Date.now() });
});

// ---------------------------------------------------------------------------
// POST /api/share — create new share
// ---------------------------------------------------------------------------
app.post('/api/share', requireCreateSecret, express.json({ limit: '5mb' }), async (req, res) => {
  const { config, sides } = req.body ?? {};
  if (!config || !sides) {
    return res.status(400).json({ error: 'config and sides are required' });
  }

  const id = crypto.randomBytes(12).toString('base64url');

  await writeShare(id, {
    v: 1, config, sides,
    // Deferred: the edit window shouldn't start counting down before anyone
    // has actually opened the link. GET /api/share/:id sets the real
    // timestamp on first load. Until then editWindowOpen() treats null as open.
    editUntil: null,
    editDays: MAX_EDIT_DAYS,
    finalized: false,
    mediaBytes: 0,
    createdAt: new Date().toISOString(),
  });

  console.log(`[share] created  ${id}`);
  res.json({ id, editUntil: null, bytesLimit: MEDIA_BYTES_LIMIT });
});

// ---------------------------------------------------------------------------
// POST /api/share/:id/ensure — create a share at a SPECIFIC id if it doesn't
// already exist (no-op otherwise, never overwrites). This is what
// 56moments.store's main server calls right after a WebCard order is paid,
// so the id it hands the customer is already real by the time they open it.
// ---------------------------------------------------------------------------
app.post('/api/share/:id/ensure', requireCreateSecret, express.json({ limit: '5mb' }), async (req, res) => {
  const id = safeId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  const existing = await readShare(id);
  if (existing) return res.json({ ok: true, existed: true });

  const { config, sides } = req.body ?? {};
  if (!config || !sides) return res.status(400).json({ error: 'config and sides are required' });

  await writeShare(id, {
    v: 1, config, sides,
    editUntil: null,
    editDays: MAX_EDIT_DAYS,
    finalized: false,
    mediaBytes: 0,
    createdAt: new Date().toISOString(),
  });

  console.log(`[share] ensured  ${id}`);
  res.json({ ok: true, existed: false });
});

// ---------------------------------------------------------------------------
// GET /api/share/:id — load share
// ---------------------------------------------------------------------------
app.get('/api/share/:id', async (req, res) => {
  let data = await readShare(req.params.id);
  if (!data) data = await selfHealShare(safeId(req.params.id));
  if (!data) return res.status(404).json({ error: 'not found' });

  // First view starts the edit-window countdown, not creation time — so a
  // creator who hasn't shared the link yet isn't burning down their own window.
  if (data.editUntil == null && data.editDays != null) {
    data.editUntil = new Date(Date.now() + data.editDays * 864e5).toISOString();
    await writeShare(req.params.id, data);
  }

  res.json({ ...data, bytesLimit: MEDIA_BYTES_LIMIT });
});

// ---------------------------------------------------------------------------
// PUT /api/share/:id — update share (within edit window)
// ---------------------------------------------------------------------------
app.put('/api/share/:id', express.json({ limit: '5mb' }), async (req, res) => {
  const data = await readShare(req.params.id);
  if (!data)                 return res.status(404).json({ error: 'not found' });
  if (data.finalized)        return res.status(403).json({ error: 'finalized' });
  if (!editWindowOpen(data)) return res.status(403).json({ error: 'edit window expired' });

  const { config, sides } = req.body ?? {};
  if (!config || !sides) return res.status(400).json({ error: 'config and sides required' });

  await writeShare(req.params.id, { ...data, config, sides });
  console.log(`[share] updated  ${req.params.id}`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/share/:id/upload-media — convert image → WebP / video+GIF → MP4, store to R2
// ---------------------------------------------------------------------------
app.post(
  '/api/share/:id/upload-media',
  express.raw({ type: '*/*', limit: '100mb' }),
  async (req, res) => {
    const shareData = await readShare(req.params.id);
    if (!shareData) {
      return res.status(404).json({ error: 'share not found' });
    }
    if (shareData.finalized) {
      return res.status(403).json({ error: 'finalized' });
    }

    // Reject before spending ffmpeg/sharp work on an upload that won't fit —
    // conservative pre-check using the raw upload size (converted output is
    // typically smaller, never larger, so this can't under-reject).
    const currentBytes = shareData.mediaBytes ?? 0;
    if (currentBytes + req.body.length > MEDIA_BYTES_LIMIT) {
      return res.status(413).json({
        error: 'storage limit reached',
        mediaBytes: currentBytes,
        bytesLimit: MEDIA_BYTES_LIMIT,
      });
    }

    const mime    = (req.headers['content-type'] ?? '').split(';')[0].trim()
                    || 'application/octet-stream';
    const hd      = req.query.hd === '1';
    const isVideo = mime.startsWith('video/');
    const isGif   = mime === 'image/gif';

    let converted;
    try {
      converted = isVideo
        ? await transcodeVideo(req.body, mime)
        : isGif
        ? await transcodeGif(req.body)
        : await convertImage(req.body, mime, hd);
    } catch (e) {
      if (e?.code === 'VIDEO_TOO_LONG') {
        return res.status(413).json({ error: `One video can be maximum ${MAX_VIDEO_SECONDS} seconds.` });
      }
      throw e;
    }
    const { body, contentType, ext } = converted;

    const slug = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    const url  = await storeMedia(safeId(req.params.id), slug, body, contentType);

    const mediaBytes = currentBytes + body.length;
    await writeShare(req.params.id, { ...shareData, mediaBytes });

    console.log(`[share] media    ${url}  (${contentType}, ${body.length} bytes, share total ${mediaBytes})`);
    res.json({ url, contentType, bytes: body.length, mediaBytes, bytesLimit: MEDIA_BYTES_LIMIT });
  }
);

// ---------------------------------------------------------------------------
// POST /api/share/:id/finalize — lock a share permanently (server-enforced)
// ---------------------------------------------------------------------------
app.post('/api/share/:id/finalize', async (req, res) => {
  const data = await readShare(req.params.id);
  if (!data) return res.status(404).json({ error: 'not found' });

  await writeShare(req.params.id, { ...data, finalized: true });
  console.log(`[share] finalized ${req.params.id}`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/share/:id/media — remove one uploaded file, reclaim its bytes
// Body: { key, bytes } — key must belong to this share (prevents cross-share
// deletion); only called for our own R2/local URLs, never external CDN URLs
// (e.g. Tenor-sourced GIFs, which cost nothing and aren't ours to delete).
// ---------------------------------------------------------------------------
app.delete('/api/share/:id/media', express.json({ limit: '1mb' }), async (req, res) => {
  const shareId = safeId(req.params.id);
  const data = await readShare(shareId);
  if (!data) return res.status(404).json({ error: 'not found' });
  if (data.finalized) return res.status(403).json({ error: 'finalized' });

  const { key, bytes } = req.body ?? {};
  if (typeof key !== 'string' || !key.startsWith(`${shareId}/`)) {
    return res.status(400).json({ error: 'invalid key' });
  }

  const slug = key.slice(shareId.length + 1);
  await deleteMediaObject(shareId, slug);

  const mediaBytes = Math.max(0, (data.mediaBytes ?? 0) - (Number(bytes) || 0));
  await writeShare(shareId, { ...data, mediaBytes });

  console.log(`[share] media deleted ${key} (share total ${mediaBytes})`);
  res.json({ ok: true, mediaBytes });
});

// ---------------------------------------------------------------------------
// GET /api/r2/:shareId/:file — proxy R2 media through server (adds CORS headers)
// Supports HTTP Range requests — required by mobile Safari for video playback.
// ---------------------------------------------------------------------------
app.get('/api/r2/:shareId/:file', async (req, res) => {
  if (!r2) return res.status(503).end();
  const key = `${safeId(req.params.shareId)}/${path.basename(req.params.file)}`;
  try {
    const params = { Bucket: R2_BUCKET, Key: key };
    const range  = req.headers['range'];
    if (range) params.Range = range;

    const obj = await r2.send(new GetObjectCommand(params));

    res.setHeader('Content-Type',   obj.ContentType    ?? 'application/octet-stream');
    res.setHeader('Accept-Ranges',  'bytes');
    res.setHeader('Cache-Control',  'public, max-age=31536000, immutable');
    if (obj.ContentLength) res.setHeader('Content-Length', String(obj.ContentLength));
    if (range && obj.ContentRange) {
      res.setHeader('Content-Range', obj.ContentRange);
      res.status(206);
    }
    obj.Body.pipe(res);
  } catch {
    res.status(404).end();
  }
});

// ---------------------------------------------------------------------------
// GET /api/media/:shareId/:file — serve local media (used when R2 not configured)
// ---------------------------------------------------------------------------
app.get('/api/media/:shareId/:file', (req, res) => {
  const filePath = path.join(
    MEDIA_DIR,
    safeId(req.params.shareId),
    path.basename(req.params.file),
  );
  if (!fs.existsSync(filePath)) return res.status(404).end();

  const ext = path.extname(req.params.file).toLowerCase();
  res.setHeader('Content-Type', MIME_BY_EXT[ext] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Accept-Ranges', 'bytes');
  // filePath is already absolute — passing root:'/' here doubled the drive
  // letter on Windows (C:\C:\Users\...), 404-ing every locally-served file.
  res.sendFile(filePath);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[share-server] running → http://localhost:${PORT}`);
  console.log(`[share-server] data dir → ${DATA_DIR}`);
});
