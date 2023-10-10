const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');
const clearModule = require('clear-module');
const {provisionCallHook, provisionCustomHook} = require('./utils')
const bent = require('bent');
const getJSON = bent('json')

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

function connect(connectable) {
  return new Promise((resolve, reject) => {
    connectable.on('connect', () => {
      return resolve();
    });
  });
}


test('\'sip Indialog\' test Info', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);

    // GIVEN
    const verbs = [
      {
        verb: 'config',
        sipRequestWithinDialogHook: '/customHook'
      },
      {
        verb: 'play',
        url: 'silence_stream://5000',
      }
    ];

    const waitHookVerbs = [
      {
        verb: 'hangup'
      }
    ];

    const from = 'sip_indialog_info';
    await provisionCustomHook(from, waitHookVerbs)
    await provisionCallHook(from, verbs);
    

    // THEN
    await sippUac('uac-success-info-received-bye.xml', '172.38.0.10', from);
    t.pass('sip Info: success send Info');

    // Make sure that sipRequestWithinDialogHook is called and success
    const json = await getJSON(`http:127.0.0.1:3100/lastRequest/${from}_customHook`)
    t.pass(json.body.sip_method === 'INFO', 'sipRequestWithinDialogHook contains sip_method')
    t.pass(json.body.sip_body === 'hello jambonz\r\n', 'sipRequestWithinDialogHook contains sip_method')
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});