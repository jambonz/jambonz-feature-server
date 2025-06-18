
const sleepFor = (ms) => new Promise((resolve) => setTimeout(() => resolve(), ms));
/* Override both destroy and stopTranscription methods
   if isCurTaskTranscribe is true and delayMs is set
   the isCurTaskTranscribe is set in call-session if the task is transcribe
   or the task data has transcribe property
   we need to wait for the delayMs before destroying the endpoint
   and stop transcription
   the reason to override the stopTranscription method is because
   the destroy delay will get the transcripts from ASR to freeswith
   and we don't dealy the stop transcription, the transcripts
   will not come to feature-server, so if we don't delay the stop transcription
  there is no use of delaying the destroy method
  if ignoreCurrentTaskCheck is true, then we don't check the current task
  */

const configureEP = (ep, cs, logger, delayMs, ignoreCurrentTaskCheck = false) => {
  logger.debug('configureEP:: ' +
    ' override endpoint destroy, endpoint stopTranscription');
  const origDestroy = ep.destroy.bind(ep);
  ep.destroy = async() => {
    if (ignoreCurrentTaskCheck || cs?.isCurTaskTranscribe) {
      logger.debug('configureEP: ' +
        ` wait for ${delayMs} MS before destroy`);
      await sleepFor(delayMs);
    }
    await origDestroy();
  };

  const origStopTranscription = ep.stopTranscription.bind(ep);
  ep.stopTranscription = async(...args) => {
    if (ignoreCurrentTaskCheck || cs?.isCurTaskTranscribe) {
      logger.debug('configureEP: ' +
        ` wait for ${delayMs} MS before stop transcription`);
      await sleepFor(delayMs);
    }
    await origStopTranscription(...args);
  };
};
module.exports = {
  sleepFor,
  configureEP
};
