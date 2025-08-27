const {
  DRACHTIO_PORT,
  DRACHTIO_HOST,
  DRACHTIO_SECRET,
  JAMBONES_OTEL_SERVICE_NAME,
  JAMBONES_LOGLEVEL,
  JAMBONES_CLUSTER_ID,
  JAMBONZ_CLEANUP_INTERVAL_MINS,
  getCleanupIntervalMins,
  K8S,
  NODE_ENV,
  checkEnvs,
} = require('./lib/config');

checkEnvs();

const Srf = require('drachtio-srf');
const srf = new Srf();
const tracer = require('./tracer')(JAMBONES_OTEL_SERVICE_NAME);
const api = require('@opentelemetry/api');
srf.locals = {...srf.locals, otel: {tracer, api}};

const opts = {
  level: JAMBONES_LOGLEVEL
};
const pino = require('pino');
const logger = pino(opts, pino.destination({sync: false}));
const {LifeCycleEvents, FS_UUID_SET_NAME, SystemState, FEATURE_SERVER} = require('./lib/utils/constants');
const installSrfLocals = require('./lib/utils/install-srf-locals');
const createHttpListener = require('./lib/utils/http-listener');
const healthCheck = require('@jambonz/http-health-check');
const ProcessMonitor = require('./lib/utils/process-monitor');
const monitor = new ProcessMonitor(logger);

// Log startup
monitor.logStartup();
monitor.setupSignalHandlers();

logger.on('level-change', (lvl, _val, prevLvl, _prevVal, instance) => {
  if (logger !== instance) {
    return;
  }
  logger.info('system log level %s was changed to %s', prevLvl, lvl);
});

// Install the srf locals
installSrfLocals(srf, logger, {
  onFreeswitchConnect: (wraper) => {
    // Only connect to drachtio if freeswitch is connected
    logger.info(`connected to freeswitch at ${wraper.ms.address}, start drachtio server`);
    if (DRACHTIO_HOST) {
      srf.connect({host: DRACHTIO_HOST, port: DRACHTIO_PORT, secret: DRACHTIO_SECRET });
      srf.on('connect', (err, hp) => {
        const arr = /^(.*)\/(.*)$/.exec(hp.split(',').pop());
        srf.locals.localSipAddress = `${arr[2]}`;
        logger.info(`connected to drachtio listening on ${hp}, local sip address is ${srf.locals.localSipAddress}`);
      });
    }
    else {
      logger.info(`listening for drachtio requests on port ${DRACHTIO_PORT}`);
      srf.listen({port: DRACHTIO_PORT, secret: DRACHTIO_SECRET});
    }
    // Start Http server
    createHttpListener(logger, srf)
      .then(({server, app}) => {
        httpServer = server;
        healthCheck({app, logger, path: '/', fn: getCount});
        return {server, app};
      })
      .catch((err) => {
        logger.error(err, 'Error creating http listener');
      });
  },
  onFreeswitchDisconnect: (wraper) => {
    // check if all freeswitch connections are lost, disconnect drachtio server
    logger.info(`lost connection to freeswitch at ${wraper.ms.address}`);
    const ms = srf.locals.getFreeswitch();
    if (!ms) {
      logger.info('no freeswitch connections, stopping drachtio server');
      disconnect();
    }
  }
});
if (NODE_ENV === 'test') {
  srf.on('error', (err) => {
    logger.info(err, 'Error connecting to drachtio');
  });
}

// Init services
const writeSystemAlerts = srf.locals?.writeSystemAlerts;
if (writeSystemAlerts) {
  writeSystemAlerts({
    system_component: FEATURE_SERVER,
    state : SystemState.Online,
    fields : {
      detail: `feature-server with process_id ${process.pid} started`,
      host: srf.locals?.ipv4
    }
  });
}

const {
  initLocals,
  createRootSpan,
  handleSipRec,
  getAccountDetails,
  normalizeNumbers,
  retrieveApplication,
  invokeWebCallback
} = require('./lib/middleware')(srf, logger);

const InboundCallSession = require('./lib/session/inbound-call-session');
const SipRecCallSession = require('./lib/session/siprec-call-session');

srf.use('invite', [
  initLocals,
  createRootSpan,
  handleSipRec,
  getAccountDetails,
  normalizeNumbers,
  retrieveApplication,
  invokeWebCallback
]);

srf.invite(async(req, res) => {
  const isSipRec = !!req.locals.siprec;
  const session = isSipRec ? new SipRecCallSession(req, res) : new InboundCallSession(req, res);
  if (isSipRec) await session.answerSipRecCall();
  session.exec();
});

const sessionTracker = srf.locals.sessionTracker = require('./lib/session/session-tracker');
sessionTracker.on('idle', () => {
  if (srf.locals.lifecycleEmitter.operationalState === LifeCycleEvents.ScaleIn) {
    logger.info('scale-in complete now that calls have dried up');
    srf.locals.lifecycleEmitter.scaleIn();
  }
});
const getCount = () => sessionTracker.count;

let httpServer;

const monInterval = setInterval(async() => {
  srf.locals.stats.gauge('fs.sip.calls.count', sessionTracker.count);
  try {
    const systemInformation = await srf.locals.dbHelpers.lookupSystemInformation();
    if (systemInformation && systemInformation.log_level) {
      const envLogLevel = logger.levels.values[JAMBONES_LOGLEVEL.toLowerCase()];
      const dbLogLevel = logger.levels.values[systemInformation.log_level];
      const appliedLogLevel = Math.min(envLogLevel, dbLogLevel);
      if (logger.levelVal !== appliedLogLevel) {
        logger.level = logger.levels.labels[Math.min(envLogLevel, dbLogLevel)];
      }
    }
  } catch (err) {
    if (process.env.NODE_ENV === 'test') {
      clearInterval(monInterval);
      logger.error('all tests complete');
    }
    else logger.error({err}, 'Error checking system log level in database');
  }
}, 20000);

const disconnect = () => {
  return new Promise ((resolve) => {
    httpServer?.on('close', resolve);
    httpServer?.close();
    srf.disconnect();
    srf.removeAllListeners();
    srf.locals.mediaservers?.forEach((ms) => ms.disconnect());
  });
};
process.on('SIGTERM', handle);
process.on('SIGINT', handle);

async function handle(signal) {
  const {removeFromSet} = srf.locals.dbHelpers;
  srf.locals.disabled = true;
  logger.info(`got signal ${signal}`);
  const writeSystemAlerts = srf.locals?.writeSystemAlerts;
  if (writeSystemAlerts) {
    // it has to be synchronous call, or else by the time system saves the app terminates
    await writeSystemAlerts({
      system_component: FEATURE_SERVER,
      state : SystemState.Offline,
      fields : {
        detail: `feature-server with process_id ${process.pid} stopped, signal ${signal}`,
        host: srf.locals?.ipv4
      }
    });
  }
  const setName = `${(JAMBONES_CLUSTER_ID || 'default')}:active-fs`;
  const fsServiceUrlSetName = `${(JAMBONES_CLUSTER_ID || 'default')}:fs-service-url`;
  if (setName && srf.locals.localSipAddress) {
    logger.info(`got signal ${signal}, removing ${srf.locals.localSipAddress} from set ${setName}`);
    removeFromSet(setName, srf.locals.localSipAddress);
  }
  if (fsServiceUrlSetName && srf.locals.serviceUrl) {
    logger.info(`got signal ${signal}, removing ${srf.locals.serviceUrl} from set ${fsServiceUrlSetName}`);
    removeFromSet(fsServiceUrlSetName, srf.locals.serviceUrl);
  }
  removeFromSet(FS_UUID_SET_NAME, srf.locals.fsUUID);
  if (K8S) {
    srf.locals.lifecycleEmitter.operationalState = LifeCycleEvents.ScaleIn;
  }
  if (getCount() === 0) {
    logger.info('no calls in progress, exiting');
    process.exit(0);
  }
}

if (JAMBONZ_CLEANUP_INTERVAL_MINS) {
  const {clearFiles} = require('./lib/utils/cron-jobs');

  /* cleanup orphaned files or channels every so often */
  setInterval(async() => {
    try {
      await clearFiles();
    } catch (err) {
      logger.error({err}, 'app.js: error clearing files');
    }
  }, getCleanupIntervalMins());
}

module.exports = {srf, logger, disconnect};
