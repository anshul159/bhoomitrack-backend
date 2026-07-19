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

module.exports = { isNonEmptyString, isFiniteNumber, isPositiveNumber, isNonNegativeNumber, isObjectId };
