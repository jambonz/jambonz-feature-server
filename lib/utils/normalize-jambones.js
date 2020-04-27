function normalizeJambones(logger, obj) {
  if (!Array.isArray(obj)) throw new Error('malformed jambonz payload: must be array');
  const document = [];
  for (const tdata of obj) {
    if (typeof tdata !== 'object') throw new Error('malformed jambonz payload: must be array of objects');
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
      document.push(tdata);
    }
    else {
      logger.info(tdata, 'malformed jambonz payload: missing verb property');
      throw new Error('malformed jambonz payload: missing verb property');
    }
  }
  logger.debug({document}, `normalizeJambones: returning document with ${document.length} tasks`);
  return document;
}

module.exports = normalizeJambones;

