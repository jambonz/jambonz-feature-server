const sdpTransform = require('sdp-transform');

const stripCodecs = (logger, remoteSdp, localSdp) => {
  try {
    const sdp = sdpTransform.parse(remoteSdp);
    const local = sdpTransform.parse(localSdp);
    const m = local.media
      .find((m) => 'audio' === m.type);
    const pt = m.rtp[0].payload;

    /* manipulate on the audio section */
    const audio = sdp.media.find((m) => 'audio' === m.type);

    /* discard all of the codecs except the first in our 200 OK, and telephony-events */
    const ptSaves = audio.rtp
      .filter((r) => r.codec === 'telephone-event' || r.payload === pt)
      .map((r) => r.payload);
    const rtp = audio.rtp.filter((r) => ptSaves.includes(r.payload));

    /* reattach the new rtp sections and  stripped payload list */
    audio.rtp = rtp;
    audio.payloads = rtp.map((r) => r.payload).join(' ');
    return sdpTransform.write(sdp);
  } catch (err) {
    logger.error({err, remoteSdp, localSdp}, 'strip-ancillary-codecs error');
  }
};

module.exports = stripCodecs;

