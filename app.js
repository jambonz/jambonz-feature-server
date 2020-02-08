const Srf = require('drachtio-srf');
const srf = new Srf();
const Mrf = require('drachtio-fsmrf');
srf.locals.mrf = new Mrf(srf);
const config = require('config');
const PORT = process.env.HTTP_PORT || config.get('defaultHttpPort');
const opts = Object.assign({
  timestamp: () => {return `, "time": "${new Date().toISOString()}"`;}
}, config.get('logging'));
const logger = srf.locals.parentLogger = require('pino')(opts);
const installSrfLocals = require('./lib/utils/install-srf-locals');
installSrfLocals(srf, logger);

const {
  initLocals,
  normalizeNumbers,
  retrieveApplication,
  invokeWebCallback
} = require('./lib/middleware')(srf, logger);


// HTTP
const express = require('express');
const app = express();
app.locals.logger = logger;
const httpRoutes = require('./lib/http-routes');

const InboundCallSession = require('./lib/session/inbound-call-session');


// disable logging in test mode
if (process.env.NODE_ENV === 'test') {
  const noop = () => {};
  logger.info = logger.debug = noop;
  logger.child = () => {return {info: noop, error: noop, debug: noop};};
}

// config dictates whether to use outbound or inbound connections
if (config.has('drachtio.host')) {
  srf.connect(config.get('drachtio'));
  srf.on('connect', (err, hp) => {
    logger.info(`connected to drachtio listening on ${hp}`);
  });
}
else {
  logger.info(`listening for drachtio server traffic on ${JSON.stringify(config.get('drachtio'))}`);
  srf.listen(config.get('drachtio'));
}
if (process.env.NODE_ENV === 'test') {
  srf.on('error', (err) => {
    logger.info(err, 'Error connecting to drachtio');
  });
}

srf.use('invite', [initLocals, normalizeNumbers, retrieveApplication, invokeWebCallback]);

srf.invite((req, res) => {
  const session = new InboundCallSession(req, res);
  session.exec();
});


// HTTP
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/', httpRoutes);
app.use((err, req, res, next) => {
  logger.error(err, 'burped error');
  res.status(err.status || 500).json({msg: err.message});
});
app.listen(PORT);

logger.info(`listening for HTTP requests on port ${PORT}, serviceUrl is ${srf.locals.serviceUrl}`);

module.exports = {srf, logger};
