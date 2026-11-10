// Volume of material carried in a vehicle body (v2).
//
// Sand, gitti (aggregate) and similar loose material arrive by the vehicle-load
// and are measured on site by the height the load reaches in the body:
// length x breadth x height. Indian sites mostly measure in feet and trade in cubic
// feet and brass (1 brass = 100 cft), so the record keeps cft as well as m3.
//
// The server always computes the volume itself from the three dimensions — a
// volume typed or computed by the client is never trusted.
//
// Weight is deliberately not computed yet: it needs a density per material, which
// is a later update. Keeping the measured dimensions on the record means weight
// can be derived for every past arrival once density exists.

const CFT_PER_M3 = 35.3146667;
const CFT_PER_BRASS = 100;

const UNITS = ['ft', 'm'];

// Larger than any vehicle body (a long trailer is ~40 ft). Catches the common
// slip of typing inches or centimetres into a feet or metres field.
const MAX_DIMENSION = { ft: 60, m: 18 };

const round = (n, dp) => Number(n.toFixed(dp));

/**
 * @returns {{ volume_cft: number, volume_m3: number, volume_brass: number } | { error: string }}
 */
function computeVolume(length, breadth, height, unit) {
  if (!UNITS.includes(unit)) return { error: 'Dimension unit must be ft or m' };
  const dims = { length: Number(length), breadth: Number(breadth), height: Number(height) };
  for (const [name, value] of Object.entries(dims)) {
    if (!Number.isFinite(value) || value <= 0) {
      return { error: `Enter the ${name} as a number greater than 0` };
    }
    if (value > MAX_DIMENSION[unit]) {
      return { error: `The ${name} looks too large (max ${MAX_DIMENSION[unit]} ${unit}). Check the unit.` };
    }
  }

  const raw = dims.length * dims.breadth * dims.height;
  const cft = unit === 'ft' ? raw : raw * CFT_PER_M3;
  const m3 = unit === 'm' ? raw : raw / CFT_PER_M3;

  return {
    volume_cft: round(cft, 2),
    volume_m3: round(m3, 3),
    volume_brass: round(cft / CFT_PER_BRASS, 3),
  };
}

module.exports = { computeVolume, CFT_PER_M3, CFT_PER_BRASS, UNITS, MAX_DIMENSION };
