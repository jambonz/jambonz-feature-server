/**
 * Common test mocks for Jambonz tests
 */
const proxyquire = require('proxyquire').noCallThru();

// Logger mock
class MockLogger {
  debug() {}
  info() {}
  error() {}
}

// Stats mock
const statsMock = { histogram: () => {} };

// Time series mock
const timeSeriesMock = () => ({
  writeAlerts: async () => {},
  AlertType: {
    WEBHOOK_CONNECTION_FAILURE: 'WEBHOOK_CONNECTION_FAILURE',
    WEBHOOK_STATUS_FAILURE: 'WEBHOOK_STATUS_FAILURE'
  }
});

// DB helpers mock
const dbHelpersMock = {
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

// Config mock
const configMock = {
  HTTP_POOL: '0',
  HTTP_POOLSIZE: '10',
  HTTP_PIPELINING: '1',
  HTTP_TIMEOUT: 5000,
  HTTP_PROXY_IP: null,
  HTTP_PROXY_PORT: null,
  HTTP_PROXY_PROTOCOL: null,
  NODE_ENV: 'test',
  HTTP_USER_AGENT_HEADER: 'test-agent',
  JAMBONES_TIME_SERIES_HOST: 'localhost'
};

// SRF mock
const srfMock = {
  srf: {
    locals: {
      stats: statsMock
    }
  }
};

// Alerter mock
const alerterMock = {
  AlertType: {
    WEBHOOK_CONNECTION_FAILURE: 'WEBHOOK_CONNECTION_FAILURE',
    WEBHOOK_STATUS_FAILURE: 'WEBHOOK_STATUS_FAILURE'
  },
  writeAlerts: async () => {}
};

/**
 * Creates mocked BaseRequestor and HttpRequestor classes
 * @returns {Object} Mocked classes and helper functions
 */
function createMockedRequestors() {
  // First, mock BaseRequestor's dependencies
  const BaseRequestor = proxyquire('../../lib/utils/base-requestor', {
    '@jambonz/time-series': timeSeriesMock,
    '../config': configMock,
    '../../': srfMock
  });

  // Apply prototype methods and properties
  BaseRequestor.prototype._isAbsoluteUrl = function(url) { return url.startsWith('http'); };
  BaseRequestor.prototype._isRelativeUrl = function(url) { return !url.startsWith('http'); };
  BaseRequestor.prototype._generateSigHeader = function() { return { 'X-Signature': 'test-signature' }; };
  BaseRequestor.prototype._roundTrip = function() { return 10; };

  // Define baseUrl property
  Object.defineProperty(BaseRequestor.prototype, 'baseUrl', { 
    get: function() { return 'http://localhost'; } 
  });

  // Define Alerter property
  Object.defineProperty(BaseRequestor.prototype, 'Alerter', { 
    get: function() { return alerterMock; } 
  });

  // Then mock HttpRequestor with the mocked BaseRequestor
  const HttpRequestor = proxyquire('../../lib/utils/http-requestor', {
    './base-requestor': BaseRequestor,
    '../config': configMock,
    '@jambonz/db-helpers': dbHelpersMock
  });

  // Setup function to create a clean requestor for each test
  const setupRequestor = () => {
    const logger = new MockLogger();
    const hook = { url: 'http://localhost/test', method: 'POST' };
    const secret = 'testsecret';
    return new HttpRequestor(logger, 'AC123', hook, secret);
  };

  // Cleanup function
  const cleanup = (requestor) => {
    const sinon = require('sinon');
    sinon.restore();
    if (requestor && requestor.close) requestor.close();
  };

  return {
    BaseRequestor,
    HttpRequestor,
    setupRequestor,
    cleanup,
    mocks: {
      logger: new MockLogger(),
      stats: statsMock,
      timeSeries: timeSeriesMock,
      dbHelpers: dbHelpersMock,
      config: configMock,
      srf: srfMock,
      alerter: alerterMock
    }
  };
}

module.exports = {
  createMockedRequestors,
  MockLogger,
  statsMock,
  timeSeriesMock,
  dbHelpersMock,
  configMock,
  srfMock,
  alerterMock
};