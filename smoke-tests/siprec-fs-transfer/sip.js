/* the little bit of SIP the two fake endpoints in this test need */

const CRLF = '\r\n';

const parseMsg = (buf) => {
  const s = buf.toString('utf8');
  const i = s.indexOf(CRLF + CRLF);
  const head = i === -1 ? s : s.slice(0, i);
  const body = i === -1 ? '' : s.slice(i + 4);
  const [startLine, ...rawHeaders] = head.split(CRLF);
  const headers = {};
  for (const l of rawHeaders) {
    const m = /^([^:]+):\s*(.*)$/.exec(l);
    if (m && headers[m[1].trim().toLowerCase()] === undefined) {
      headers[m[1].trim().toLowerCase()] = m[2].trim();
    }
  }
  const [method, uri] = startLine.split(/\s+/);
  return {method, uri, startLine, rawHeaders, headers, body};
};

const buildResponse = (req, status, reason, {body, contentType, toTag, contact} = {}) => {
  const out = [`SIP/2.0 ${status} ${reason}`];
  for (const l of req.rawHeaders) {
    const name = l.split(':')[0].trim().toLowerCase();
    if (['via', 'from', 'call-id', 'cseq', 'record-route'].includes(name)) out.push(l);
  }
  let to = req.headers['to'];
  if (toTag && !/;tag=/i.test(to)) to += `;tag=${toTag}`;
  out.push(`To: ${to}`);
  if (contact) out.push(`Contact: <sip:${contact}>`);
  out.push('User-Agent: jambonz-smoke');
  if (body) {
    out.push(`Content-Type: ${contentType}`);
    out.push(`Content-Length: ${Buffer.byteLength(body)}`);
  }
  else out.push('Content-Length: 0');
  return out.join(CRLF) + CRLF + CRLF + (body || '');
};

/* the SDP is one part of a SIPREC multipart body, and the whole body otherwise */
const extractSdp = (body) => {
  const i = body.indexOf('v=0');
  if (i === -1) return null;
  const rest = body.slice(i);
  const m = /\r?\n--/.exec(rest);
  return m ? rest.slice(0, m.index) : rest;
};

/* where the far end wants media: session level c=, overridden per m= section */
const sdpMedia = (sdp) => {
  const sessionIp = (/^c=IN IP4 ([0-9.]+)/m.exec(sdp) || [])[1];
  const out = [];
  const sections = sdp.split(/^m=/m).slice(1);
  for (const sec of sections) {
    const m = /^audio (\d+) [^ ]+ ([^\r\n]+)/.exec(sec);
    if (!m) continue;
    const ip = (/^c=IN IP4 ([0-9.]+)/m.exec(sec) || [])[1] || sessionIp;
    out.push({port: parseInt(m[1], 10), payloads: m[2].trim().split(/\s+/), ip});
  }
  return out;
};

module.exports = {CRLF, parseMsg, buildResponse, extractSdp, sdpMedia};
