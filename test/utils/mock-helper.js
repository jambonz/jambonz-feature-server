const sinon = require('sinon');

/**
 * Creates mock objects commonly needed for testing HttpRequestor and related classes
 * @returns {Object} Mock objects
 */
const createMocks = () => {
  // Basic logger mock
  const MockLogger = {
    debug: () => {},
    info: () => {},
    error: () => {}
  };

  // Stats mock
  const MockStats = { 
    histogram: () => {} 
  };

  // Alerter mock
  const MockAlerter = {
    AlertType: {
      WEBHOOK_CONNECTION_FAILURE: 'WEBHOOK_CONNECTION_FAILURE',
      WEBHOOK_STATUS_FAILURE: 'WEBHOOK_STATUS_FAILURE'
    },
    writeAlerts: async () => {}
  };

  // DB helpers mock
  const MockDbHelpers = {
    pool: {
      getConnection: () => Promise.resolve({
        connect: () => {},
        on: () => {},
        query: (sql, cb) => {
          if (typeof cb === 'function') cb(null, []);
          return { stream: () => ({ on: () => {} }) };
        },
        end: () => {}
      }),
      query: (...args) => {
        const cb = args[args.length - 1];
        if (typeof cb === 'function') cb(null, []);
        return Promise.resolve([]);
      }
    },
    camelize: (obj) => obj
  };

  // Time series mock
  const MockTimeSeries = () => ({
    writeAlerts: async () => {},
    AlertType: {
      WEBHOOK_CONNECTION_FAILURE: 'WEBHOOK_CONNECTION_FAILURE',
      WEBHOOK_STATUS_FAILURE: 'WEBHOOK_STATUS_FAILURE'
    }
  });

  return {
    MockLogger,
    MockStats,
    MockAlerter,
    MockDbHelpers,
    MockTimeSeries
  };
};

/**
 * Set up mocks on the BaseRequestor class for tests
 * @param {Object} BaseRequestor - The BaseRequestor class
 */
const setupBaseRequestorMocks = (BaseRequestor) => {
  BaseRequestor.prototype._isAbsoluteUrl = function(url) { return url.startsWith('http'); };
  BaseRequestor.prototype._isRelativeUrl = function(url) { return !url.startsWith('http'); };
  BaseRequestor.prototype._generateSigHeader = function() { return { 'X-Signature': 'test-signature' }; };
  BaseRequestor.prototype._roundTrip = function() { return 10; };
  
  // Define baseUrl property
  Object.defineProperty(BaseRequestor.prototype, 'baseUrl', { 
    get: function() { return 'http://localhost'; } 
  });
  
  // Define Alerter property
  const mocks = createMocks();
  Object.defineProperty(BaseRequestor.prototype, 'Alerter', { 
    get: function() { return mocks.MockAlerter; } 
  });
};

/**
 * Clean up after tests
 * @param {Object} requestor - The requestor instance to clean up
 */
const cleanup = (requestor) => {
  sinon.restore();
  if (requestor && requestor.close) requestor.close();
};

module.exports = {
  createMocks,
  setupBaseRequestorMocks,
  cleanup
};
