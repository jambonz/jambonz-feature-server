module.exports = function(tasks) {
  return `[${tasks.map((t) => t.name).join(',')}]`;
};
