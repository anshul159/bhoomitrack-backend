const { next } = require('../utils/numbering');

// Request numbers (BhoomiTrack Services, phase 0).
describe('reference numbers', () => {
  it('counts up from 1, padded to six digits, per prefix', async () => {
    expect(await next('SR')).toBe('SR-000001');
    expect(await next('SR')).toBe('SR-000002');
    expect(await next('DOC')).toBe('DOC-000001');
    expect(await next('SR')).toBe('SR-000003');
  });

  it('never hands out the same number twice under concurrency', async () => {
    // The first upsert is the racy moment: many callers find no counter at once.
    const numbers = await Promise.all(Array.from({ length: 50 }, () => next('SR')));
    expect(new Set(numbers).size).toBe(50);
    const seqs = numbers.map((n) => Number(n.slice(3))).sort((a, b) => a - b);
    expect(seqs[0]).toBe(1);
    expect(seqs[49]).toBe(50);
  });

  it('refuses a prefix that is not a short capitalised word', async () => {
    await expect(next('sr')).rejects.toThrow();
    await expect(next('')).rejects.toThrow();
    await expect(next('SR-1')).rejects.toThrow();
  });
});
