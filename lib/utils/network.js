
/**
 * Parses a list of hostport entries and selects the first one that matches the specified protocol,
 * excluding any entries with the localhost IP address ('127.0.0.1').
 *
 * Each hostport entry should be in the format: 'protocol/ip:port'
 *
 * @param {Object} logger - A logging object with a 'debug' method for logging debug messages.
 * @param {string} hostport - A comma-separated string containing hostport entries.
 * @param {string} protocol - The protocol to match (e.g., 'udp', 'tcp').
 * @returns {Array} An array containing:
 * 0: protocol
 * 1: ip address
 * 2: port
 */
const selectHostPort = (logger, hostport, protocol) => {
  logger.debug(`selectHostPort: ${hostport}, ${protocol}`);
  const sel = hostport
    .split(',')
    .map((hp) => {
      const arr = /(.*)\/(.*):(.*)/.exec(hp);
      return [arr[1], arr[2], arr[3]];
    })
    .filter((hp) => {
      return hp[0] === protocol && hp[1] !== '127.0.0.1';
    });
  return sel[0];
};

module.exports = {
  selectHostPort
};
