const {execSync} = require('child_process');
const {
  JAMBONES_FREESWITCH,
  NODE_ENV,
  JAMBONES_FREESWITCH_MAX_CALL_DURATION_MINS
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

// Disabled in favour of OS Level Cron Job, TODO Remove in later release
//const clearFiles = () => {
  //  //const {logger} = require('../..');
//  /*const out = */ execSync('find /tmp -name "*.mp3" -mtime +2 -exec rm {} \\;');
//  //logger.debug({out}, 'clearFiles: command output');
//}

module.exports = {clearChannels };

