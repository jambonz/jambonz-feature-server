const test = require('tape') ;
const exec = require('child_process').exec ;
const fs = require('fs');
const {encrypt} = require('../lib/utils/encrypt-decrypt');
const {
  GCP_JSON_KEY,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION,
  MICROSOFT_REGION,
  MICROSOFT_API_KEY,
} = require('../lib/config');

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

    const sql = [];
    if (GCP_JSON_KEY) {
      const google_credential = encrypt(GCP_JSON_KEY);
      t.pass('adding google credentials');
      sql.push(`UPDATE speech_credentials SET credential='${google_credential}' WHERE vendor='google';`);
    }
    if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
      const aws_credential = encrypt(JSON.stringify({
        access_key_id: AWS_ACCESS_KEY_ID,
        secret_access_key: AWS_SECRET_ACCESS_KEY,
        aws_region: AWS_REGION
      }));
      t.pass('adding aws credentials');
      sql.push(`UPDATE speech_credentials SET credential='${aws_credential}' WHERE vendor='aws';`);
    }
    if (MICROSOFT_REGION && MICROSOFT_API_KEY) {
      const microsoft_credential = encrypt(JSON.stringify({
        region: MICROSOFT_REGION,
        api_key: MICROSOFT_API_KEY
      }));
      t.pass('adding microsoft credentials');
      sql.push(`UPDATE speech_credentials SET credential='${microsoft_credential}' WHERE vendor='microsoft';`);
    }
    if (sql.length > 0) {
      const path = `${__dirname}/.creds.sql`;
      const cmd = sql.join('\n');
      fs.writeFileSync(path, sql.join('\n'));
      exec(`mysql -h 127.0.0.1 -u root --protocol=tcp --port=3360  -D jambones_test < ${path}`, (err, stdout, stderr) => {
        console.log(stdout);
        console.log(stderr);
        if (err) return t.end(err);
        fs.unlinkSync(path)
        t.pass('set account-level speech credentials');
        t.end();
      });
    }
    else {
      t.end();
    }
  });
});

