const test = require('tape').test ;
const exec = require('child_process').exec ;
const async = require('async');

test('starting docker network..', (t) => {
  exec(`docker-compose -f ${__dirname}/docker-compose-testbed.yaml up -d`, (err, stdout, stderr) => {
    t.end(err);
  });
  
});

  
