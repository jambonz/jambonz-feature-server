const test = require('tape');
const debug = require('debug')('drachtio:jambonz:test');
const makeTask = require('../lib/tasks/make_task');
const noop = () => {};
const logger = {error: noop, info: noop, debug: noop};


process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

test('unit tests', (t) => {
  let task = makeTask(logger, require('./data/good/sip-decline'));
  t.ok(task.name === 'sip:decline', 'parsed sip:decline');

  t.throws(errInvalidInstruction, /malformed jambonz application payload/, 'throws error for invalid instruction');
  t.throws(errUnknownProperty, /unknown property/, 'throws error for invalid instruction');
  t.throws(errMissingProperty, /missing value/, 'throws error for missing required property');
  t.throws(errInvalidType, /invalid data type/, 'throws error for invalid data type');
  t.throws(errBadEnum, /must be one of/, 'throws error for invalid enum');
  t.throws(errBadPayload, /malformed jambonz application payload/, 'throws error for invalid payload with multiple keys');
  t.throws(errBadPayload2, /malformed jambonz application payload/, 'throws error for invalid payload that is not an object');

  task = makeTask(logger, require('./data/good/dial-phone'));
  t.ok(task.name === 'dial', 'parsed dial phone');

  task = makeTask(logger, require('./data/good/dial-sip'));
  t.ok(task.name === 'dial', 'parsed dial sip');

  task = makeTask(logger, require('./data/good/dial-user'));
  t.ok(task.name === 'dial', 'parsed dial user');

  task = makeTask(logger, require('./data/good/dial-transcribe'));
  t.ok(task.name === 'dial', 'parsed dial w/ transcribe');

  task = makeTask(logger, require('./data/good/dial-listen'));
  t.ok(task.name === 'dial', 'parsed dial w/ listen');

  task = makeTask(logger, require('./data/good/pause'));
  t.ok(task.name === 'pause', 'parsed pause');

  task = makeTask(logger, require('./data/good/say'));
  t.ok(task.name === 'say', 'parsed say');

  task = makeTask(logger, require('./data/good/say-text-array'));
  t.ok(task.name === 'say', 'parsed say with multiple segments');
  
  task = makeTask(logger, require('./data/good/say-ssml'));
  // the ssml is more than 1000 chars, 
  // expecting first chunk is length > 100, stop at ? instead of first .
  // 2nd chunk is long text < 1000 char, stop at .
  // 3rd chunk is the rest.
  t.ok(task.text.length === 3 &&
    task.text[0].length === 187 &&
    task.text[1].length === 882 &&
    task.text[2].length === 123, 'parsed say');

  task = makeTask(logger, require('./data/bad/bad-say-ssml'));
  t.ok(task.text.length === 1 &&
    task.text[0].length === 1162, 'parsed bad say');

  
  const alt = require('./data/good/alternate-syntax');
  const { normalizeJambones } = require('@jambonz/verb-specifications');
  normalizeJambones(logger, alt).forEach((t) => {
    const task = makeTask(logger, t);
  });
  t.pass('alternate syntax works');

  t.end();
});


const errInvalidInstruction = () => makeTask(logger, require('./data/bad/unknown-instruction'));
const errUnknownProperty = () => makeTask(logger, require('./data/bad/unknown-property'));
const errMissingProperty = () => makeTask(logger, require('./data/bad/missing-required-property'));
const errInvalidType = () => makeTask(logger, require('./data/bad/invalid-type'));
const errBadEnum = () => makeTask(logger, require('./data/bad/bad-enum'));
const errBadPayload = () => makeTask(logger, require('./data/bad/bad-payload'));
const errBadPayload2 = () => makeTask(logger, require('./data/bad/bad-payload2'));