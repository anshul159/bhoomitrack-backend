// Reference numbers: next('SR') → 'SR-000123'.
//
// One atomic findOneAndUpdate with $inc and upsert, so two requests created in the
// same millisecond on two instances still get different numbers. The sequence is
// platform-wide rather than per organisation: the desk talks about "SR-000123"
// without having to say whose, and the number gives away nothing a customer could
// use, because every route still checks the organisation.

const Counter = require('../models/Counter');

const PAD = 6;

async function next(prefix) {
  if (!/^[A-Z]{1,6}$/.test(prefix)) throw new Error(`Bad sequence prefix: ${prefix}`);
  // Two first-ever upserts can race to insert the counter, and the loser gets a
  // duplicate-key error. The counter exists by then, so one retry always succeeds.
  for (let attempt = 0; ; attempt++) {
    try {
      const doc = await Counter.findOneAndUpdate(
        { _id: prefix },
        { $inc: { seq: 1 } },
        { upsert: true, new: true }
      ).lean();
      return `${prefix}-${String(doc.seq).padStart(PAD, '0')}`;
    } catch (err) {
      if (err?.code !== 11000 || attempt >= 2) throw err;
    }
  }
}

module.exports = { next };
