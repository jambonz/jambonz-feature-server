const {execSync} = require('child_process');
const {
  JAMBONES_FREESWITCH,
  NODE_ENV,
  JAMBONES_FREESWITCH_MAX_CALL_DURATION_MINS,
  TMP_FOLDER,
  JAMBONZ_CLEANUP_INTERVAL_MINS
} = require('../config');
const now = Date.now();
const fsInventory = JAMBONES_FREESWITCH
  .split(',')
  .map((fs) => {
    const arr = /^([^:]*):([^:]*):([^:]*)(?::([^:]*))?/.exec(fs);
    const opts = {address: arr[1], port: arr[2], secret: arr[3]};
    if (arr.length > 4) opts.advertisedAddress = arr[4];
    if (NODE_ENV === 'test') opts.listenAddress = '0.0.0.0';
    return opts;
  });

const clearChannels = () => {
  const {logger} = require('../..');
  const pwd = fsInventory[0].secret;
  const maxDurationMins = JAMBONES_FREESWITCH_MAX_CALL_DURATION_MINS;

  const calls = execSync(`/usr/local/freeswitch/bin/fs_cli -p ${pwd} -x "show calls"`, {encoding: 'utf8'})
    .split('\n')
    .filter((line) => line.match(/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{8}/))
    .map((line) => {
      const arr = line.split(',');
      const dt = new Date(arr[2]);
      const duration = (now - dt.getTime()) / 1000;
      return {
        uuid: arr[0],
        time: arr[2],
        duration
      };
    })
    .filter((c) => c.duration > 60 * maxDurationMins);

  if (calls.length > 0) {
    logger.debug(`clearChannels: clearing ${calls.length} old calls longer than ${maxDurationMins} mins`);
    for (const call of calls) {
      const cmd = `/usr/local/freeswitch/bin/fs_cli -p ${pwd} -x "uuid_kill ${call.uuid}"`;
      const out = execSync(cmd, {encoding: 'utf8'});
      logger.debug({out}, 'clearChannels: command output');
    }
  }
  return calls.length;
};

const clearFiles = () => {
 // Remove temp audiofiles that were not auto deleted older 300 min (or CLEANUP_INTERVAL if set) from TMP_FOLDER
 let maxAge = JAMBONZ_CLEANUP_INTERVAL_MINS || 300
 execSync(`/usr/local/bin/cleanup-temp-audiofiles.sh ${maxAge} ${TMP_FOLDER};`);
};


module.exports = {clearChannels, clearFiles};

