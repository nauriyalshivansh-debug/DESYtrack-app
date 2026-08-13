// Pluggable object storage for sample attachments.
// - If S3-compatible env vars are set (AWS S3, Cloudflare R2, Backblaze B2, MinIO…),
//   files are uploaded straight from the browser to the bucket via presigned PUT
//   URLs and downloaded via presigned GET URLs — the server never proxies the bytes,
//   so large beamline datasets are fine and files persist independently of the app.
// - Otherwise it falls back to local disk under data/uploads. That works for a demo
//   but is EPHEMERAL on hosts like Render's free tier (wiped on redeploy/restart).
//
// Enable real storage by setting: S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
// and (for R2/B2/MinIO) S3_ENDPOINT; optionally S3_REGION (default 'auto').
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const S3_BUCKET   = process.env.S3_BUCKET;
const S3_ENDPOINT = process.env.S3_ENDPOINT || undefined;      // e.g. https://<acct>.r2.cloudflarestorage.com
const S3_REGION   = process.env.S3_REGION || 'auto';
const S3_KEY      = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET   = process.env.S3_SECRET_ACCESS_KEY;

const useS3   = !!(S3_BUCKET && S3_KEY && S3_SECRET);
const mode    = useS3 ? 's3' : 'local';
const LOCAL_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
const SIGN_TTL = 900; // seconds

let s3 = null, PutObjectCommand, GetObjectCommand, getSignedUrl;
if (useS3) {
  const { S3Client, PutObjectCommand: POC, GetObjectCommand: GOC } = require('@aws-sdk/client-s3');
  ({ getSignedUrl } = require('@aws-sdk/s3-request-presigner'));
  PutObjectCommand = POC; GetObjectCommand = GOC;
  s3 = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: !!S3_ENDPOINT,   // needed by MinIO and some S3-compatibles
    credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET },
  });
} else {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
}

function newKey(sampleId, filename) {
  const safe = String(filename || 'file').replace(/[^\w.\-]+/g, '_').slice(-80);
  return `samples/${sampleId}/${crypto.randomUUID()}-${safe}`;
}

// Returns how the browser should upload: { mode, url, method, headers }
async function presignPut(key, contentType) {
  const ct = contentType || 'application/octet-stream';
  if (useS3) {
    const url = await getSignedUrl(s3,
      new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: ct }),
      { expiresIn: SIGN_TTL });
    return { mode, url, method: 'PUT', headers: { 'Content-Type': ct } };
  }
  return { mode, url: '/api/uploads/local?key=' + encodeURIComponent(key), method: 'PUT', headers: { 'Content-Type': ct } };
}

// For S3, a presigned GET URL (browser fetches straight from the bucket). Local returns null.
async function presignGet(key, filename) {
  if (!useS3) return null;
  return getSignedUrl(s3,
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key,
      ResponseContentDisposition: `attachment; filename="${String(filename || 'file').replace(/"/g, '')}"` }),
    { expiresIn: SIGN_TTL });
}

// ---- local-disk helpers (fallback mode only) ----
function localPath(key) { return path.join(LOCAL_DIR, key.replace(/\.\.(\/|\\)/g, '')); }
function saveLocal(key, buf) { const p = localPath(key); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
function existsLocal(key) { try { return fs.existsSync(localPath(key)); } catch { return false; } }
function readLocalStream(key) { return fs.createReadStream(localPath(key)); }

module.exports = { mode, useS3, newKey, presignPut, presignGet, saveLocal, existsLocal, readLocalStream, LOCAL_DIR };
