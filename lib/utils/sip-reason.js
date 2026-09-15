/**
 * RFC 3326 Reason header support.
 *
 * Carriers fronting ISDN/E1 PRI trunks put the authoritative disconnect cause in
 * a Reason header rather than in the SIP status line, e.g.
 *
 *    SIP/2.0 408 Request Timeout
 *    Reason: Q.850 ;cause=18
 *
 * (Q.850 cause 18 is "no user responding" - i.e. nobody answered, not a fault.)
 * Different Q.850 causes can arrive under the same SIP status - 503 may carry
 * cause=38 (network out of order) or cause=41 (temporary failure) - so the status
 * code on its own is not enough to classify the outcome of the call.  We surface
 * the header verbatim on call status events and leave interpretation to the
 * application.
 */

/**
 * Return the Reason header of a SIP message, or undefined if it has none.
 *
 * A message may legally carry more than one Reason header (RFC 3326), and trunks
 * that report both a SIP and a Q.850 cause commonly do.  The drachtio parser joins
 * repeated headers into a single comma-separated string; we pass that through
 * unchanged rather than picking one of them.
 *
 * What reaches us is the header as the SBC relayed it, NOT necessarily the
 * carrier's exact bytes: proxying re-serializes the header, which normalizes the
 * optional whitespace RFC 3326 permits around ';'.  A carrier's
 * "Q.850 ;cause=18" therefore arrives here as "Q.850;cause=18" - confirmed on
 * the wire (external leg vs the leg into this process) and visible in customer
 * captures too.  Consumers should parse tolerantly rather than string-match.
 *
 * @param {object} [msg] - a drachtio SipMessage (request or response), if we have one
 * @returns {string|undefined} the Reason header value, or undefined
 */
const reasonHeaderFromSipMessage = (msg) => {
  if (!msg || typeof msg.get !== 'function') return;
  return msg.get('Reason') || undefined;
};

module.exports = {reasonHeaderFromSipMessage};
