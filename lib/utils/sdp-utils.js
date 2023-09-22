const sdpTransform = require('sdp-transform');

const isOnhold = (sdp) => {
  return sdp && (sdp.includes('a=sendonly') || sdp.includes('a=inactive'));
};

const mergeSdpMedia = (sdp1, sdp2) => {
  const parsedSdp1 = sdpTransform.parse(sdp1);
  const parsedSdp2 = sdpTransform.parse(sdp2);

  parsedSdp1.media.push(...parsedSdp2.media);
  return sdpTransform.write(parsedSdp1);
};

const extractSdpMedia = (sdp) => {
  const parsedSdp1 = sdpTransform.parse(sdp);
  if (parsedSdp1.media.length > 1) {
    parsedSdp1.media = [parsedSdp1.media[0]];
    const parsedSdp2 = sdpTransform.parse(sdp);
    parsedSdp2.media = [parsedSdp2.media[1]];

    return [sdpTransform.write(parsedSdp1), sdpTransform.write(parsedSdp2)];
  } else {
    return [sdp, sdp];
  }
};

module.exports = {
  isOnhold,
  mergeSdpMedia,
  extractSdpMedia
};
