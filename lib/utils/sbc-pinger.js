const assert = require('assert');
const noopLogger = {info: () => {}, error: () => {}};
const debug = require('debug')('jambonz:feature-server');

module.exports = (logger) => {
  logger = logger || noopLogger;
  let idxSbc = 0;

  assert.ok(process.env.JAMBONES_SBCS, 'missing JAMBONES_SBCS env var');
  const sbcs = process.env.JAMBONES_SBCS
    .split(',')
    .map((sbc) => sbc.trim());
  assert.ok(sbcs.length, 'JAMBONES_SBCS env var is empty or misconfigured');
  logger.info({sbcs}, 'SBC inventory');

  async function pingProxies(srf) {
    for (const sbc of sbcs) {
      try {
        const ms = srf.locals.getFreeswitch();
        const req = await srf.request({
          uri: `sip:${sbc}`,
          method: 'OPTIONS',
          headers: {
            'X-FS-Status': ms ? 'open' : 'closed'
          }
        });
        req.on('response', (res) => {
          debug(`received ${res.status} from SBC`);
        });
      } catch (err) {
        logger.error(err, `Error sending OPTIONS to ${sbc}`);
      }
    }
  }

  // OPTIONS ping the SBCs from each feature server every 60 seconds
  setInterval(() => {
    const {srf} = require('../..');
    pingProxies(srf);
  }, 60000);

  return {
    getSBC: () => sbcs[idxSbc++ % sbcs.length]
  };
};

