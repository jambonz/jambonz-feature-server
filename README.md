# jambones-feature-server ![Build Status](https://github.com/jambonz/jambonz-feature-server/workflows/ci-test/badge.svg)

This application implements the core feature server of the jambones platform.

## Configuration

Configuration is provided via the [npmjs config](https://www.npmjs.com/package/config) package.  The following elements make up the configuration for the application:
##### drachtio server location
```
{
  "drachtio": {
    "port": 3001,
    "secret": "cymru"
  },
```
the `drachtio` object specifies the port to listen on for tcp connections from drachtio servers as well as the shared secret that is used to authenticate to the server.

> Note: either inbound or [outbound connections](https://drachtio.org/docs#outbound-connections) may be used, depending on the configuration supplied.  In production, it is the intent to use outbound connections for easier centralization and clustering of application logic.

##### freeswitch location
```
  "freeswitch: {
    "address": "127.0.0.1",
    "port": 8021,
    "secret": "ClueCon"
  },
```
the `freeswitch` property specifies the location of the freeswitch server to use for media handling.  

##### application log level
```
  "logging": {
    "level": "info"
  }
```
##### mysql server location
Login credentials for the mysql server databas.
```
  "mysql": {
    "host": "127.0.0.1",
    "user": "jambones",
    "password": "jambones",
    "database": "jambones"
  }
```
##### redis server location
Login credentials for the redis server databas.
```
  "redis": {
    "host": "127.0.0.1",
    "port": 6379
  }
```

##### port to listen on for HTTP API requests
The HTTP listen port can be set by the `HTTP_PORT` environment variable, but it not set the default port will be taken from the configuration file.

```
  "defaultHttpPort": 3000,
```

##### REST-initiated outdials
When an outdial is triggered via the REST API, the application needs to select a drachtio sip server to generate the INVITE, and it needs to know the IP addresses of the SBC(s) to send the outbound call through.  Both are provided as arrays in the configuration file, and if more than one is supplied they will be used in a round-robin fashion.

```
  "outdials": {
    "drachtio": [
      {
        "host": "127.0.0.1",
        "port": 9022,
        "secret": "cymru"
      }
    ],
    "sbc": ["127.0.0.1:5060"]
  }
```

#### Running the test suite
The test suite currently only consists of JSON-parsing unit tests.  A full end-to-end sip test suite should be added.
```
npm test
```
