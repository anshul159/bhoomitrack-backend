const {
  PRICING, priceFor, bestPlanFor, quoteForOrg, formatINR, rupeesToPaise,
} = require('../utils/pricing');

// The ladder is the whole product decision, so it is pinned here rather than left
// to a page of marketing copy that nothing checks.
describe('list prices', () => {
  it('charges the stated bundle price at exactly the included site count', () => {
    expect(priceFor('site', 'monthly', 1).totalPaise).toBe(rupeesToPaise(1500));
    expect(priceFor('contractor', 'monthly', 4).totalPaise).toBe(rupeesToPaise(2000));
    expect(priceFor('builder', 'monthly', 10).totalPaise).toBe(rupeesToPaise(5000));
    expect(priceFor('site', 'annual', 1).totalPaise).toBe(rupeesToPaise(12000));
    expect(priceFor('contractor', 'annual', 4).totalPaise).toBe(rupeesToPaise(20000));
    expect(priceFor('builder', 'annual', 10).totalPaise).toBe(rupeesToPaise(50000));
    expect(priceFor('founding', 'lifetime', 10).totalPaise).toBe(rupeesToPaise(100000));
  });

  it('bills the Contractor and Builder bundles at exactly ten months of monthly', () => {
    // "Pay for 10, get 12" — the reason the annual discount holds at every site
    // count on these two tiers instead of drifting between them.
    for (const plan of ['contractor', 'builder']) {
      expect(PRICING.annual[plan].basePaise).toBe(PRICING.monthly[plan].basePaise * 10);
    }
    // Overage carries the same rule, which is what keeps a 7-site annual customer
    // on the same discount as a 4-site one.
    expect(PRICING.annual.contractor.overagePerSitePaise)
      .toBe(PRICING.monthly.contractor.overagePerSitePaise * 10);
  });

  it('discounts the Site tier harder than the rest, deliberately', () => {
    // ₹12,000 is EIGHT months of ₹1,500, not ten — so a single-site customer gets
    // ~33% off for going annual while a Contractor gets ~17%. That is the reverse
    // of the usual shape (a bigger commitment normally earns the bigger discount)
    // and it is pinned here so it stays a decision rather than becoming a typo
    // somebody "corrects" later. See WEB-APP-PLAN D-W1.
    expect(PRICING.annual.site.basePaise).toBe(PRICING.monthly.site.basePaise * 8);
    const siteDiscount = 1 - PRICING.annual.site.basePaise / (PRICING.monthly.site.basePaise * 12);
    const contractorDiscount = 1 - PRICING.annual.contractor.basePaise / (PRICING.monthly.contractor.basePaise * 12);
    expect(siteDiscount).toBeGreaterThan(contractorDiscount);
  });

  it('reaches the next bundle price exactly, by overage alone', () => {
    // Contractor + 6 sites of overage must land on Builder to the rupee. If these
    // ever diverge, one of the two is the wrong number.
    expect(priceFor('contractor', 'monthly', 10).totalPaise).toBe(priceFor('builder', 'monthly', 10).totalPaise);
    expect(priceFor('contractor', 'annual', 10).totalPaise).toBe(priceFor('builder', 'annual', 10).totalPaise);
  });
});

describe('the ladder never inverts', () => {
  // The bug this exists to prevent: with overage priced above the bundle rate
  // (₹1,500 against ₹500), nine sites cost ₹9,500 a month and ten cost ₹5,000 —
  // so the cheapest thing a customer could do was invent a tenth site.
  it.each(['monthly', 'annual'])('never charges more for fewer sites (%s)', (cycle) => {
    let previous = -1;
    for (let sites = 1; sites <= 60; sites++) {
      const best = bestPlanFor(cycle, sites);
      expect(best).not.toBeNull();
      expect(best.totalPaise).toBeGreaterThanOrEqual(previous);
      previous = best.totalPaise;
    }
  });

  it('never prices overage above the bundle rate it sits on', () => {
    for (const [, plans] of Object.entries(PRICING)) {
      for (const [, tier] of Object.entries(plans)) {
        if (tier.overagePerSitePaise === null) continue;
        expect(tier.overagePerSitePaise).toBeLessThanOrEqual(tier.basePaise / tier.includedSites);
      }
    }
  });

  it('keeps every amount an integer number of paise', () => {
    for (const cycle of ['monthly', 'annual']) {
      for (const plan of Object.keys(PRICING[cycle])) {
        for (const sites of [1, 3, 7, 13, 41]) {
          expect(Number.isInteger(priceFor(plan, cycle, sites).totalPaise)).toBe(true);
        }
      }
    }
  });
});

describe('a capped tier', () => {
  it('refuses to price a site count it does not cover', () => {
    const over = priceFor('founding', 'lifetime', 11);
    expect(over.overCap).toBe(true);
    expect(over.totalPaise).toBeNull(); // never silently billed at zero
  });

  it('is not offered as the cheapest plan for a count it cannot serve', () => {
    expect(bestPlanFor('lifetime', 11)).toBeNull();
  });
});

describe('a negotiated price', () => {
  const org = (billing, plan = 'contractor') => ({ plan, billing });

  it('applies an agreed per-site rate instead of the bundle', () => {
    // "We said ₹1,500 and settled on ₹999."
    const q = quoteForOrg(org({ cycle: 'monthly', pricePerSitePaise: rupeesToPaise(999) }), 7);
    expect(q.totalPaise).toBe(rupeesToPaise(999 * 7));
    expect(q.basis).toBe('negotiated_per_site');
    expect(q.listPaise).toBe(rupeesToPaise(3500)); // what they would have paid
  });

  it('reads an agreed per-site rate as PER MONTH even on an annual cycle', () => {
    // The rate people say out loud is monthly ("₹999 a site"). Billing an annual
    // customer ₹999 x sites for the YEAR would undercharge by twelve times, and
    // it is the kind of mistake nobody notices until the year is over.
    const q = quoteForOrg(org({ cycle: 'annual', pricePerSitePaise: rupeesToPaise(999) }), 7);
    expect(q.totalPaise).toBe(rupeesToPaise(999 * 7 * 12));
    expect(q.months).toBe(12);
  });

  it('refuses to turn a per-site rate into a lifetime price', () => {
    // A lifetime has no number of months to multiply by. Better to price nothing
    // than to price a guess.
    const q = quoteForOrg(org({ cycle: 'lifetime', pricePerSitePaise: rupeesToPaise(999) }, 'founding'), 7);
    expect(q.totalPaise).toBeNull();
    expect(q.basis).toBe('per_site_rate_on_lifetime');
  });

  it('applies an agreed round total whatever the site count', () => {
    // "Just make it ₹40,000 for the year" — a real handshake that is not any
    // per-site rate times any site count.
    const terms = { cycle: 'annual', flatAmountPaise: rupeesToPaise(40000) };
    expect(quoteForOrg(org(terms), 4).totalPaise).toBe(rupeesToPaise(40000));
    expect(quoteForOrg(org(terms), 9).totalPaise).toBe(rupeesToPaise(40000));
  });

  it('lets a flat total win over a per-site rate when both are set', () => {
    const q = quoteForOrg(org({
      cycle: 'annual',
      pricePerSitePaise: rupeesToPaise(999),
      flatAmountPaise: rupeesToPaise(40000),
    }), 9);
    expect(q.totalPaise).toBe(rupeesToPaise(40000));
    expect(q.basis).toBe('negotiated_flat');
  });

  it('falls back to the list price when nothing was negotiated', () => {
    const q = quoteForOrg(org({ cycle: 'monthly' }), 4);
    expect(q.basis).toBe('list');
    expect(q.totalPaise).toBe(rupeesToPaise(2000));
  });
});

describe('formatting', () => {
  it('groups rupees the Indian way', () => {
    expect(formatINR(rupeesToPaise(100000))).toBe('₹1,00,000');
    expect(formatINR(rupeesToPaise(1500))).toBe('₹1,500');
    expect(formatINR(null)).toBe('—');
  });

  it('converts rupees to paise without floating-point drift', () => {
    expect(rupeesToPaise(999.99)).toBe(99999);
    expect(rupeesToPaise(0.1) + rupeesToPaise(0.2)).toBe(30);
  });
});
