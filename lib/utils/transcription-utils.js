module.exports = (logger) => {
  const normalizeTranscription = (evt, vendor, channel) => {
    if ('aws' === vendor && Array.isArray(evt) && evt.length > 0) evt = evt[0];
    if ('microsoft' === vendor) {
      const nbest = evt.NBest;
      const language_code = evt.PrimaryLanguage?.Language || this.language;
      const alternatives = nbest ? nbest.map((n) => {
        return {
          confidence: n.Confidence,
          transcript: n.Display
        };
      }) :
        [
          {
            transcript: evt.DisplayText || evt.Text
          }
        ];

      const newEvent = {
        is_final: evt.RecognitionStatus === 'Success',
        channel,
        language_code,
        alternatives
      };
      evt = newEvent;
    }
    evt.channel_tag = channel;
    //logger.debug({evt}, 'normalized transcription');
    return evt;
  };

  return {normalizeTranscription};
};
