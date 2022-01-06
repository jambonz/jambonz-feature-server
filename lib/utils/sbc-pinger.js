const assert = require('assert');
const noopLogger = {info: () => {}, error: () => {}};
const {LifeCycleEvents} = require('./constants');
const Emitter = require('events');
const debug = require('debug')('jambonz:feature-server');

module.exports = (logger) => {
  logger = logger || noopLogger;
  let idxSbc = 0;
  let sbcs = [];

  if (process.env.JAMBONES_SBCS) {
    sbcs = process.env.JAMBONES_SBCS
      .split(',')
      .map((sbc) => sbc.trim());
    assert.ok(sbcs.length, 'JAMBONES_SBCS env var is empty or misconfigured');
    logger.info({sbcs}, 'SBC inventory');
  }

  // listen for SNS lifecycle changes
  let lifecycleEmitter = new Emitter();
  let dryUpCalls = false;
  if (process.env.AWS_SNS_TOPIC_ARM && process.env.AWS_REGION) {

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

  async function pingProxies(srf) {
    if (process.env.NODE_ENV === 'test') return;

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

  if (process.env.K8S) {
    logger.info('disabling OPTIONS pings since we are running as a kubernetes service');
  }
  else {
    // OPTIONS ping the SBCs from each feature server every 60 seconds
    setInterval(() => {
      const {srf} = require('../..');
      pingProxies(srf);
    }, process.env.OPTIONS_PING_INTERVAL || 30000);

    // initial ping once we are up
    setTimeout(async() => {
      const {srf} = require('../..');

      // if SBCs are auto-scaling, monitor them as they come and go
      if (!process.env.JAMBONES_SBCS) {
        const {monitorSet} = srf.locals.dbHelpers;
        const setName = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-sip`;
        await monitorSet(setName, 10, (members) => {
          sbcs = members;
          logger.info(`sbc-pinger: SBC roster has changed, list of active SBCs is now ${sbcs}`);
        });
      }

      pingProxies(srf);
    }, 1000);
  }

  return {
    lifecycleEmitter,
    getSBC: () => sbcs[idxSbc++ % sbcs.length]
  };
};

