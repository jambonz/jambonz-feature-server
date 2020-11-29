const Mrf = require('drachtio-fsmrf');
const ip = require('ip');
const localIp = ip.address();
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
}

function installSrfLocals(srf, logger) {
  logger.debug('installing srf locals');
  assert(!srf.locals.dbHelpers);
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
        const arr = /^(.*):(.*):(.*)/.exec(fs);
        assert.ok(arr, `Invalid syntax JAMBONES_FREESWITCH: ${process.env.JAMBONES_FREESWITCH}`);
        return {address: arr[1], port: arr[2], secret: arr[3]};
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
        logger.info(`failed connecting to freeswitch at ${fs.address}, will retry shortly`);
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
            logger.info(`failed connecting to freeswitch at ${val.opts.address}, will retry shortly`);
          }
        }
      }
    }, 3000);

    // if we have a single freeswitch (as is typical) report stats periodically
    if (mediaservers.length === 1) {
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
    lookupAppByPhoneNumber,
    lookupAppBySid,
    lookupAppByRealm,
    lookupAppByTeamsTenant,
    lookupTeamsByAccount,
    lookupAccountBySid
  } = require('@jambonz/db-helpers')({
    host: process.env.JAMBONES_MYSQL_HOST,
    user: process.env.JAMBONES_MYSQL_USER,
    password: process.env.JAMBONES_MYSQL_PASSWORD,
    database: process.env.JAMBONES_MYSQL_DATABASE,
    connectionLimit: process.env.JAMBONES_MYSQL_CONNECTION_LIMIT || 10
  }, logger);
  const {
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
    pushBack,
    popFront,
    removeFromList,
    lengthOfList,
    getListPosition
  } = require('@jambonz/realtimedb-helpers')({
    host: process.env.JAMBONES_REDIS_HOST,
    port: process.env.JAMBONES_REDIS_PORT || 6379
  }, logger);

  Object.assign(srf.locals, {
    dbHelpers: {
      lookupAppByPhoneNumber,
      lookupAppBySid,
      lookupAppByRealm,
      lookupAppByTeamsTenant,
      lookupTeamsByAccount,
      lookupAccountBySid,
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
      pushBack,
      popFront,
      removeFromList,
      lengthOfList,
      getListPosition
    },
    parentLogger: logger,
    ipv4: localIp,
    serviceUrl: `http://${localIp}:${PORT}`,
    getSBC,
    lifecycleEmitter,
    getFreeswitch,
    stats: stats
  });
}

module.exports = installSrfLocals;
