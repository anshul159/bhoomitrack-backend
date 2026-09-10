// Per-user material defaults for the Create Site form (ENH-097).
//
// Two decisions belong to the person filling that form in, not to us: WHICH
// materials it offers as checkboxes, and what unit each one starts in. A firm
// laying tiles all day wants a different twelve rows from one pouring slabs, and
// re-deriving the same list by hand on every new site is the tax this removes.
//
// Stored on the User rather than the Organization on purpose. Two owners in one
// firm may run quite different kinds of site, this changes nothing anyone else can
// see, and an org-wide version would need a rule for who gets to set it. Nothing
// downstream reads these: they seed a form, and the Inventory rows the form
// creates carry their own name and unit as they always have.

const { isNonEmptyString } = require('./validate');

const MATERIAL_NAME_MAX = 60;
// 30 is what POST /api/sites/create already enforces on an incoming unit; a
// default that could not survive being submitted would be a trap.
const UNIT_MAX = 30;
// A bound on the user document, not a considered opinion about how many materials
// a firm tracks. 60 rows of this shape is a couple of KB.
const MAX_MATERIALS = 60;

// The units the app offers in its pickers. Deliberately NOT an enum on the model:
// the create-site route has always accepted any unit string, some firm somewhere
// measures something in a unit nobody here thought of, and rejecting it would be a
// regression dressed as validation. This list is a suggestion, and it travels with
// the GET so the app can gain a unit without a store release.
const UNITS = [
  'units', 'nos', 'bags', 'kg', 'tonnes',
  'brass', 'cft', 'sqft', 'sheets', 'litres', 'm', 'bundles',
];

// What someone who has never opened the settings screen sees: the same twelve
// materials the form has always offered, in the same order, each starting in a
// unit that suits it rather than the flat 'units' they all used to share.
//
// `preselected: false` throughout, deliberately. An upgrade must not silently
// pre-tick a form — the first site created after installing this would quietly
// gain materials the owner never chose.
const SEED_MATERIAL_DEFAULTS = [
  { name: 'Brick',    unit: 'nos',    preselected: false },
  { name: 'Cement',   unit: 'bags',   preselected: false },
  { name: 'Gitti',    unit: 'brass',  preselected: false },
  { name: 'Iron Rod', unit: 'kg',     preselected: false },
  { name: 'Plywood',  unit: 'sheets', preselected: false },
  { name: 'Rock',     unit: 'brass',  preselected: false },
  { name: 'Sand',     unit: 'brass',  preselected: false },
  { name: 'Soil',     unit: 'brass',  preselected: false },
  { name: 'Steel',    unit: 'kg',     preselected: false },
  { name: 'Paint',    unit: 'litres', preselected: false },
  { name: 'Tiles',    unit: 'sqft',   preselected: false },
  { name: 'Glass',    unit: 'sqft',   preselected: false },
];

/** A fresh copy — callers hand this to res.json, and one of them will mutate it. */
const seedMaterialDefaults = () => SEED_MATERIAL_DEFAULTS.map((m) => ({ ...m }));

/**
 * What to show a given user. `undefined` means "never configured" and earns the
 * seed; an empty array means "configured, then emptied" and is honoured as such.
 * That distinction is why the model sets `default: undefined` rather than letting
 * Mongoose fill in `[]` (see models/User.js).
 */
const effectiveMaterialDefaults = (stored) =>
  Array.isArray(stored) ? stored.map((m) => ({
    name: m.name,
    unit: m.unit || 'units',
    preselected: !!m.preselected,
  })) : seedMaterialDefaults();

/**
 * Validate and clean an incoming list.
 *
 * Returns `{ ok: true, value }` or `{ ok: false, message }`. Duplicate names are
 * dropped rather than rejected — case-insensitively, because "cement" and
 * "Cement" would otherwise become two checkboxes for one material, and the
 * create-site form keys its selection by name.
 */
function normaliseMaterialDefaults(input) {
  if (!Array.isArray(input)) {
    return { ok: false, message: 'Send `defaults` as an array of materials.' };
  }
  if (input.length > MAX_MATERIALS) {
    return { ok: false, message: `Keep it to ${MAX_MATERIALS} materials or fewer.` };
  }

  const value = [];
  const seen = new Set();

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, message: 'Each material must be an object with a name.' };
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!isNonEmptyString(name, MATERIAL_NAME_MAX)) {
      return {
        ok: false,
        message: `Every material needs a name of at most ${MATERIAL_NAME_MAX} characters.`,
      };
    }

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const unit = typeof raw.unit === 'string' ? raw.unit.trim() : '';
    if (unit && !isNonEmptyString(unit, UNIT_MAX)) {
      return { ok: false, message: `A unit must be at most ${UNIT_MAX} characters.` };
    }

    value.push({ name, unit: unit || 'units', preselected: !!raw.preselected });
  }

  return { ok: true, value };
}

module.exports = {
  UNITS,
  MAX_MATERIALS,
  MATERIAL_NAME_MAX,
  UNIT_MAX,
  seedMaterialDefaults,
  effectiveMaterialDefaults,
  normaliseMaterialDefaults,
};
