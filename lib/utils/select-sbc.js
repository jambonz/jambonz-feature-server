const CIDRMatcher = require('cidr-matcher');
const matcher = new CIDRMatcher([process.env.JAMBONES_NETWORK_CIDR]);

module.exports = (sbcList) => {
  const obj = sbcList
    .split(',')
    .map((str) => {
      const arr = /^(.*)\/(.*):(\d+)$/.exec(str);
      return {protocol: arr[1], host: arr[2], port: arr[3]};
    })
    .find((obj) => 'udp' == obj.protocol && matcher.contains(obj.host));
  if (obj) return `${obj.host}:${obj.port}`;
};
