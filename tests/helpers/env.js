// Loaded before the test framework and before any application module, because
// server.js exits the process if these are missing.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-not-used-anywhere-real';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/placeholder'; // replaced in setup.js
process.env.TRIAL_DAYS = '30';
process.env.DELETION_RETENTION_DAYS = '30';
// Push and email must stay unconfigured so no test can reach the network.
delete process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
delete process.env.SENTRY_DSN;
delete process.env.SMTP_HOST;
