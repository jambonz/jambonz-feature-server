const ip = require('ip');
const localIp = ip.address();
const PORT = process.env.HTTP_PORT || 3000;
const assert = require('assert');

function installSrfLocals(srf, logger) {
  assert(!srf.locals.dbHelpers);

  const {getSBC, getSrf} = require('./sbc-pinger')(logger);
  const freeswitch = process.env.JAMBONES_FREESWITCH
    .split(',')
    .map((fs) => {
      const arr = /^(.*):(.*):(.*)/.exec(fs);
      if (arr) return {address: arr[1], port: arr[2], secret: arr[3]};
    });
  logger.info({freeswitch}, 'freeswitch inventory');

  const StatsCollector = require('jambonz-stats-collector');
  const stats = srf.locals.stats = new StatsCollector(logger);

  const {
    lookupAppByPhoneNumber,
    lookupAppBySid,
    lookupAppByRealm
  } = require('jambonz-db-helpers')({
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
    deleteCall
  } = require('jambonz-realtimedb-helpers')({
    host: process.env.JAMBONES_REDIS_HOST,
    port: process.env.JAMBONES_REDIS_PORT || 6379
  }, logger);

  Object.assign(srf.locals, {
    dbHelpers: {
      lookupAppByPhoneNumber,
      lookupAppBySid,
      lookupAppByRealm,
      updateCallStatus,
      retrieveCall,
      listCalls,
      deleteCall
    },
    parentLogger: logger,
    ipv4: localIp,
    serviceUrl: `http://${localIp}:${PORT}`,
    getSBC,
    getSrf,
    getFreeswitch: () => freeswitch[0],
    stats: stats
  });

  logger.debug({locals: srf.locals}, 'srf.locals installed');
}

module.exports = installSrfLocals;
