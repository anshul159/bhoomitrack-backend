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

module.exports = {
  isNonEmptyString, isFiniteNumber, isPositiveNumber, isNonNegativeNumber, isObjectId,
  isAvatarDataUri, AVATAR_MAX_CHARS,
};
