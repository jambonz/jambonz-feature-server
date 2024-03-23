const parseDecibels = (db) => {
  if (!db) return 0;
  if (typeof db === 'number') {
    return db;
  }
  else if (typeof db === 'string') {
    const match = db.match(/([+-]?\d+(\.\d+)?)\s*db/i);
    if (match) {
      return Math.trunc(parseFloat(match[1]));
    } else {
      return 0;
    }
  } else {
    return 0;
  }
};

module.exports = parseDecibels;
