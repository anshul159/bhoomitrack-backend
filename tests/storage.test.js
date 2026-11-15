const { createStorage, chooseDriver, memoryDriver, StorageUnavailableError } = require('../utils/storage');

// The company file's private object store (BhoomiTrack Services, phase 0).

const R2 = {
  R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: 'bucket',
};

const readAll = async (stream) => {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
};

describe('choosing a storage driver', () => {
  it('uses memory under tests and in development without R2', () => {
    expect(chooseDriver({ NODE_ENV: 'test' })).toBe('memory');
    expect(chooseDriver({ NODE_ENV: 'development' })).toBe('memory');
    expect(chooseDriver({})).toBe('memory');
  });

  it('uses R2 whenever all four variables are present', () => {
    expect(chooseDriver({ NODE_ENV: 'production', ...R2 })).toBe('r2');
    expect(chooseDriver({ NODE_ENV: 'development', ...R2 })).toBe('r2');
  });

  it('refuses rather than falling back to memory in production without R2', () => {
    // Memory in production would accept a customer's licence and lose it on the
    // next deploy, which is worse than saying "not yet".
    expect(chooseDriver({ NODE_ENV: 'production' })).toBe('none');
    expect(chooseDriver({ NODE_ENV: 'production', R2_ACCOUNT_ID: 'a', R2_BUCKET: 'b' })).toBe('none');
  });

  it('honours STORAGE_DRIVER, but never R2 without its variables', () => {
    expect(chooseDriver({ NODE_ENV: 'production', STORAGE_DRIVER: 'memory' })).toBe('memory');
    expect(chooseDriver({ STORAGE_DRIVER: 'r2' })).toBe('none');
    expect(chooseDriver({ STORAGE_DRIVER: 'R2', ...R2 })).toBe('r2');
  });
});

describe('the memory driver', () => {
  it('stores, streams back and deletes exactly the bytes given', async () => {
    const s = memoryDriver();
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);
    await s.put('org/1/doc/2/abc', bytes, 'application/pdf');

    const got = await s.getStream('org/1/doc/2/abc');
    expect(got.contentType).toBe('application/pdf');
    expect(got.size).toBe(bytes.length);
    expect((await readAll(got.stream)).equals(bytes)).toBe(true);

    await s.delete('org/1/doc/2/abc');
    expect(await s.getStream('org/1/doc/2/abc')).toBeNull();
    expect(s._size()).toBe(0);
  });

  it('keeps its own copy, so a caller reusing its buffer changes nothing stored', async () => {
    const s = memoryDriver();
    const bytes = Buffer.from('hello');
    await s.put('k', bytes, 'text/plain');
    bytes.fill(0);
    expect((await readAll((await s.getStream('k')).stream)).toString()).toBe('hello');
  });

  it('answers null for a key that was never stored, and deleting one is harmless', async () => {
    const s = memoryDriver();
    expect(await s.getStream('nope')).toBeNull();
    await expect(s.delete('nope')).resolves.toBeUndefined();
  });
});

describe('with no storage configured', () => {
  it('every operation refuses with a 503 and a message a person can read', async () => {
    const s = createStorage({ NODE_ENV: 'production' });
    expect(s.name).toBe('none');
    for (const op of [() => s.put('k', Buffer.from('x'), 'text/plain'), () => s.getStream('k'), () => s.delete('k')]) {
      const err = await op().catch((e) => e);
      expect(err).toBeInstanceOf(StorageUnavailableError);
      expect(err.status).toBe(503);
      expect(err.message).toMatch(/not set up/);
    }
  });

  it('creating the R2 driver needs no network, so the server still starts', () => {
    const s = createStorage({ NODE_ENV: 'production', ...R2 });
    expect(s.name).toBe('r2');
  });
});
