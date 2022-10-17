const test = require('tape') ;
const exec = require('child_process').exec ;
const fs = require('fs');
const {encrypt} = require('../lib/utils/encrypt-decrypt');

test('creating jambones_test database', (t) => {
  exec(`mysql -h 127.0.0.1 -u root --protocol=tcp --port=3360 < ${__dirname}/db/create_test_db.sql`, (err, stdout, stderr) => {
    console.log(stdout);
    console.log(stderr)
    if (err) return t.end(err);
    t.pass('database successfully created');
    t.end();
  });
});

test('creating schema', (t) => {
  exec(`mysql -h 127.0.0.1 -u root --protocol=tcp --port=3360  -D jambones_test < ${__dirname}/db/create-and-populate-schema.sql`, (err, stdout, stderr) => {
    if (err) return t.end(err);
    t.pass('schema and test data successfully created');

    if (process.env.GCP_JSON_KEY && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      const google_credential = encrypt(process.env.GCP_JSON_KEY);
      const aws_credential = encrypt(JSON.stringify({
        access_key_id: process.env.AWS_ACCESS_KEY_ID,
        secret_access_key: process.env.AWS_SECRET_ACCESS_KEY,
        aws_region: process.env.AWS_REGION
      }));
      const microsoft_credential = encrypt(JSON.stringify({
        region: process.env.MICROSOFT_REGION || 'useast',
        api_key: process.env.MICROSOFT_API_KEY || '1234567890'
      }));
      const cmd = `
UPDATE speech_credentials SET credential='${google_credential}' WHERE vendor='google';
UPDATE speech_credentials SET credential='${aws_credential}' WHERE vendor='aws';
UPDATE speech_credentials SET credential='${microsoft_credential}' WHERE vendor='microsoft';
`;
      const path = `${__dirname}/.creds.sql`;
      fs.writeFileSync(path, cmd);
      exec(`mysql -h 127.0.0.1 -u root --protocol=tcp --port=3360  -D jambones_test < ${path}`, (err, stdout, stderr) => {
        console.log(stdout);
        console.log(stderr);
        if (err) return t.end(err);
        fs.unlinkSync(path)
        fs.writeFileSync(`${__dirname}/credentials/gcp.json`, process.env.GCP_JSON_KEY);
        t.pass('set account-level speech credentials');
        t.end();
      });
    }
    else {
      t.end();
    }
  });
});

