#!/usr/bin/env node
const bent = require('bent');
const getCalls = bent('json');
const { exec } = require('child_process');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log('k8s-pre-stop-hook: sending SIGUSR signal to node process');
exec('pkill -SIGUSR2 node', async(err, stdout, stderr) => {
  if (err) {
    console.log(err, 'Error sending SIGUSR');
    process.exit(-1);
  }
  console.log(`pkill output: ${stdout}`);
  if (stderr) console.log(`pkill stderr: ${stderr}`);

  try {
    do {
      const obj = await getCalls('http://127.0.0.1:3000/');
      console.log(obj, 'query output');
      const {calls} = obj;
      console.log(`call count: ${calls}`);
      if (calls === 0) process.exit(0);
      sleep(5000);
    } while (1);
  } catch (err) {
    console.error(err, 'Error querying health endpoint');
    process.exit(-1);
  }
});
