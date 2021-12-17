#!/usr/bin/env node
const bent = require('bent');
const getCalls = bent('json');
const { exec } = require('child_process');

const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const { readdir, readFile } = require('fs/promises');
const findNodePid = async() => {
  try {
    const files = await (await readdir('/proc')).filter((f) => /^\d+$/.test(f));
    for (const f of files) {
      const contents = await readFile(`/proc/${f}/cmdline`, {encoding: 'utf8'});
      if (contents.replace('\0', ' ').startsWith('node ')) {
        return parseInt(f);
      }
    }
    console.log('pid not found');
  } catch (err) {
    console.log(err, 'Error finding PID');
  }
  process.exit(-1);
};

(async function() {
  const pid = await findNodePid();
  console.log(`k8s-pre-stop-hook: sending SIGUSR2 signal to PID ${pid}`);
  exec(`kill -12 ${pid}`, async(err, stdout, stderr) => {
    if (err) {
      console.log(err, 'Error sending SIGUSR');
      process.exit(-1);
    }

    try {
      do {
        const obj = await getCalls('http://127.0.0.1:3000/');
        const {calls} = obj;
        if (calls === 0) {
          console.log('no calls on the system, we can exit');
          process.exit(0);
        }
        else {
          console.log(`waiting for ${calls} to exit..`);
        }
        await sleep(10000);
      } while (1);
    } catch (err) {
      console.error(err, 'Error querying health endpoint');
      process.exit(-1);
    }
  });
})();
