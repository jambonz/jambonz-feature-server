const assert = require('assert');
const noopLogger = {info: () => {}, error: () => {}};
const Srf = require('drachtio-srf');
const debug = require('debug')('jambonz:sbc-inbound');
const srfs = [];

module.exports = (logger) => {
  logger = logger || noopLogger;
  let idxSbc = 0, idxSrfs = 0;

  assert.ok(process.env.JAMBONES_SBCS, 'missing JAMBONES_SBCS env var');
  const sbcs = process.env.JAMBONES_SBCS
    .split(',')
    .map((sbc) => sbc.trim());
  assert.ok(sbcs.length, 'JAMBONES_SBCS env var is empty or misconfigured');
  logger.info({sbcs}, 'SBC inventory');

  assert.ok(process.env.JAMBONES_FEATURE_SERVERS, 'missing JAMBONES_FEATURE_SERVERS env var');
  const drachtio = process.env.JAMBONES_FEATURE_SERVERS
    .split(',')
    .map((fs) => {
      const arr = /^(.*):(.*):(.*)/.exec(fs);
      if (!arr) throw new Error('JAMBONES_FEATURE_SERVERS env var is misconfigured');
      const srf = new Srf();
      srf.connect({host: arr[1], port: arr[2], secret: arr[3]})
        .on('connect', (err, hp) => {
          if (err) return logger.info(err, `Error connecting to drachtio server at ${arr[1]}:${arr[2]}`);
          srfs.push(srf);
          logger.info(err, `Success connecting to FS at ${arr[1]}:${arr[2]}, ${srfs.length} online`);
          pingProxies(srf);
        })
        .on('error', (err) => {
          const place = srfs.indexOf(srf);
          if (-1 !== place) srfs.splice(place, 1);
          logger.info(err, `Error connecting to FS at ${arr[1]}:${arr[2]}, ${srfs.length} remain online`);
        });
      return {host: arr[1], port: arr[2], secret: arr[3]};
    });
  assert.ok(drachtio.length, 'JAMBONES_FEATURE_SERVERS env var is empty');
  logger.info({drachtio}, 'drachtio feature server inventory');

  async function pingProxies(srf) {
    for (const sbc of sbcs) {
      try {
        const req = await srf.request({
          uri: `sip:${sbc}`,
          method: 'OPTIONS',
          headers: {
            'X-FS-Status': 'open'
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
    srfs.forEach((srf) => pingProxies(srf));
  }, 60000);

  return {
    getSBC: () => sbcs[idxSbc++ % sbcs.length],
    getSrf: () => srfs[idxSrfs++ % srfs.length]
  };
};

