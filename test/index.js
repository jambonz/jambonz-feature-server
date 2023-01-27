require('./unit-tests');
// First Blog
require('./docker_start');
require('./create-test-db');
require('./account-validation-tests');
require('./webhooks-tests');
require('./say-tests');
require('./gather-tests');
require('./transcribe-tests');
require('./sip-request-tests');
require('./create-call-test');
require('./play-tests');
require('./remove-test-db');
require('./docker_stop');

// 2nd blog
require('./docker_start');
require('./create-test-db');
require('./dial-tests');
require('./listen-tests');
require('./remove-test-db');
require('./docker_stop');
