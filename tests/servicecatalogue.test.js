const { DOORS, SERVICES, FIELD_TYPES, catalogueFor } = require('../config/serviceCatalogue');

// The rules the catalogue must keep (plan §5.1 and §6.1). A failure here means an
// entry would break a promise the plan makes to the owner, or the law (§4).
describe('the service catalogue', () => {
  it('has exactly the six fixed doors', () => {
    expect(DOORS.map((d) => d.id)).toEqual(['materials', 'insurance', 'credit', 'tax', 'compliance', 'experts']);
  });

  it('gives every service a unique id, prefixed by its door', () => {
    const ids = SERVICES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SERVICES) {
      expect(DOORS.map((d) => d.id)).toContain(s.door);
      expect(s.id.startsWith(`${s.door}.`)).toBe(true);
    }
  });

  it('never lists more than eight visible services behind a door', () => {
    for (const d of DOORS) {
      const n = SERVICES.filter((s) => s.door === d.id && s.status !== 'hidden').length;
      expect([d.id, n <= 8]).toEqual([d.id, true]);
    }
  });

  it('never asks more than five questions in a request form', () => {
    for (const s of SERVICES) expect([s.id, s.needs.length <= 5]).toEqual([s.id, true]);
  });

  it('uses only known field types, and every choice has options', () => {
    for (const s of SERVICES) {
      const keys = s.needs.map((n) => n.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const n of s.needs) {
        expect(FIELD_TYPES).toContain(n.type);
        expect(typeof n.label).toBe('string');
        if (n.type === 'choice') expect(n.options.length).toBeGreaterThan(1);
      }
    }
  });

  it('refuses a regulated service that is live without a named licensed partner', () => {
    for (const s of SERVICES) {
      if (s.regulated && s.status === 'live') {
        expect([s.id, Boolean(s.partner?.name && s.partner?.licence_no)]).toEqual([s.id, true]);
      }
    }
  });

  it('keeps every insurance and credit service at interest until a partner is signed', () => {
    for (const s of SERVICES.filter((x) => x.door === 'insurance' || x.door === 'credit')) {
      expect(s.regulated).toBe(s.door === 'insurance' ? 'insurance' : 'credit');
      expect([s.id, s.status]).toEqual([s.id, 'interest']);
    }
  });

  it('says who does the work, what it costs and what will be shared, before Request', () => {
    for (const s of SERVICES) {
      expect([s.id, Boolean(s.who && s.cost && s.price_hint)]).toEqual([s.id, true]);
      expect(s.shares.length).toBeGreaterThan(0);
      expect(s.about.length).toBeGreaterThan(0);
    }
  });

  it('never calls a service free (plan §5.7: a partner may be paying us for it)', () => {
    for (const s of SERVICES) {
      expect([s.id, /\bfree\b/i.test(`${s.price_hint} ${s.cost}`)]).toEqual([s.id, false]);
    }
  });

  it('has the phase 1 services live: doors 4, 5 and 6, and material quotes', () => {
    const live = SERVICES.filter((s) => s.status === 'live').map((s) => s.id);
    expect(live).toContain('materials.quote');
    expect(live).toContain('tax.gst_filing');
    expect(live).toContain('compliance.labour_licence');
    expect(live).toContain('experts.lawyer');
  });

  it('sends the app the doors with counts, and no hidden service', () => {
    const c = catalogueFor({});
    expect(c.doors).toHaveLength(6);
    expect(c.doors.find((d) => d.id === 'credit').service_count).toBe(6);
    expect(c.services.every((s) => s.status !== 'hidden')).toBe(true);
    expect(c.services[0]).toHaveProperty('needs');
  });
});
