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

const getCodecPlacement = (parsedSdp, codec) => parsedSdp?.media[0]?.rtp?.findIndex((e) => e.codec === codec);

const isOpusFirst = (sdp) => {
  return getCodecPlacement(sdpTransform.parse(sdp), 'opus') === 0;
};

const makeOpusFirst = (sdp) => {
  const parsedSdp = sdpTransform.parse(sdp);
  // Find the index of the OPUS codec
  const opusIndex = getCodecPlacement(parsedSdp, 'opus');

  // Move OPUS codec to the beginning
  if (opusIndex > 0) {
    const opusEntry = parsedSdp.media[0].rtp.splice(opusIndex, 1)[0];
    parsedSdp.media[0].rtp.unshift(opusEntry);

    // Also move the corresponding payload type in the "m" line
    const opusPayloadType = parsedSdp.media[0].payloads.split(' ')[opusIndex];
    const otherPayloadTypes = parsedSdp.media[0].payloads.split(' ').filter((pt) => pt != opusPayloadType);
    parsedSdp.media[0].payloads = [opusPayloadType, ...otherPayloadTypes].join(' ');
  }
  return sdpTransform.write(parsedSdp);
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
  extractSdpMedia,
  isOpusFirst,
  makeOpusFirst
};
