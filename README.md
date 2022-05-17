# jambones-feature-server ![Build Status](https://github.com/jambonz/jambonz-feature-server/workflows/CI/badge.svg)

This application implements the core feature server of the jambones platform.

> Note: If you are a developer looking to work on the code please read  our [how-to for that](./docs/contributing.md).

## Configuration

Configuration is provided via environment variables:

| variable | meaning | required?|
|----------|----------|---------|
|AWS_ACCESS_KEY_ID| aws access key id, used for TTS/STT as well SNS notifications|no|
|AWS_REGION| aws region| no|
|AWS_SECRET_ACCESS_KEY| aws secret access key, used per above|no|
|AWS_SNS_TOPIC_ARM| aws sns topic arn that scale-in lifecycle notifications will be published to|no|
|DRACHTIO_HOST| ip address of drachtio server (typically '127.0.0.1')|yes|
|DRACHTIO_PORT| listening port of drachtio server for control connections (typically 9022)|yes|
|DRACHTIO_SECRET| shared secret|yes|
|ENABLE_METRICS| if 1, metrics will be generated|no|
|GOOGLE_APPLICATION_CREDENTIALS| path to gcp service key file|yes|
|HTTP_PORT| tcp port to listen on for API requests from jambonz-api-server|yes|
|JAMBONES_FREESWITCH| IP:port:secret for Freeswitch server (e.g. '127.0.0.1:8021:JambonzR0ck$'|yes|
|JAMBONES_LOGLEVEL| log level for application, 'info' or 'debug'|no|
|JAMBONES_MYSQL_HOST| mysql host|yes|
|JAMBONES_MYSQL_USER| mysql username|yes|
|JAMBONES_MYSQL_PASSWORD|  mysql password|yes|
|JAMBONES_MYSQL_DATABASE| mysql data|yes|
|JAMBONES_MYSQL_CONNECTION_LIMIT| mysql connection limit |no|
|JAMBONES_NETWORK_CIDR| CIDR of private network that feature server is running in (e.g. '172.31.0.0/16')|yes|
|JAMBONES_REDIS_HOST| redis host|yes|
|JAMBONES_REDIS_PORT|redis port|yes|
|JAMBONES_SBCS| list of IP addresses (on the internal network) of SBCs, comma-separated|yes|
|STATS_HOST| ip address of metrics host (usually '127.0.0.1' since telegraf is installed locally|no|
|STATS_PORT| listening port for metrics host|no|
|STATS_PROTOCOL| 'tcp' or 'udp'|no|
|STATS_TELEGRAF| if 1, metrics will be generated in telegraf format|no|

### running under pm2
Typically, this application runs under [pm2](https://pm2.io) using an [ecosystem.config.js](https://pm2.keymetrics.io/docs/usage/application-declaration/) file similar to this:
```js
module.exports = {
  apps : [
  {
    name: 'jambonz-feature-server',
    cwd: '/home/admin/apps/jambonz-feature-server',
    script: 'app.js',
    instance_var: 'INSTANCE_ID',
    out_file: '/home/admin/.pm2/logs/jambonz-feature-server.log',
    err_file: '/home/admin/.pm2/logs/jambonz-feature-server.log',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      GOOGLE_APPLICATION_CREDENTIALS: '/home/admin/credentials/gcp.json',
      AWS_ACCESS_KEY_ID: 'XXXXXXXXXXXX',
      AWS_SECRET_ACCESS_KEY: 'YYYYYYYYYYYYYYYYYYYYY',
      AWS_REGION: 'us-west-1',
      ENABLE_METRICS: 1,
      STATS_HOST: '127.0.0.1',
      STATS_PORT: 8125,
      STATS_PROTOCOL: 'tcp',
      STATS_TELEGRAF: 1,
      AWS_SNS_TOPIC_ARM: 'arn:aws:sns:us-west-1:xxxxxxxxxxx:terraform-20201107200347128600000002',
      JAMBONES_NETWORK_CIDR: '172.31.0.0/16',
      JAMBONES_MYSQL_HOST: 'aurora-cluster-jambonz.cluster-yyyyyyyyyyy.us-west-1.rds.amazonaws.com',
      JAMBONES_MYSQL_USER: 'admin',
      JAMBONES_MYSQL_PASSWORD: 'foobarbz',
      JAMBONES_MYSQL_DATABASE: 'jambones',
      JAMBONES_MYSQL_CONNECTION_LIMIT: 10,
      JAMBONES_REDIS_HOST: 'jambonz.zzzzzzz.0001.usw1.cache.amazonaws.com',
      JAMBONES_REDIS_PORT: 6379,
      JAMBONES_LOGLEVEL: 'debug',
      HTTP_PORT: 3000,
      DRACHTIO_HOST: '127.0.0.1',
      DRACHTIO_PORT: 9022,
      DRACHTIO_SECRET: 'sharedsecret',
      JAMBONES_SBCS: '172.31.32.10',
      JAMBONES_FREESWITCH: '127.0.0.1:8021:sharedsecret'
    }
  }]
};
```

#### Running the test suite

Please [see this]](./docs/contributing.md#run-the-regression-test-suite).