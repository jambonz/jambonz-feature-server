function normalizeJambones(logger, obj) {
  logger.debug(`normalizeJambones: ${JSON.stringify(obj)}`);
  if (!Array.isArray(obj)) throw new Error('invalid JSON: jambones docs must be array');
  const document = [];
  for (const tdata of obj) {
    if (typeof tdata !== 'object') throw new Error('invalid JSON: jambones docs must be array of objects');
    if ('verb' in tdata) {
      // {verb: 'say', text: 'foo..bar'..}
      const name = tdata.verb;
      const o = {};
      Object.keys(tdata)
        .filter((k) => k !== 'verb')
        .forEach((k) => o[k] = tdata[k]);
      const o2 = {};
      o2[name] = o;
      document.push(o2);
    }
    else if (Object.keys(tdata).length === 1) {
      // {'say': {..}}
      logger.debug(`pushing ${JSON.stringify(tdata)}`);
      document.push(tdata);
    }
    else {
      logger.info(tdata, `invalid JSON: invalid verb form, numkeys ${Object.keys(tdata).length}`);
      throw new Error('invalid JSON: invalid verb form');
    }
  }
  logger.debug(`returning document with ${document.length} tasks`);
  return document;
}

module.exports = normalizeJambones;

