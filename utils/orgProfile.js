// The organisation's profile (BhoomiTrack Services, phase 0): the handful of facts
// about the business that decide which company-file slots apply to it and what a
// service request can be pre-filled with.
//
// Asked late, never up front (plan §5.1 rule 4): the app asks for a value only
// when a screen needs it, so every field is optional and a write may carry any
// subset. A field sent as null clears it.

const { isPan, isGstin } = require('./validate');

const ENTITY_TYPES = ['proprietorship', 'partnership', 'llp', 'private_limited', 'public_limited', 'other'];
const WORK_TYPES = ['building', 'road', 'electrical', 'plumbing', 'interior', 'industrial', 'builder', 'other'];
const CLIENT_TYPES = ['private', 'government'];
const TURNOVER_BANDS = ['under_40l', '40l_1cr', '1cr_5cr', '5cr_25cr', 'over_25cr'];

// ISO 3166-2:IN state and union-territory codes.
const STATES = {
  AN: 'Andaman and Nicobar Islands', AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam',
  BR: 'Bihar', CH: 'Chandigarh', CT: 'Chhattisgarh', DH: 'Dadra and Nagar Haveli and Daman and Diu',
  DL: 'Delhi', GA: 'Goa', GJ: 'Gujarat', HR: 'Haryana', HP: 'Himachal Pradesh', JK: 'Jammu and Kashmir',
  JH: 'Jharkhand', KA: 'Karnataka', KL: 'Kerala', LA: 'Ladakh', LD: 'Lakshadweep', MP: 'Madhya Pradesh',
  MH: 'Maharashtra', MN: 'Manipur', ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland', OR: 'Odisha',
  PY: 'Puducherry', PB: 'Punjab', RJ: 'Rajasthan', SK: 'Sikkim', TN: 'Tamil Nadu', TG: 'Telangana',
  TR: 'Tripura', UP: 'Uttar Pradesh', UT: 'Uttarakhand', WB: 'West Bengal',
};

const UDYAM = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/;
const MAX_COUNT = 100000;

const upper = (v) => String(v).trim().toUpperCase().replace(/\s+/g, '');

const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_COUNT;

/** Each field: how to clean it and whether the clean value is acceptable. */
const FIELDS = {
  entity_type: { clean: (v) => String(v).trim(), ok: (v) => ENTITY_TYPES.includes(v), message: 'Choose a type of business' },
  gstin: { clean: upper, ok: isGstin, message: 'That GSTIN is not valid. Please check each character.' },
  pan: { clean: upper, ok: isPan, message: 'That PAN is not valid. It looks like ABCDE1234F.' },
  state: { clean: upper, ok: (v) => Object.prototype.hasOwnProperty.call(STATES, v), message: 'Choose a state' },
  district: { clean: (v) => String(v).trim(), ok: (v) => v.length > 0 && v.length <= 80, message: 'Enter a district' },
  work_types: {
    clean: (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()))] : v),
    ok: (v) => Array.isArray(v) && v.every((x) => WORK_TYPES.includes(x)),
    message: 'Choose the kinds of work you do',
  },
  client_types: {
    clean: (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()))] : v),
    ok: (v) => Array.isArray(v) && v.every((x) => CLIENT_TYPES.includes(x)),
    message: 'Choose who you work for',
  },
  own_workers: { clean: (v) => v, ok: isCount, message: 'Enter the number of your own workers' },
  contract_workers: { clean: (v) => v, ok: isCount, message: 'Enter the number of contract workers' },
  vehicles: { clean: (v) => v, ok: isCount, message: 'Enter the number of vehicles and machines' },
  turnover_band: { clean: (v) => String(v).trim(), ok: (v) => TURNOVER_BANDS.includes(v), message: 'Choose a turnover band' },
  udyam_no: { clean: upper, ok: (v) => UDYAM.test(v), message: 'That Udyam number is not valid. It looks like UDYAM-DL-01-0012345.' },
};

const PROFILE_FIELDS = Object.keys(FIELDS);

/**
 * Validates a partial profile update.
 * @returns {{ set: object, unset: string[] } | { error: string, field: string }}
 */
function parseProfileUpdate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'The profile could not be read', field: null };
  }
  const set = {};
  const unset = [];
  for (const [key, value] of Object.entries(input)) {
    const spec = FIELDS[key];
    if (!spec) continue; // unknown keys are ignored, as elsewhere in the API
    if (value === null || value === '') { unset.push(key); continue; }
    const clean = spec.clean(value);
    if (!spec.ok(clean)) return { error: spec.message, field: key };
    set[key] = clean;
  }

  // A GSTIN contains the holder's PAN. Disagreement is a typo in one of them.
  const gstin = set.gstin;
  const pan = set.pan;
  if (gstin && pan && gstin.slice(2, 12) !== pan) {
    return { error: 'The PAN inside your GSTIN does not match the PAN you entered', field: 'pan' };
  }
  return { set, unset };
}

/** The profile as the API returns it: every field present, null when unknown. */
function presentProfile(profile = {}) {
  const out = {};
  for (const key of PROFILE_FIELDS) {
    const v = profile?.[key];
    out[key] = Array.isArray(v) ? [...v] : (v === undefined ? null : v);
  }
  if (!out.work_types) out.work_types = [];
  if (!out.client_types) out.client_types = [];
  out.state_name = out.state ? STATES[out.state] || null : null;
  // A GSTIN carries the PAN, so the PAN need never be asked for twice.
  if (!out.pan && out.gstin) out.pan = out.gstin.slice(2, 12);
  return out;
}

module.exports = {
  parseProfileUpdate, presentProfile, PROFILE_FIELDS,
  ENTITY_TYPES, WORK_TYPES, CLIENT_TYPES, TURNOVER_BANDS, STATES,
};
