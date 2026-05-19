/**
 * Explosion Box Studio — Share Server
 * Port 3001 | Handles share persistence + image → AVIF conversion + R2 upload
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

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
const R2_ACCOUNT_ID    = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_KEY    = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET        = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL    = process.env.R2_PUBLIC_URL?.replace(/\/$/, ''); // no trailing slash

const r2 = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_KEY && R2_BUCKET
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_KEY },
    })
  : null;

if (r2) {
  console.log(`[share] ✓ R2 enabled — bucket: ${R2_BUCKET}`);
} else {
  console.warn('[share] ✗ R2 not configured — media stored on local disk');
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
    return `${R2_PUBLIC_URL}/${key}`;
  }

  // Local fallback
  const dir = path.join(MEDIA_DIR, shareId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, slug), body);
  const base = process.env.PUBLIC_API_BASE ?? `http://localhost:${PORT}`;
  return `${base}/api/media/${shareId}/${slug}`;
}

// ---------------------------------------------------------------------------
// Sharp (AVIF conversion) — optional, graceful fallback if not installed
// ---------------------------------------------------------------------------
let sharp = null;
try {
  sharp = (await import('sharp')).default;
  console.log('[share] ✓ sharp loaded — AVIF conversion enabled');
} catch {
  console.warn('[share] ✗ sharp not found — images stored as-is');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const safeId  = (id) => path.basename(String(id)).replace(/[^a-zA-Z0-9_-]/g, '');
const jsonPath = (id) => path.join(DATA_DIR, `${safeId(id)}.json`);

function readShare(id) {
  try { return JSON.parse(fs.readFileSync(jsonPath(id), 'utf8')); }
  catch { return null; }
}

function writeShare(id, data) {
  fs.writeFileSync(jsonPath(id), JSON.stringify(data, null, 2), 'utf8');
}

function editWindowOpen(share) {
  return !share.editUntil || new Date(share.editUntil) > new Date();
}

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/avif': '.avif',
  'video/mp4': '.mp4',  'video/webm': '.webm',
};
const MIME_BY_EXT = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m])
);

async function convertImage(buf, mime, hd = false) {
  if (mime === 'image/gif' || !sharp) {
    return { body: buf, contentType: mime, ext: EXT_BY_MIME[mime] ?? '.bin' };
  }
  try {
    const img     = sharp(buf, { failOn: 'none' }).rotate();
    const meta    = await img.metadata();
    const maxSide = hd ? 2560 : 2200;
    const resized = img.resize({
      width:  meta.width  > maxSide ? maxSide : undefined,
      height: meta.height > maxSide ? maxSide : undefined,
      fit: 'inside', withoutEnlargement: true,
      kernel: sharp.kernel.lanczos3,
    });
    const avif = await resized.avif({ quality: hd ? 70 : 62, effort: 4 }).toBuffer();
    return { body: avif, contentType: 'image/avif', ext: '.avif' };
  } catch (e) {
    console.warn('[share] AVIF conversion failed, storing original:', e.message);
    return { body: buf, contentType: mime, ext: EXT_BY_MIME[mime] ?? '.bin' };
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// POST /api/share — create new share
// ---------------------------------------------------------------------------
app.post('/api/share', express.json({ limit: '25mb' }), (req, res) => {
  const { config, sides } = req.body ?? {};
  if (!config || !sides) {
    return res.status(400).json({ error: 'config and sides are required' });
  }

  const id       = crypto.randomBytes(12).toString('base64url');
  const editUntil = new Date(Date.now() + MAX_EDIT_DAYS * 864e5).toISOString();

  writeShare(id, {
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
app.get('/api/share/:id', (req, res) => {
  const data = readShare(req.params.id);
  if (!data) return res.status(404).json({ error: 'not found' });
  res.json(data);
});

// ---------------------------------------------------------------------------
// PUT /api/share/:id — update share (within edit window)
// ---------------------------------------------------------------------------
app.put('/api/share/:id', express.json({ limit: '25mb' }), (req, res) => {
  const data = readShare(req.params.id);
  if (!data)              return res.status(404).json({ error: 'not found' });
  if (!editWindowOpen(data)) return res.status(403).json({ error: 'edit window expired' });

  const { config, sides } = req.body ?? {};
  if (!config || !sides) return res.status(400).json({ error: 'config and sides required' });

  writeShare(req.params.id, { ...data, config, sides });
  console.log(`[share] updated  ${req.params.id}`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/share/:id/upload-media — convert image → AVIF, store to R2 or disk
// ---------------------------------------------------------------------------
app.post(
  '/api/share/:id/upload-media',
  express.raw({ type: '*/*', limit: '30mb' }),
  async (req, res) => {
    if (!readShare(req.params.id)) {
      return res.status(404).json({ error: 'share not found' });
    }

    const mime = (req.headers['content-type'] ?? '').split(';')[0].trim()
                 || 'application/octet-stream';
    const hd   = req.query.hd === '1';

    const { body, contentType, ext } = await convertImage(req.body, mime, hd);

    const slug = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    const url  = await storeMedia(safeId(req.params.id), slug, body, contentType);

    console.log(`[share] media    ${url}  (${contentType}, ${body.length} bytes)`);
    res.json({ url, contentType });
  }
);

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
  res.sendFile(filePath, { root: '/' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[share-server] running → http://localhost:${PORT}`);
  console.log(`[share-server] data dir → ${DATA_DIR}`);
});
