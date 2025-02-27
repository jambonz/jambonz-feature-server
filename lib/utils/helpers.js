
const sleepFor = (ms) => new Promise((resolve) => setTimeout(() => resolve(), ms));
module.exports = {
  sleepFor
};
