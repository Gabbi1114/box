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
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'share-data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const PORT      = Number(process.env.PORT ?? process.env.SHARE_PORT ?? 3001);
const MAX_EDIT_DAYS = Number(process.env.SHARE_MAX_EDIT_DAYS ?? 5);

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
// ffmpeg (video → WebM) — optional, graceful fallback if not installed
// ---------------------------------------------------------------------------
let ffmpegBin = null;
try {
  ffmpegBin = (await import('ffmpeg-static')).default;
  console.log('[share] ✓ ffmpeg loaded — video transcoding enabled');
} catch {
  console.warn('[share] ✗ ffmpeg-static not found — videos stored as-is');
}

const PASSTHROUGH_VIDEO = new Set(['video/mp4', 'video/webm', 'video/ogg']);

async function transcodeVideo(buf, mime) {
  const srcExt = EXT_BY_MIME[mime] ?? '.mp4';

  // MP4 and WebM are already browser-ready — skip transcoding for instant upload
  if (PASSTHROUGH_VIDEO.has(mime)) {
    console.log(`[share] video    pass-through  ${(buf.length / 1e6).toFixed(1)}MB (${mime})`);
    return { body: buf, contentType: mime, ext: srcExt };
  }

  if (!ffmpegBin) {
    return { body: buf, contentType: mime, ext: srcExt };
  }

  const tmpIn  = path.join(os.tmpdir(), `box-vin-${Date.now()}.tmp`);
  const tmpOut = path.join(os.tmpdir(), `box-vout-${Date.now()}.mp4`);

  try {
    fs.writeFileSync(tmpIn, buf);

    // H.264 MP4: universally supported (iOS, Android, desktop)
    // ultrafast preset makes encoding ~10× faster than VP9 on Render free tier
    await execFileAsync(ffmpegBin, [
      '-i', tmpIn,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',                 // good quality, small file
      '-an',                        // strip audio (box faces are silent looping clips)
      '-movflags', '+faststart',    // move MP4 metadata to front for instant streaming
      '-y', tmpOut,
    ], { timeout: 90_000 });

    const body = fs.readFileSync(tmpOut);
    console.log(`[share] video    transcode OK  ${(buf.length / 1e6).toFixed(1)}MB → ${(body.length / 1e6).toFixed(1)}MB`);
    return { body, contentType: 'video/mp4', ext: '.mp4' };
  } catch (e) {
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
    // 1600px is 1.5× the 3D texture resolution — plenty of detail, much faster to encode
    const maxSide = hd ? 2048 : 1600;
    const resized = img.resize({
      width:  meta.width  > maxSide ? maxSide : undefined,
      height: meta.height > maxSide ? maxSide : undefined,
      fit: 'inside', withoutEnlargement: true,
      kernel: sharp.kernel.lanczos3,
    });
    // WebP at effort:0 encodes ~10× faster than AVIF; still excellent quality + small files
    const webp = await resized.webp({ quality: hd ? 88 : 82, effort: 0 }).toBuffer();
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
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
app.post('/api/share', express.json({ limit: '5mb' }), async (req, res) => {
  const { config, sides } = req.body ?? {};
  if (!config || !sides) {
    return res.status(400).json({ error: 'config and sides are required' });
  }

  const id        = crypto.randomBytes(12).toString('base64url');
  const editUntil = new Date(Date.now() + MAX_EDIT_DAYS * 864e5).toISOString();

  await writeShare(id, {
    v: 1, config, sides,
    editUntil,
    createdAt: new Date().toISOString(),
  });

  console.log(`[share] created  ${id}`);
  res.json({ id, editUntil });
});

// ---------------------------------------------------------------------------
// GET /api/share/:id — load share
// ---------------------------------------------------------------------------
app.get('/api/share/:id', async (req, res) => {
  const data = await readShare(req.params.id);
  if (!data) return res.status(404).json({ error: 'not found' });
  res.json(data);
});

// ---------------------------------------------------------------------------
// PUT /api/share/:id — update share (within edit window)
// ---------------------------------------------------------------------------
app.put('/api/share/:id', express.json({ limit: '5mb' }), async (req, res) => {
  const data = await readShare(req.params.id);
  if (!data)                 return res.status(404).json({ error: 'not found' });
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
    if (!await readShare(req.params.id)) {
      return res.status(404).json({ error: 'share not found' });
    }

    const mime    = (req.headers['content-type'] ?? '').split(';')[0].trim()
                    || 'application/octet-stream';
    const hd      = req.query.hd === '1';
    const isVideo = mime.startsWith('video/');
    const isGif   = mime === 'image/gif';

    const { body, contentType, ext } = isVideo
      ? await transcodeVideo(req.body, mime)
      : isGif
      ? await transcodeGif(req.body)
      : await convertImage(req.body, mime, hd);

    const slug = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    const url  = await storeMedia(safeId(req.params.id), slug, body, contentType);

    console.log(`[share] media    ${url}  (${contentType}, ${body.length} bytes)`);
    res.json({ url, contentType });
  }
);

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
