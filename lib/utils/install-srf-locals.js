const ip = require('ip');
const localIp = ip.address();
const PORT = process.env.HTTP_PORT || 3000;

function installSrfLocals(srf, logger) {
  if (srf.locals.dbHelpers) return;

  const freeswitch = process.env.JAMBONES_FREESWITCH
    .split(',')
    .map((fs) => {
      const arr = /^(.*):(.*):(.*)/.exec(fs);
      if (arr) return {address: arr[1], port: arr[2], secret: arr[3]};
    });
  logger.info({freeswitch}, 'freeswitch inventory');

  const sbcs = process.env.JAMBONES_SBCS
    .split(',')
    .map((sbc) => sbc.trim());
  logger.info({sbcs}, 'SBC inventory');

  const drachtio = process.env.JAMBONES_FEATURE_SERVERS
    .split(',')
    .map((fs) => {
      const arr = /^(.*):(.*):(.*)/.exec(fs);
      if (arr) return {host: arr[1], port: arr[2], secret: arr[3]};
    });
  logger.info({drachtio}, 'drachtio feature server inventory');

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
    freeswitch: freeswitch[0],
    sbcs,
    drachtio
  });
}

module.exports = installSrfLocals;
