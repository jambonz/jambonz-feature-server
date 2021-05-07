const snakeCase = require('to-snake-case');

const isObject = (value) => typeof value === 'object' && value !== null;

const snakeObject = (obj, excludes) => {
  if (Array.isArray(obj)) return obj.map((o) => {
    return isObject(o) ? snakeObject(o, excludes) : o;
  });

  const target = {};
  for (const [key, value] of Object.entries(obj)) {
    if (excludes.includes(key)) {
      target[key] = value;
      continue;
    }
    const newKey = snakeCase(key);
    const newValue = isObject(value) ? snakeObject(value, excludes) : value;
    target[newKey] = newValue;
  }
  return target;
};

module.exports = (obj, excludes = []) => {
  return snakeObject(obj, excludes);
};
