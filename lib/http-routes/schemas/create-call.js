const { checkSchema } = require('express-validator');

/**
 * @path api-server {{base_url}}/v1/Accounts/:account_sid/Calls
 * @see https://api.jambonz.org/#243a2edd-7999-41db-bd0d-08082bbab401
 */
const createCallSchema = checkSchema({
  application_sid: {
    isString: true,
    optional: true,
    isLength: { options: { min: 36, max: 36 } },
    errorMessage: 'Invalid application_sid',
  },
  answerOnBridge: {
    isBoolean: true,
    optional: true,
    errorMessage: 'Invalid answerOnBridge',
  },
  from: {
    errorMessage: 'Invalid from',
    isString: true,
    isLength: {
      options: { min: 1, max: 256 },
    },
  },
  fromHost: {
    isString: true,
    optional: true,
    errorMessage: 'Invalid fromHost',
  },
  to: {
    errorMessage: 'Invalid to',
    isObject: true,
  },
  callerName: {
    isString: true,
    optional: true,
    errorMessage: 'Invalid callerName',
  },
  amd: {
    isObject: true,
    optional: true,
  },
  tag: {
    isObject: true,
    optional: true,
    errorMessage: 'Invalid tag',
  },
  app_json: {
    isString: true,
    optional: true,
    errorMessage: 'Invalid app_json',
  },
  account_sid: {
    isString: true,
    optional: true,
    errorMessage: 'Invalid account_sid',
    isLength: { options: { min: 36, max: 36 } },
  },
  timeout: {
    isInt: true,
    optional: true,
    errorMessage: 'Invalid timeout',
  },
  timeLimit: {
    isInt: true,
    optional: true,
    errorMessage: 'Invalid timeLimit',
  },
  call_hook: {
    isObject: true,
    optional: true,
    errorMessage: 'Invalid call_hook',
  },
  call_status_hook: {
    isObject: true,
    optional: true,
    errorMessage: 'Invalid call_status_hook',
  },
  speech_synthesis_vendor: {
    isString: true,
    optional: true,
    errorMessage: 'Invalid speech_synthesis_vendor',
  },
  speech_synthesis_language: {
    isString: true,
    optional: true,
    errorMessage: 'Invalid speech_synthesis_language',
  },
  speech_synthesis_voice: {
    isString: true,
    optional: true,
    errorMessage: 'Invalid speech_synthesis_voice',
  },
  speech_recognizer_vendor: {
    isString: true,
    optional: true,
    errorMessage: 'Invalid speech_recognizer_vendor',
  },
  speech_recognizer_language: {
    isString: true,
    optional: true,
    errorMessage: 'Invalid speech_recognizer_language',
  }
}, ['body']);

const customSanitizeFunction = (value) => {
  try {
    if (Array.isArray(value)) {
      value = value.map((item) => customSanitizeFunction(item));
    } else if (typeof value === 'object') {
      Object.keys(value).forEach((key) => {
        value[key] = customSanitizeFunction(value[key]);
      });
    } else if (typeof value === 'string') {
      /* trims characters at the beginning and at the end of a string */
      value = value.trim();

      // Only attempt to parse if the whole string is a URL
      if (/^https?:\/\/\S+$/.test(value)) {
        value = new URL(value).toString();
      }
    }
  } catch (error) {
    value = `Error: ${error.message}`;
  }

  return value;
};

module.exports = {
  createCallSchema,
  customSanitizeFunction
};
