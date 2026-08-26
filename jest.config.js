module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/helpers/env.js'],
  globalSetup: '<rootDir>/tests/helpers/globalSetup.js',
  globalTeardown: '<rootDir>/tests/helpers/globalTeardown.js',
  setupFilesAfterEnv: ['<rootDir>/tests/helpers/setup.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // The in-memory MongoDB download and first boot dominate a cold run.
  testTimeout: 30000,
  // Run serially: every suite shares one in-memory database and wipes it between
  // tests, so parallel workers would clear each other's fixtures.
  maxWorkers: 1,
  collectCoverageFrom: [
    'routes/**/*.js',
    'middleware/**/*.js',
    'utils/**/*.js',
    'models/**/*.js',
  ],
};
