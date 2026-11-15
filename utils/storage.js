// Private file storage for the company file (BhoomiTrack Services, phase 0).
//
// Bill photos stay where they are (inline in the Attachment collection, capped at
// 600 KB). The company file needs PDFs up to 10 MB, which do not belong in a
// MongoDB document, so documents go to an object store: Cloudflare R2 in
// production, through its S3-compatible API, and an in-process map for tests and
// the throwaway local backend.
//
// Nothing here is ever public. There are no signed URLs and no public bucket:
// every download streams back through the API after the usual organisation check.
//
// Chosen by STORAGE_DRIVER ('r2' | 'memory'). When it is unset:
//   - under tests, and in development without the R2 variables → memory;
//   - in production without the R2 variables → none: uploads answer 503 with a
//     clear message, and the server still starts. A missing bucket must never be
//     the reason the whole API is down.

const { Readable } = require('stream');

const R2_VARS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

class StorageUnavailableError extends Error {
  constructor(message = 'Document storage is not set up yet. Please try again later.') {
    super(message);
    this.name = 'StorageUnavailableError';
    this.status = 503;
  }
}

// ─── memory ───────────────────────────────────────────────────────────────────
function memoryDriver() {
  const files = new Map();
  return {
    name: 'memory',
    async put(key, buffer, contentType) {
      files.set(key, { buffer: Buffer.from(buffer), contentType });
    },
    async getStream(key) {
      const f = files.get(key);
      if (!f) return null;
      return { stream: Readable.from([f.buffer]), contentType: f.contentType, size: f.buffer.length };
    },
    async delete(key) {
      files.delete(key);
    },
    // Tests only: how many objects are held, to prove deletion really deletes.
    _size: () => files.size,
    _has: (key) => files.has(key),
  };
}

// ─── r2 ───────────────────────────────────────────────────────────────────────
function r2Driver(env = process.env) {
  // Required lazily: the SDK is large, and tests never load it.
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
  const Bucket = env.R2_BUCKET;

  return {
    name: 'r2',
    async put(key, buffer, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: buffer, ContentType: contentType }));
    },
    async getStream(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return { stream: out.Body, contentType: out.ContentType, size: out.ContentLength };
      } catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

// ─── none ─────────────────────────────────────────────────────────────────────
function unavailableDriver() {
  const refuse = async () => { throw new StorageUnavailableError(); };
  return { name: 'none', put: refuse, getStream: refuse, delete: refuse };
}

/** Which driver the environment asks for. Pure, so the choice can be tested. */
function chooseDriver(env = process.env) {
  const asked = String(env.STORAGE_DRIVER || '').trim().toLowerCase();
  const hasR2 = R2_VARS.every((v) => Boolean(env[v]));
  if (asked === 'memory') return 'memory';
  if (asked === 'r2') return hasR2 ? 'r2' : 'none';
  if (hasR2) return 'r2';
  if (env.NODE_ENV === 'production') return 'none';
  return 'memory';
}

function createStorage(env = process.env) {
  switch (chooseDriver(env)) {
    case 'r2': return r2Driver(env);
    case 'memory': return memoryDriver();
    default: return unavailableDriver();
  }
}

let current = null;
/** The process-wide store, created on first use. */
function storage() {
  if (!current) {
    current = createStorage();
    if (current.name === 'none') {
      console.warn('[STORAGE] R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET). Document uploads will answer 503.');
    }
  }
  return current;
}

/** Tests only: replace the process-wide store. */
function _setStorage(s) { current = s; }

module.exports = {
  storage, createStorage, chooseDriver, memoryDriver, StorageUnavailableError, R2_VARS, _setStorage,
};
