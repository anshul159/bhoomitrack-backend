// Pricing and quoting (ENH-003).
//
// There is still no payment provider. What this file supplies is the other half:
// what a given organisation owes, so an operator can raise an invoice, take the
// money out of band, and mark the period paid. Nothing here charges anyone.
//
// Two rules shape the whole table:
//
//   1. Money is INTEGER PAISE. Inventory cost is a float because it is an estimate
//      someone typed; an invoice is a document handed to an accountant, and
//      `999 * 7 * 12` must not depend on floating point.
//   2. OVERAGE IS PRICED AT THE BUNDLE RATE, never above it. Priced above, the
//      ladder inverts: at ₹1,500/site overage a 9-site customer would pay ₹9,500
//      a month against ₹5,000 for a 10-site customer, and the rational move would
//      be to invent a tenth site. Tests pin this.
//
// The annual figures are exactly ten months of the monthly ones — "pay for 10,
// get 12" — which is why the discount holds at every site count rather than
// drifting between tiers.

const CYCLES = ['monthly', 'annual', 'lifetime'];

// basePaise covers includedSites; every site beyond costs overagePerSitePaise.
const PRICING = {
  monthly: {
    site:       { includedSites: 1,  basePaise:   150000, overagePerSitePaise:  50000 },
    contractor: { includedSites: 4,  basePaise:   200000, overagePerSitePaise:  50000 },
    builder:    { includedSites: 10, basePaise:   500000, overagePerSitePaise:  50000 },
  },
  annual: {
    site:       { includedSites: 1,  basePaise:  1200000, overagePerSitePaise: 500000 },
    contractor: { includedSites: 4,  basePaise:  2000000, overagePerSitePaise: 500000 },
    builder:    { includedSites: 10, basePaise:  5000000, overagePerSitePaise: 500000 },
  },
  // One payment, no expiry. `Organization.isActive()` already returns true forever
  // for an active org with a null currentPeriodEnd, so this needed no new gate.
  //
  // Capped at 10 sites on purpose: uncapped, the customers worth the most recurring
  // revenue are exactly the ones who would take it, and their lifetime value would
  // be fixed at one payment while their servers and support are not.
  lifetime: {
    founding:   { includedSites: 10, basePaise: 10000000, overagePerSitePaise:  null },
  },
};

const PLAN_LABELS = {
  trial: 'Trial',
  site: 'Site',
  contractor: 'Contractor',
  builder: 'Builder',
  founding: 'Founding',
  standard: 'Standard (legacy)',
};

const rupeesToPaise = (rupees) => Math.round(Number(rupees) * 100);

// Indian digit grouping — ₹1,00,000, not ₹100,000. A contractor reads the first.
function formatINR(paise) {
  if (paise === null || paise === undefined) return '—';
  const rupees = paise / 100;
  const whole = Number.isInteger(rupees);
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * List price for a plan at a site count. Pure — no database, no org.
 * Returns null for a plan/cycle pair that does not exist (e.g. monthly founding).
 */
function priceFor(plan, cycle, siteCount) {
  const tier = PRICING[cycle] && PRICING[cycle][plan];
  if (!tier) return null;

  const sites = Math.max(0, Math.floor(siteCount || 0));
  const overageSites = Math.max(0, sites - tier.includedSites);

  // A capped tier has no overage rate: extra sites are refused a price rather
  // than silently billed at zero.
  if (overageSites > 0 && tier.overagePerSitePaise === null) {
    return {
      plan, cycle, siteCount: sites,
      includedSites: tier.includedSites,
      basePaise: tier.basePaise,
      overageSites,
      overagePaise: null,
      totalPaise: null,
      overCap: true,
    };
  }

  const overagePaise = overageSites * (tier.overagePerSitePaise || 0);
  return {
    plan, cycle, siteCount: sites,
    includedSites: tier.includedSites,
    basePaise: tier.basePaise,
    overageSites,
    overagePaise,
    totalPaise: tier.basePaise + overagePaise,
    overCap: false,
  };
}

/**
 * The cheapest tier for a site count on a cycle. Used to tell a customer they are
 * on the wrong plan before they work it out themselves and resent it.
 */
function bestPlanFor(cycle, siteCount) {
  const plans = Object.keys(PRICING[cycle] || {});
  let best = null;
  for (const plan of plans) {
    const p = priceFor(plan, cycle, siteCount);
    if (!p || p.totalPaise === null) continue;
    if (!best || p.totalPaise < best.totalPaise) best = p;
  }
  return best;
}

/**
 * What THIS organisation owes, honouring anything negotiated with them.
 *
 * Precedence, highest first:
 *   billing.flatAmountPaise    — a handshake that landed on a round total, per cycle
 *   billing.pricePerSitePaise  — a negotiated unit rate, applied flat (no bundle)
 *   the list price for org.plan
 *
 * Both override fields exist because a negotiation genuinely ends either way, and
 * forcing a round total back into a per-site rate invents figures like ₹1,428.57.
 *
 * `pricePerSitePaise` is ALWAYS PER SITE PER MONTH, whatever the cycle — because
 * that is the number people say out loud ("we agreed ₹999 a site") and quoting it
 * per cycle instead would undercharge an annual customer by twelve times. An
 * annual cycle multiplies by 12; no bundle discount is applied on top, since the
 * rate is already the negotiated one.
 */
const MONTHS_IN_CYCLE = { monthly: 1, annual: 12 };
function quoteForOrg(org, siteCount) {
  const billing = org.billing || {};
  const cycle = billing.cycle || 'monthly';
  const sites = Math.max(0, Math.floor(siteCount || 0));

  if (billing.flatAmountPaise !== null && billing.flatAmountPaise !== undefined) {
    return {
      plan: org.plan, cycle, siteCount: sites,
      totalPaise: billing.flatAmountPaise,
      basis: 'negotiated_flat',
      listPaise: (priceFor(org.plan, cycle, sites) || {}).totalPaise ?? null,
    };
  }

  if (billing.pricePerSitePaise !== null && billing.pricePerSitePaise !== undefined) {
    const months = MONTHS_IN_CYCLE[cycle];
    return {
      plan: org.plan, cycle, siteCount: sites,
      // A lifetime cycle has no number of months to multiply by, so a per-site
      // rate cannot express it. Say so rather than invent a total.
      totalPaise: months ? billing.pricePerSitePaise * sites * months : null,
      basis: months ? 'negotiated_per_site' : 'per_site_rate_on_lifetime',
      perSitePaise: billing.pricePerSitePaise,
      months: months || null,
      listPaise: (priceFor(org.plan, cycle, sites) || {}).totalPaise ?? null,
    };
  }

  const list = priceFor(org.plan, cycle, sites);
  if (!list) {
    return { plan: org.plan, cycle, siteCount: sites, totalPaise: null, basis: 'no_list_price' };
  }
  return { ...list, basis: 'list', listPaise: list.totalPaise };
}

module.exports = {
  PRICING, PLAN_LABELS, CYCLES, MONTHS_IN_CYCLE,
  priceFor, bestPlanFor, quoteForOrg,
  formatINR, rupeesToPaise,
};
