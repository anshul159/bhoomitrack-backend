const mongoose = require('mongoose');

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_TEST_URI);
});

// A clean database per test. Fixtures are explicit in each test rather than
// shared, so a failure points at one thing.
afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.connection.close();
});

// Keep expected logging out of the test output. A test that asserts a 500, or
// that runs with push deliberately unconfigured, should not print noise as
// though something had gone wrong. Set VERBOSE_TESTS=1 to see it all.
const real = { error: console.error, warn: console.warn, log: console.log };
const quiet = (...args) => { if (process.env.VERBOSE_TESTS) real.error(...args); };
beforeAll(() => { console.error = quiet; console.warn = quiet; console.log = quiet; });
afterAll(() => { Object.assign(console, real); });
