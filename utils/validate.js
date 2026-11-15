const mongoose = require('mongoose');

// Small input-validation helpers shared across routes.

const isNonEmptyString = (v, maxLen = 200) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

const isPositiveNumber = (v) => isFiniteNumber(v) && v > 0;

const isNonNegativeNumber = (v) => isFiniteNumber(v) && v >= 0;

const isObjectId = (v) =>
  (typeof v === 'string' || v instanceof mongoose.Types.ObjectId) &&
  mongoose.Types.ObjectId.isValid(v);

// A profile picture, carried inline as a data URI. The cap is enforced here
// rather than trusted from the client: the device downscales to 256x256 JPEG
// (15-35 KB) and this leaves an order of magnitude of headroom for a device that
// compresses badly, while still refusing anything that could bloat the user
// document. Only raster formats a browser and Android both decode are allowed —
// notably NOT svg, which is a script-execution vector, not a photo.
const AVATAR_MAX_CHARS = 200_000;
const AVATAR_DATA_URI = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const isAvatarDataUri = (v) =>
  typeof v === 'string' && v.length <= AVATAR_MAX_CHARS && AVATAR_DATA_URI.test(v);

// A PAN: five letters, four digits, a letter. The fourth letter says what kind
// of holder it is (P a person, C a company, F a firm, ...).
const PAN = /^[A-Z]{3}[ABCFGHJLPTK][A-Z][0-9]{4}[A-Z]$/;
const isPan = (v) => typeof v === 'string' && PAN.test(v);

// A GSTIN: two-digit state code, the holder's PAN, an entity number, 'Z', and a
// check character. The check is GSTN's mod-36 scheme, so a single mistyped
// character is caught here rather than by the CA a month later.
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{3}[ABCFGHJLPTK][A-Z][0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

const isGstin = (v) =>
  typeof v === 'string' && GSTIN_SHAPE.test(v) && Number(v.slice(0, 2)) >= 1 &&
  gstinCheckChar(v.slice(0, 14)) === v[14];

module.exports = {
  isNonEmptyString, isFiniteNumber, isPositiveNumber, isNonNegativeNumber, isObjectId,
  isAvatarDataUri, AVATAR_MAX_CHARS, isPan, isGstin, gstinCheckChar,
};
