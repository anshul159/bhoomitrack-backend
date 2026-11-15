const mongoose = require('mongoose');

// Sequences for human-readable reference numbers (BhoomiTrack Services): a service
// request is "SR-000123" on the phone, in the desk and on a call, never an
// ObjectId. One document per sequence name, incremented atomically.
const counterSchema = new mongoose.Schema({
  _id: { type: String },          // the sequence name, e.g. 'SR'
  seq: { type: Number, default: 0 },
}, { versionKey: false });

module.exports = mongoose.model('Counter', counterSchema);
