const router = require('express').Router();
const {srf} = require('../../..');

router.post('/drain', async(req, res) => {
  const {logger} = req.app.locals;
  const {setDryUpCalls} = srf.locals;

  logger.info('Received drain request via HTTP API');
  setDryUpCalls();

  res.sendStatus(201);
});

router.post('/undrain', async(req, res) => {
  const {logger} = req.app.locals;
  const {clearDryUpCalls} = srf.locals;

  logger.info('Received undrain request via HTTP API');
  clearDryUpCalls();

  res.sendStatus(201);
});

module.exports = router;
