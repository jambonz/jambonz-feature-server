const config = require('config');
const ip = require('ip');
const localIp = ip.address();
const PORT = process.env.HTTP_PORT || config.get('defaultHttpPort');

function installSrfLocals(srf, logger) {
  if (srf.locals.dbHelpers) return;

  const {
    lookupAppByPhoneNumber,
    lookupApplicationBySid
  } = require('jambonz-db-helpers')(config.get('mysql'), logger);
  const {
    updateCallStatus,
    retrieveCall,
    listCalls,
    deleteCall
  } = require('jambonz-realtimedb-helpers')(config.get('redis'), logger);

  Object.assign(srf.locals, {
    dbHelpers: {
      lookupAppByPhoneNumber,
      lookupApplicationBySid,
      updateCallStatus,
      retrieveCall,
      listCalls,
      deleteCall
    },
    parentLogger: logger,
    ipv4: localIp,
    serviceUrl: `http://${localIp}:${PORT}`
  });
}

module.exports = installSrfLocals;
