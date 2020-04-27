const assert = require('assert');
const noopLogger = {info: () => {}, error: () => {}};
const {LifeCycleEvents} = require('./constants');
const Emitter = require('events');
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

  // listen for SNS lifecycle changes
  let lifecycleEmitter = new Emitter();
  let dryUpCalls = false;
  if (process.env.AWS_SNS_TOPIC_ARM &&
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_REGION) {

    (async function() {
      try {
        lifecycleEmitter = await require('./aws-sns-lifecycle')(logger);

        lifecycleEmitter
          .on(LifeCycleEvents.ScaleIn, () => {
            logger.info('AWS scale-in notification: begin drying up calls');
            dryUpCalls = true;
            lifecycleEmitter.operationalState = LifeCycleEvents.ScaleIn;

            const {srf} = require('../..');
            pingProxies(srf);

            // if we have zero calls, we can complete the scale-in right
            setTimeout(() => {
              const calls = srf.locals.sessionTracker.count;
              if (calls === 0) {
                logger.info('scale-in can complete immediately as we have no calls in progress');
                lifecycleEmitter.completeScaleIn();
              }
              else {
                logger.info(`${calls} calls in progress; scale-in will complete when they are done`);
              }
            }, 5000);
          })
          .on(LifeCycleEvents.StandbyEnter, () => {
            dryUpCalls = true;
            const {srf} = require('../..');
            pingProxies(srf);

            logger.info('AWS enter pending state notification: begin drying up calls');
          })
          .on(LifeCycleEvents.StandbyExit, () => {
            dryUpCalls = false;
            const {srf} = require('../..');
            pingProxies(srf);

            logger.info('AWS enter pending state notification: re-enable calls');
          });
      } catch (err) {
        logger.error({err}, 'Failure creating SNS notifier, lifecycle events will be disabled');
      }
    })();
  }

  // send OPTIONS pings to SBCs
  async function pingProxies(srf) {
    for (const sbc of sbcs) {
      try {
        const ms = srf.locals.getFreeswitch();
        const req = await srf.request({
          uri: `sip:${sbc}`,
          method: 'OPTIONS',
          headers: {
            'X-FS-Status': ms && !dryUpCalls ? 'open' : 'closed',
            'X-FS-Calls': srf.locals.sessionTracker.count
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
  }, 20000);

  // initial ping once we are up
  setTimeout(() => {
    const {srf} = require('../..');
    pingProxies(srf);
  }, 1000);

  return {
    lifecycleEmitter,
    getSBC: () => sbcs[idxSbc++ % sbcs.length]
  };
};

