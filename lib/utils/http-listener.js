
const express = require('express');
const httpRoutes = require('../http-routes');
const {PORT, HTTP_PORT_MAX} = require('../config');

const doListen = (logger, app, port, resolve) => {
  const server = app.listen(port, () => {
    const {srf} = app.locals;
    srf.locals.serviceUrl = `http://${srf.locals.ipv4}:${port}`;
    logger.info(`listening for HTTP requests on port ${port}, serviceUrl is ${srf.locals.serviceUrl}`);
    resolve({server, app});
  });
  return server;
};
const handleErrors = (logger, app, resolve, reject, e) => {
  if (e.code === 'EADDRINUSE' &&
    HTTP_PORT_MAX &&
    e.port < HTTP_PORT_MAX) {

    logger.info(`HTTP server failed to bind port on ${e.port}, will try next port`);
    const server = doListen(logger, app, ++e.port, resolve);
    server.on('error', handleErrors.bind(null, logger, app, resolve, reject));
    return;
  }
  logger.info({err: e, port: PORT}, 'httpListener error');
  reject(e);
};

const createHttpListener = (logger, srf) => {
  const app = express();
  app.locals = {...app.locals, logger, srf};
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use('/', httpRoutes);
  app.use((err, _req, res, _next) => {
    logger.error(err, 'burped error');
    res.status(err.status || 500).json({msg: err.message});
  });
  return new Promise((resolve, reject) => {
    const server = doListen(logger, app, PORT, resolve);
    server.on('error', handleErrors.bind(null, logger, app, resolve, reject));
  });
};


module.exports = createHttpListener;
