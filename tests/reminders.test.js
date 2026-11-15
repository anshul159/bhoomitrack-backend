const Organization = require('../models/Organization');
const CompanyDocument = require('../models/CompanyDocument');
const { sendServiceReminders, stepFor } = require('../utils/reminders');
const { createWorld, createOrg, createOwner } = require('./helpers/factories');

// Expiry and due-date reminders (BhoomiTrack Services, plan §8 phase 1 step 5),
// driven with a fake clock.

// 10:00 India on a given day.
const at = (day) => new Date(`${day}T04:30:00Z`);
const expiring = (org, expires, extra = {}) => CompanyDocument.create({
  orgId: org._id, slot: 'labour.licence', title: 'Labour licence', files: [],
  expires_on: new Date(`${expires}T00:00:00Z`), ...extra,
});

describe('which reminder a paper is due', () => {
  it('steps at 30, 7 and 1 days, and stops once expired', () => {
    expect(stepFor(31)).toBeNull();
    expect(stepFor(30)).toBe(30);
    expect(stepFor(8)).toBe(30);
    expect(stepFor(7)).toBe(7);
    expect(stepFor(2)).toBe(7);
    expect(stepFor(1)).toBe(1);
    expect(stepFor(0)).toBe(1);
    expect(stepFor(-1)).toBeNull();
  });
});

describe('expiry reminders', () => {
  it('sends at 30, 7 and 1 days before, each once, to the owners', async () => {
    const { org } = await createWorld();
    await expiring(org, '2026-12-31');
    const send = jest.fn().mockResolvedValue();

    for (const [day, expected] of [
      ['2026-11-30', 0],   // 31 days
      ['2026-12-01', 1],   // 30 days
      ['2026-12-01', 0],   // the same day again: already claimed
      ['2026-12-10', 0],   // 21 days: between steps
      ['2026-12-24', 1],   // 7 days
      ['2026-12-30', 1],   // 1 day
      ['2026-12-31', 0],   // the day itself was covered by the 1-day one
      ['2027-01-02', 0],   // expired
    ]) {
      const { expiries } = await sendServiceReminders({ now: at(day), send });
      expect([day, expiries]).toEqual([day, expected]);
    }
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map((c) => c[1])).toEqual([
      'Labour licence expires in 30 days', 'Labour licence expires in 7 days', 'Labour licence expires tomorrow',
    ]);
    expect(send.mock.calls[0][0]).toHaveLength(1);         // the one owner
    expect(send.mock.calls[0][3]).toMatchObject({ type: 'company_document_expiry' });
  });

  it('never sends a 30-day reminder after a later one', async () => {
    const { org } = await createWorld();
    await expiring(org, '2026-12-20');                     // first seen at 5 days
    const send = jest.fn().mockResolvedValue();
    await sendServiceReminders({ now: at('2026-12-15'), send });
    await sendServiceReminders({ now: at('2026-12-16'), send });
    // (Advance tax falls on 15 Dec too; only the expiry pushes are counted here.)
    const expiry = send.mock.calls.filter((c) => c[3].type === 'company_document_expiry');
    expect(expiry.map((c) => c[1])).toEqual(['Labour licence expires in 5 days']);
  });

  it('starts again for a renewed paper with a new date', async () => {
    const { org } = await createWorld();
    const doc = await expiring(org, '2026-12-08');
    const send = jest.fn().mockResolvedValue();
    await sendServiceReminders({ now: at('2026-12-01'), send });
    await CompanyDocument.updateOne({ _id: doc._id }, { expires_on: new Date('2027-01-07T00:00:00Z') });
    await sendServiceReminders({ now: at('2026-12-08'), send });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('skips papers with no expiry rule, not-needed marks, replaced papers and lapsed organisations', async () => {
    const { org } = await createWorld();
    await expiring(org, '2026-12-08', { slot: 'company.pan' });           // a PAN does not expire
    await expiring(org, '2026-12-08', { status: 'replaced' });
    await expiring(org, '2026-12-08', { not_needed: true });
    const lapsed = await createOrg({ status: 'suspended' });
    await createOwner(lapsed);
    await expiring(lapsed, '2026-12-08');
    const send = jest.fn().mockResolvedValue();
    const { expiries } = await sendServiceReminders({ now: at('2026-12-01'), send });
    expect(expiries).toBe(0);
  });

  it('waits until 9 am India time', async () => {
    const { org } = await createWorld();
    await expiring(org, '2026-12-31');
    const send = jest.fn().mockResolvedValue();
    await sendServiceReminders({ now: new Date('2026-12-01T02:00:00Z'), send });   // 7:30 am
    expect(send).not.toHaveBeenCalled();
    await sendServiceReminders({ now: new Date('2026-12-01T04:00:00Z'), send });   // 9:30 am
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('claims once even when two runs race', async () => {
    const { org } = await createWorld();
    await expiring(org, '2026-12-31');
    const send = jest.fn().mockResolvedValue();
    await Promise.all([1, 2, 3].map(() => sendServiceReminders({ now: at('2026-12-01'), send })));
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('due-date reminders', () => {
  it('reminds a GST-registered business three days before GSTR-3B, once', async () => {
    const { org } = await createWorld();
    await Organization.updateOne({ _id: org._id }, { 'profile.gstin': '27AAPFU0939F1ZV' });
    const send = jest.fn().mockResolvedValue();
    await sendServiceReminders({ now: at('2026-11-16'), send });       // 4 days before the 20th
    expect(send.mock.calls.map((c) => c[1])).not.toContain('GSTR-3B (tax payment) is due in 3 days');
    await sendServiceReminders({ now: at('2026-11-17'), send });
    await sendServiceReminders({ now: at('2026-11-18'), send });
    const gst = send.mock.calls.filter((c) => /GSTR-3B/.test(c[1]));
    expect(gst.map((c) => c[1])).toEqual(['GSTR-3B (tax payment) is due in 3 days']);
  });

  it('does not push universal dates to a business that has told us nothing', async () => {
    await createWorld();
    const send = jest.fn().mockResolvedValue();
    await sendServiceReminders({ now: at('2026-12-13'), send });       // 2 days before advance tax
    expect(send).not.toHaveBeenCalled();
  });
});
