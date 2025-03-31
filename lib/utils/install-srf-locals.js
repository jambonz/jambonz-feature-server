const Mrf = require('drachtio-fsmrf');
const os = require('os');
const {
  JAMBONES_MYSQL_HOST,
  JAMBONES_MYSQL_USER,
  JAMBONES_MYSQL_PASSWORD,
  JAMBONES_MYSQL_DATABASE,
  JAMBONES_MYSQL_CONNECTION_LIMIT,
  JAMBONES_MYSQL_PORT,
  JAMBONES_FREESWITCH,
  SMPP_URL,
  JAMBONES_TIME_SERIES_HOST,
  JAMBONES_ESL_LISTEN_ADDRESS,
  PORT,
  HTTP_IP,
  NODE_ENV,
} = require('../config');
const Registrar = require('@jambonz/mw-registrar');
const assert = require('assert');

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const interfaceName in interfaces) {
    const interface = interfaces[interfaceName];
    for (const iface of interface) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1'; // Fallback to localhost if no suitable interface found
}

function initMS(logger, wrapper, ms, {
  onFreeswitchConnect,
  onFreeswitchDisconnect
}) {
  Object.assign(wrapper, {ms, active: true, connects: 1});
  logger.info(`connected to freeswitch at ${ms.address}`);

  onFreeswitchConnect(wrapper);

  ms.conn
    .on('esl::end', () => {
      wrapper.active = false;
      wrapper.connects = 0;
      logger.info(`lost connection to freeswitch at ${ms.address}`);
      onFreeswitchDisconnect(wrapper);
      ms.removeAllListeners();
    })
    .on('esl::ready', () => {
      if (wrapper.connects > 0) {
        logger.info(`esl::ready connected to freeswitch at ${ms.address}`);
      }
      wrapper.connects = 1;
      wrapper.active = true;
    });

  ms.on('channel::open', (evt) => {
    logger.debug({evt}, `mediaserver ${ms.address} added endpoint`);
  });
  ms.on('channel::close', (evt) => {
    logger.debug({evt}, `mediaserver ${ms.address} removed endpoint`);
  });
}

function installSrfLocals(srf, logger, {
  onFreeswitchConnect = () => {},
  onFreeswitchDisconnect = () => {}
}) {
  logger.debug('installing srf locals');
  assert(!srf.locals.dbHelpers);
  const {tracer} = srf.locals.otel;
  const {getSBC, lifecycleEmitter} = require('./sbc-pinger')(logger);
  const StatsCollector = require('@jambonz/stats-collector');
  const stats = srf.locals.stats = new StatsCollector(logger);

  // freeswitch connections (typically we connect to only one)
  const mrf = new Mrf(srf);
  const mediaservers = [];
  let idxStart = 0;

  (async function() {
    const fsInventory = JAMBONES_FREESWITCH
      .split(',')
      .map((fs) => {
        const arr = /^([^:]*):([^:]*):([^:]*)(?::([^:]*))?/.exec(fs);
        assert.ok(arr, `Invalid syntax JAMBONES_FREESWITCH: ${JAMBONES_FREESWITCH}`);
        const opts = {address: arr[1], port: arr[2], secret: arr[3]};
        if (arr.length > 4) opts.advertisedAddress = arr[4];
        /* NB: originally for testing only, but for now all jambonz deployments
          have freeswitch installed locally alongside this app
        */
        if (NODE_ENV === 'test') opts.listenAddress = '0.0.0.0';
        else if (JAMBONES_ESL_LISTEN_ADDRESS) opts.listenAddress = JAMBONES_ESL_LISTEN_ADDRESS;
        return opts;
      });
    logger.info({fsInventory}, 'freeswitch inventory');

    for (const fs of fsInventory) {
      const val = {opts: fs, active: false, connects: 0};
      mediaservers.push(val);
      try {
        const ms = await mrf.connect(fs);
        initMS(logger, val, ms, {
          onFreeswitchConnect,
          onFreeswitchDisconnect
        });
      }
      catch (err) {
        logger.info({err}, `failed connecting to freeswitch at ${fs.address}, will retry shortly: ${err.message}`);
      }
    }
    // retry to connect to any that were initially offline
    setInterval(async() => {
      for (const val of mediaservers) {
        if (val.connects === 0) {
          try {
            // make sure all listeners are removed before reconnecting
            val.ms?.disconnect();
            val.ms = null;
            logger.info({mediaserver: val.opts}, 'Retrying initial connection to media server');
            const ms = await mrf.connect(val.opts);
            initMS(logger, val, ms, {
              onFreeswitchConnect,
              onFreeswitchDisconnect
            });
          } catch (err) {
            logger.info({err}, `failed connecting to freeswitch at ${val.opts.address}, will retry shortly`);
          }
        }
      }
    }, 3000);

    // if we have a single freeswitch (as is typical) report stats periodically
    if (mediaservers.length === 1) {
      srf.locals.mediaservers = [mediaservers[0].ms];
      setInterval(() => {
        try {
          if (mediaservers[0].ms && mediaservers[0].active) {
            const ms = mediaservers[0].ms;
            stats.gauge('fs.media.channels.in_use', ms.currentSessions);
            stats.gauge('fs.media.channels.free', ms.maxSessions - ms.currentSessions);
            stats.gauge('fs.media.calls_per_second', ms.cps);
            stats.gauge('fs.media.cpu_idle', ms.cpuIdle);
          }
        }
        catch (err) {
          logger.info(err, 'Error sending media server metrics');
        }
      }, 30000);
    }
  })();

  /**
   * return an active media server
   */
  function getFreeswitch() {
    const active = mediaservers.filter((mediaserver) => mediaserver.active);
    if (active.length === 0) return null;
    return active[idxStart++ % active.length].ms;
  }

  const {
    pool,
    lookupAppByPhoneNumber,
    lookupAppByRegex,
    lookupAppBySid,
    lookupAppByRealm,
    lookupAppByTeamsTenant,
    lookupTeamsByAccount,
    lookupAccountBySid,
    lookupAccountCapacitiesBySid,
    lookupSmppGateways,
    lookupClientByAccountAndUsername,
    lookupSystemInformation
  } = require('@jambonz/db-helpers')({
    host: JAMBONES_MYSQL_HOST,
    user: JAMBONES_MYSQL_USER,
    port: JAMBONES_MYSQL_PORT || 3306,
    password: JAMBONES_MYSQL_PASSWORD,
    database: JAMBONES_MYSQL_DATABASE,
    connectionLimit: JAMBONES_MYSQL_CONNECTION_LIMIT || 10
  }, logger);
  const {
    client,
    updateCallStatus,
    retrieveCall,
    listCalls,
    deleteCall,
    createHash,
    retrieveHash,
    deleteKey,
    addKey,
    retrieveKey,
    retrieveSet,
    addToSet,
    removeFromSet,
    monitorSet,
    pushBack,
    popFront,
    removeFromList,
    getListPosition,
    lengthOfList,
    addToSortedSet,
    retrieveFromSortedSet,
    retrieveByPatternSortedSet,
    sortedSetLength,
    sortedSetPositionByPattern,
  } = require('@jambonz/realtimedb-helpers')({}, logger, tracer);
  const registrar = new Registrar(logger, client);
  const {
    synthAudio,
    addFileToCache,
    getNuanceAccessToken,
    getIbmAccessToken,
    getAwsAuthToken,
    getVerbioAccessToken
  } = require('@jambonz/speech-utils')({}, logger);
  const {
    writeAlerts,
    AlertType,
    writeSystemAlerts
  } = require('@jambonz/time-series')(logger, {
    host: JAMBONES_TIME_SERIES_HOST,
    commitSize: 50,
    commitInterval: 'test' === NODE_ENV ? 7 : 20
  });

  let localIp;
  try {
    // Either use the configured IP address or discover it
    localIp = HTTP_IP || getLocalIp();
  } catch (err) {
    logger.error({err}, 'installSrfLocals - error detecting local ipv4 address');
  }

  srf.locals = {...srf.locals,
    dbHelpers: {
      client,
      registrar,
      pool,
      lookupAppByPhoneNumber,
      lookupAppByRegex,
      lookupAppBySid,
      lookupAppByRealm,
      lookupAppByTeamsTenant,
      lookupTeamsByAccount,
      lookupAccountBySid,
      lookupAccountCapacitiesBySid,
      lookupSmppGateways,
      lookupClientByAccountAndUsername,
      lookupSystemInformation,
      updateCallStatus,
      retrieveCall,
      listCalls,
      deleteCall,
      synthAudio,
      getAwsAuthToken,
      addFileToCache,
      createHash,
      retrieveHash,
      deleteKey,
      addKey,
      retrieveKey,
      retrieveSet,
      addToSet,
      removeFromSet,
      monitorSet,
      pushBack,
      popFront,
      removeFromList,
      lengthOfList,
      getListPosition,
      getNuanceAccessToken,
      getIbmAccessToken,
      addToSortedSet,
      retrieveFromSortedSet,
      retrieveByPatternSortedSet,
      sortedSetLength,
      sortedSetPositionByPattern,
      getVerbioAccessToken
    },
    parentLogger: logger,
    getSBC,
    getSmpp: () => {
      return SMPP_URL;
    },
    lifecycleEmitter,
    getFreeswitch,
    stats: stats,
    writeAlerts,
    AlertType,
    writeSystemAlerts
  };

  if (localIp) {
    srf.locals.ipv4 = localIp;
    srf.locals.serviceUrl = `http://${localIp}:${PORT}`;
  }
}

module.exports = installSrfLocals;
