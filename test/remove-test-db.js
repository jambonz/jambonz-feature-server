const test = require('tape') ;
const exec = require('child_process').exec ;
const fs = require('fs');
test('dropping jambones_test database', (t) => {
  exec(`mysql -h 127.0.0.1 -u root --protocol=tcp --port=3360 < ${__dirname}/db/remove_test_db.sql`, (err, stdout, stderr) => {
    if (err) return t.end(err);
    t.pass('database successfully dropped');
    t.end();
  });
});
