const test = require('tape') ;
const exec = require('child_process').exec ;

test('starting docker network..takes a bit for mysql and freeswitch to come up..patience..', (t) => {
  exec(`docker-compose -f ${__dirname}/docker-compose-testbed.yaml up -d`, (err, stdout, stderr) => {
    t.pass('docker network is up');
    t.end(err);
  });
  
});

  
