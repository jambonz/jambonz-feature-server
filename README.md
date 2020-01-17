# jambones-feature-server [![Build Status](https://secure.travis-ci.org/jambonz/jambones-feature-server.png)](http://travis-ci.org/jambonz/jambones-feature-server)

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
  "freeswitch: [
    {
      "address": "127.0.0.1",
      "port": 8021,
      "secret": "ClueCon"
    }
  ],
```
the `freeswitch` property specifies an array of freeswitch servers to use to handle incoming calls.  

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
    "host": "localhost",
    "user": "jambones",
    "password": "jambones",
    "database": "jambones"
  }
```

#### Running the test suite
The test suite currently only consists of JSON-parsing unit tests.  A full end-to-end sip test suite should be added.
```
npm test
```
