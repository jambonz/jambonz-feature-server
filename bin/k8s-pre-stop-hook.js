#!/usr/bin/env node
const bent = require('bent');
const getJSON = bent('json');
const PORT = process.env.HTTP_PORT || 3000;

const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

(async function() {

  try {
    do {
      const obj = await getJSON(`http://127.0.0.1:${PORT}/`);
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
})();
