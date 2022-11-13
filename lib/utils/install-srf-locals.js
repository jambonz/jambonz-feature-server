const Mrf = require('drachtio-fsmrf');
const ip = require('ip');
const PORT = process.env.HTTP_PORT || 3000;
const assert = require('assert');

function initMS(logger, wrapper, ms) {
  Object.assign(wrapper, {ms, active: true, connects: 1});
  logger.info(`connected to freeswitch at ${ms.address}`);

  ms.conn
    .on('esl::end', () => {
      wrapper.active = false;
      logger.info(`lost connection to freeswitch at ${ms.address}`);
    })
    .on('esl::ready', () => {
      if (wrapper.connects > 0) {
        logger.info(`connected to freeswitch at ${ms.address}`);
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

function installSrfLocals(srf, logger) {
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
    const fsInventory = process.env.JAMBONES_FREESWITCH
      .split(',')
      .map((fs) => {
        const arr = /^([^:]*):([^:]*):([^:]*)(?::([^:]*))?/.exec(fs);
        assert.ok(arr, `Invalid syntax JAMBONES_FREESWITCH: ${process.env.JAMBONES_FREESWITCH}`);
        const opts = {address: arr[1], port: arr[2], secret: arr[3]};
        if (arr.length > 4) opts.advertisedAddress = arr[4];
        /* NB: originally for testing only, but for now all jambonz deployments
          have freeswitch installed locally alongside this app
        */
        if (process.env.NODE_ENV === 'test') opts.listenAddress = '0.0.0.0';
        else if (process.env.JAMBONES_ESL_LISTEN_ADDRESS) opts.listenAddress = process.env.JAMBONES_ESL_LISTEN_ADDRESS;
        return opts;
      });
    logger.info({fsInventory}, 'freeswitch inventory');

    for (const fs of fsInventory) {
      const val = {opts: fs, active: false, connects: 0};
      mediaservers.push(val);
      try {
        const ms = await mrf.connect(fs);
        initMS(logger, val, ms);
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
            logger.info({mediaserver: val.opts}, 'Retrying initial connection to media server');
            const ms = await mrf.connect(val.opts);
            initMS(logger, val, ms);
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
    lookupSmppGateways
  } = require('@jambonz/db-helpers')({
    host: process.env.JAMBONES_MYSQL_HOST,
    user: process.env.JAMBONES_MYSQL_USER,
    port: process.env.JAMBONES_MYSQL_PORT || 3306,
    password: process.env.JAMBONES_MYSQL_PASSWORD,
    database: process.env.JAMBONES_MYSQL_DATABASE,
    connectionLimit: process.env.JAMBONES_MYSQL_CONNECTION_LIMIT || 10
  }, logger, tracer);
  const {
    client,
    updateCallStatus,
    retrieveCall,
    listCalls,
    deleteCall,
    synthAudio,
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
  } = require('@jambonz/realtimedb-helpers')({
    host: process.env.JAMBONES_REDIS_HOST,
    port: process.env.JAMBONES_REDIS_PORT || 6379
  }, logger, tracer);
  const {
    writeAlerts,
    AlertType
  } = require('@jambonz/time-series')(logger, {
    host: process.env.JAMBONES_TIME_SERIES_HOST,
    commitSize: 50,
    commitInterval: 'test' === process.env.NODE_ENV ? 7 : 20
  });

  let localIp;
  try {
    localIp = ip.address();
  } catch (err) {
    logger.error({err}, 'installSrfLocals - error detecting local ipv4 address');
  }

  srf.locals = {...srf.locals,
    dbHelpers: {
      client,
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
      updateCallStatus,
      retrieveCall,
      listCalls,
      deleteCall,
      synthAudio,
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
      getIbmAccessToken
    },
    parentLogger: logger,
    getSBC,
    getSmpp: () => {
      return process.env.SMPP_URL;
    },
    lifecycleEmitter,
    getFreeswitch,
    stats: stats,
    writeAlerts,
    AlertType
  };

  if (localIp) {
    srf.locals.ipv4 = localIp;
    srf.locals.serviceUrl = `http://${localIp}:${PORT}`;
  }
}

module.exports = installSrfLocals;
