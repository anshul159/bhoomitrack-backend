// The company file's slots (BhoomiTrack Services, plan §5.3 and §6.3): every
// registration, licence and policy a contracting business should hold, and when
// each one applies.
//
// THESE ARE PROMPTS, NOT LEGAL ADVICE. The thresholds follow the research in plan
// §4.7, which is recent (the labour codes came into force on 21 Nov 2025) and in
// places disputed. The partner CA signs this file off before phase 1 ships, and
// every rule carries its `basis` so the person reviewing it can check it. The app
// words them as "usually needed".
//
// A rule:
//   slot        stable id, stored on CompanyDocument.slot
//   group       the heading it is listed under
//   applies(p)  pure: does it apply to this profile? `p` is presentProfile() plus
//               `workers` (own + contract)
//   asks        profile fields applies() depends on. Until every one is known the
//               slot is not shown, and the field is offered as a question instead
//               (plan §5.1 rule 4: ask late, never up front)
//   expires     whether the paper has an expiry date to watch
//   multiple    several papers fill it (one RC per vehicle, three years of ITRs)
//   per         'site': one row per site
//   service_id  the catalogue entry behind "Get this done for me", or null

const GROUPS = [
  { id: 'company', title: 'Company' },
  { id: 'tax', title: 'Tax' },
  { id: 'labour', title: 'Labour' },
  { id: 'insurance', title: 'Insurance' },
  { id: 'vehicles', title: 'Vehicles & machines' },
  { id: 'sites', title: 'Sites' },
];

// States and UTs that levy professional tax (verify with the CA: this changes).
const PROFESSIONAL_TAX_STATES = [
  'AP', 'AS', 'BR', 'GJ', 'JH', 'KA', 'KL', 'MP', 'MH', 'MN', 'ML', 'MZ', 'NL', 'OR', 'PY', 'SK', 'TN', 'TG', 'TR', 'WB',
];

const WORKERS = ['own_workers', 'contract_workers'];
const always = () => true;
const government = (p) => p.client_types.includes('government');

const RULES = [
  // ─── Company ──────────────────────────────────────────────────────────────
  { slot: 'company.pan', group: 'company', title: 'PAN card', applies: always, asks: [], expires: false,
    service_id: 'compliance.tax_registrations', basis: 'Income-tax Act' },
  { slot: 'company.constitution', group: 'company', title: 'Partnership deed or incorporation certificate',
    applies: (p) => ['partnership', 'llp', 'private_limited', 'public_limited'].includes(p.entity_type),
    asks: ['entity_type'], expires: false, service_id: 'compliance.company_formation',
    basis: 'Partnership Act, LLP Act or Companies Act, by type of business' },
  { slot: 'company.udyam', group: 'company', title: 'Udyam registration', applies: always, asks: [], expires: false,
    service_id: 'compliance.tax_registrations',
    basis: 'MSMED Act. Not compulsory, but free, and usually exempts a small firm from bid security in government tenders' },
  { slot: 'company.cancelled_cheque', group: 'company', title: 'Cancelled cheque', applies: always, asks: [], expires: false,
    service_id: null, basis: 'Asked for by clients, banks and government departments to pay you' },
  { slot: 'company.shop_establishment', group: 'company', title: 'Shop and establishment registration', applies: always,
    asks: [], expires: true, service_id: 'compliance.tax_registrations', basis: 'State shops and establishments law, for an office' },
  { slot: 'company.contractor_registration', group: 'company', title: 'Contractor registration (PWD, CPWD, municipal)',
    applies: government, asks: ['client_types'], expires: true, service_id: 'compliance.contractor_registration',
    basis: 'Each department’s enlistment rules, for government work' },
  { slot: 'company.electrical_licence', group: 'company', title: 'Electrical contractor licence',
    applies: (p) => p.work_types.includes('electrical'), asks: ['work_types'], expires: true,
    service_id: 'compliance.electrical_licence', basis: 'State electricity rules, for electrical work' },
  { slot: 'company.dsc', group: 'company', title: 'Digital signature certificate', applies: government,
    asks: ['client_types'], expires: true, service_id: 'compliance.tender_papers', basis: 'Needed to bid on e-tenders' },

  // ─── Tax ──────────────────────────────────────────────────────────────────
  { slot: 'tax.gst_registration', group: 'tax', title: 'GST registration certificate',
    applies: (p) => !(p.turnover_band === 'under_40l' && !government(p)), asks: [], expires: false,
    service_id: 'compliance.tax_registrations',
    basis: 'CGST Act s.22 and s.24: above ₹20 lakh of services in most states, and asked for by most clients' },
  { slot: 'tax.tan', group: 'tax', title: 'TAN (to deduct TDS)', applies: always, asks: [], expires: false,
    service_id: 'compliance.tax_registrations', basis: 'Income-tax Act: needed to deduct TDS, e.g. on payments to sub-contractors' },
  { slot: 'tax.professional_tax', group: 'tax', title: 'Professional tax registration',
    applies: (p) => PROFESSIONAL_TAX_STATES.includes(p.state), asks: ['state'], expires: false,
    service_id: 'compliance.tax_registrations', basis: 'State professional tax law (not levied in every state)' },
  { slot: 'tax.itr', group: 'tax', title: 'Income tax returns, last three years', applies: always, asks: [], expires: false,
    multiple: true, service_id: 'tax.itr_audit', basis: 'Asked for by tenders, banks and lenders' },

  // ─── Labour ───────────────────────────────────────────────────────────────
  { slot: 'labour.licence', group: 'labour', title: 'Labour licence', applies: (p) => (p.contract_workers || 0) >= 50,
    asks: WORKERS, expires: true, service_id: 'compliance.labour_licence',
    basis: 'OSH Code 2020: a contractor with 50 or more contract workers (verify the counting rule)' },
  { slot: 'labour.bocw', group: 'labour', title: 'BOCW registration', applies: (p) => p.workers >= 10,
    asks: WORKERS, expires: false, service_id: 'compliance.bocw_registration',
    basis: 'Building and other construction workers law: 10 or more building workers; 1% cess' },
  { slot: 'labour.pf', group: 'labour', title: 'PF registration', applies: (p) => p.workers >= 20,
    asks: WORKERS, expires: false, service_id: 'compliance.pf_esi_registration',
    basis: 'Code on Social Security 2020: 20 or more employees (verify)' },
  { slot: 'labour.esi', group: 'labour', title: 'ESI registration', applies: (p) => p.workers >= 10,
    asks: WORKERS, expires: false, service_id: 'compliance.pf_esi_registration',
    basis: 'Code on Social Security 2020: 10 or more employees, in notified areas (verify)' },

  // ─── Insurance ────────────────────────────────────────────────────────────
  { slot: 'insurance.wc_policy', group: 'insurance', title: "Workers' accident cover",
    formal_name: "Workmen's compensation policy", applies: (p) => p.workers > 0, asks: WORKERS, expires: true,
    service_id: 'insurance.workers_compensation',
    basis: 'Employees’ compensation law makes the employer liable; many work orders ask for the policy' },

  // ─── Vehicles & machines ──────────────────────────────────────────────────
  ...[
    ['vehicles.rc', 'Registration certificates (RC)', false, null],
    ['vehicles.insurance', 'Vehicle and machine insurance', true, 'insurance.vehicles_machines'],
    ['vehicles.fitness', 'Fitness certificates', true, null],
    ['vehicles.permit', 'Permits', true, null],
    ['vehicles.puc', 'Pollution certificates (PUC)', true, null],
  ].map(([slot, title, expires, service_id]) => ({
    slot, group: 'vehicles', title, applies: (p) => (p.vehicles || 0) > 0, asks: ['vehicles'], expires,
    multiple: true, service_id, basis: 'Motor Vehicles Act, for each vehicle',
  })),

  // ─── Sites ────────────────────────────────────────────────────────────────
  { slot: 'sites.site_policy', group: 'sites', title: 'Site insurance', formal_name: "Contractor's all risk policy",
    applies: always, asks: [], expires: true, per: 'site', service_id: 'insurance.site_policy',
    basis: 'Often required by the work order before the first bill' },
];

const OTHER_SLOT = 'other';
const bySlot = new Map(RULES.map((r) => [r.slot, r]));
const getRule = (slot) => bySlot.get(slot) || null;
const isKnownSlot = (slot) => slot === OTHER_SLOT || bySlot.has(slot);

module.exports = { GROUPS, RULES, OTHER_SLOT, PROFESSIONAL_TAX_STATES, getRule, isKnownSlot };
