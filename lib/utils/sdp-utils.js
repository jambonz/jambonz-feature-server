const isOnhold = (sdp) => {
  return sdp && (sdp.includes('a=sendonly') || sdp.includes('a=inactive'));
};

module.exports = {
  isOnhold
};
