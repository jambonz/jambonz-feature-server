const { test, describe } = require('node:test');
const assert = require('node:assert');
const { validateURL } = require('../lib/utils/validate-utils');

describe('validateURL', () => {
  test('should return true for valid URLs', () => {
    const validUrls = [
      'http://example.com',
      'https://example.com',      
      'http://localhost',
      'http://127.0.0.1',
      'http://example.com:8080',
      'http://example.com/path?name=value#anchor',
      'https://endpoint-app.cognigy.ai/8347a76be8e13f58ecd8fc57be58006342fb14845ce4a12577900499b230ddca?userId=+4969784512&sessionId=ecec544f-datb-4ca3-8873-88337e7e0d54' // example from Voice Copilot
    ];

    validUrls.forEach(url => {
      assert.strictEqual(validateURL(url), true, `Expected true for valid URL: ${url}`);
    });
  });

  test('should return false for invalid URLs', () => {
    const invalidUrls = [
      'htp://example.com',  // Invalid protocol
      '://example.com',     // Missing protocol
      'http://',            // Missing hostname
      'http://example',     // Invalid hostname
      'example.com',        // Missing protocol
      '',                   // Empty string
      null,                 // Null value
      undefined,            // Undefined value
      'http://example.com:invalidport', // Invalid port,
      'Handlungselemente: Die Handlung enthält Elemente von Spannung und Aufregung durch die Bodyguard-Thematik. Die Story beinhaltet ebenso das College leben.'
    ];

    invalidUrls.forEach(url => {
      assert.strictEqual(validateURL(url), false, `Expected false for invalid URL: ${url}`);
    });
  });
});