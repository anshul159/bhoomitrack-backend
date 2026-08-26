// One in-memory MongoDB for the whole run — starting one per suite dominates the
// runtime of an otherwise fast test suite.
const { MongoMemoryServer } = require('mongodb-memory-server');

module.exports = async () => {
  const mongo = await MongoMemoryServer.create();
  global.__MONGO__ = mongo;
  process.env.MONGO_TEST_URI = mongo.getUri();
};
