'use strict';

/**
 * Minimal SIPREC recorder: answers the SIPREC INVITE, then counts the RTP it is
 * forked. Enough to tell "still receiving media" from "went silent", which is
 * what the cross-feature-server transfer breaks.
 */

const dgram = require('dgram');
const Emitter = require('events');

const CRLF = '\r\n';
const BUCKET_MS = 250;

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

/* the SDP we care about is one part of the SIPREC multipart body */
const extractSdp = (body) => {
  const i = body.indexOf('v=0');
  if (i === -1) return null;
  const rest = body.slice(i);
  const m = /\r?\n--/.exec(rest);
  return m ? rest.slice(0, m.index) : rest;
};

const answerPayloads = (fmt) => {
  const offered = fmt.trim().split(/\s+/);
  const audio = ['0', '8', '18', '9'].find((p) => offered.includes(p)) || offered[0];
  return offered.includes('101') ? [audio, '101'] : [audio];
};

class FakeSrs extends Emitter {
  constructor(logger, {sipPort, rtpPortBase, advertiseIp}) {
    super();
    this.logger = logger;
    this.sipPort = sipPort;
    this.rtpPortBase = rtpPortBase;
    this.advertiseIp = advertiseIp;
    this.toTag = `srs-${Math.random().toString(36).slice(2, 10)}`;
    this.sdpVersion = 1;
    this.dialog = null;
    this.streams = [];
    this.events = [];
    this.lastResponse = null;
  }

  async start() {
    this.sip = dgram.createSocket('udp4');
    this.sip.on('message', (msg, rinfo) => this._onSip(msg, rinfo));
    await new Promise((resolve) => this.sip.bind(this.sipPort, resolve));
    this.logger(`fake SRS listening on sip:${this.advertiseIp}:${this.sipPort}`);
  }

  async stop() {
    this.sip?.close();
    for (const s of this.streams) s.socket.close();
  }

  get srsUrl() { return `sip:${this.advertiseIp}:${this.sipPort}`; }

  /* packets/sec seen on any stream over a window, and the longest silent stretch in it */
  window(from, to) {
    const perStream = this.streams.map((s) => {
      const buckets = s.buckets.filter((b) => b.t >= from && b.t < to);
      const packets = buckets.reduce((sum, b) => sum + b.n, 0);
      return {label: s.label, packets, rate: packets / Math.max(1, (to - from) / 1000)};
    });
    let longestGapMs = 0;
    for (const s of this.streams) {
      let last = from;
      for (const b of s.buckets.filter((b) => b.t >= from && b.t < to && b.n > 0)) {
        longestGapMs = Math.max(longestGapMs, b.t - last);
        last = b.t + BUCKET_MS;
      }
      longestGapMs = Math.max(longestGapMs, to - last);
    }
    return {perStream, longestGapMs, totalPackets: perStream.reduce((sum, s) => sum + s.packets, 0)};
  }

  _record(event, detail) {
    this.events.push({event, at: Date.now(), ...(detail && {detail})});
    this.emit(event, detail);
  }

  _onSip(msg, rinfo) {
    const req = parseMsg(msg);
    if (req.startLine.startsWith('SIP/2.0')) return;    // we are a UAS only

    switch (req.method) {
      case 'INVITE':
        return this._onInvite(req, rinfo);
      case 'ACK':
        return;
      case 'BYE':
        this._record('bye');
        return this._send(this._response(req, 200, 'OK'), rinfo);
      case 'OPTIONS':
        return this._send(this._response(req, 200, 'OK'), rinfo);
      default:
        return this._send(this._response(req, 405, 'Method Not Allowed'), rinfo);
    }
  }

  _onInvite(req, rinfo) {
    const callId = req.headers['call-id'];
    const sdp = extractSdp(req.body);
    if (!sdp) {
      this._record('bad-invite', 'no sdp in body');
      return this._send(this._response(req, 488, 'Not Acceptable Here'), rinfo);
    }

    const isReinvite = this.dialog && this.dialog.callId === callId;
    if (this.dialog && !isReinvite) {
      this._record('extra-invite', `second siprec session, call-id ${callId}`);
      return this._send(this._response(req, 486, 'Busy Here'), rinfo);
    }

    const offers = [...sdp.matchAll(/^m=audio (\d+) [^ ]+ ([^\r\n]+)/gm)];
    if (!this.dialog) {
      this.dialog = {callId, remote: rinfo};
      this._bindStreams(offers.length);
      this._record('invite', `${offers.length} stream(s), metadata ${req.body.length} bytes`);
    }
    else {
      this._record('reinvite', `${offers.length} stream(s)`);
    }

    const body = this._answerSdp(offers);
    this._send(this._response(req, 200, 'OK', {body, contentType: 'application/sdp'}), rinfo);
  }

  _bindStreams(count) {
    for (let i = 0; i < Math.max(count, 1); i++) {
      const socket = dgram.createSocket('udp4');
      const stream = {label: `${i + 1}`, port: this.rtpPortBase + (i * 2), socket, buckets: [], packets: 0};
      socket.on('message', () => {
        stream.packets++;
        const t = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
        const last = stream.buckets[stream.buckets.length - 1];
        if (last && last.t === t) last.n++;
        else stream.buckets.push({t, n: 1});
      });
      socket.bind(stream.port);
      this.streams.push(stream);
    }
  }

  _answerSdp(offers) {
    const lines = [
      'v=0',
      `o=- ${Date.now()} ${this.sdpVersion++} IN IP4 ${this.advertiseIp}`,
      's=jambonz smoke srs',
      `c=IN IP4 ${this.advertiseIp}`,
      't=0 0'
    ];
    offers.forEach((m, idx) => {
      const stream = this.streams[idx];
      const payloads = answerPayloads(m[2]);
      lines.push(`m=audio ${stream ? stream.port : 0} RTP/AVP ${payloads.join(' ')}`);
      if (payloads.includes('0')) lines.push('a=rtpmap:0 PCMU/8000');
      if (payloads.includes('8')) lines.push('a=rtpmap:8 PCMA/8000');
      if (payloads.includes('18')) lines.push('a=rtpmap:18 G729/8000');
      if (payloads.includes('9')) lines.push('a=rtpmap:9 G722/8000');
      if (payloads.includes('101')) lines.push('a=rtpmap:101 telephone-event/8000');
      lines.push('a=recvonly');
      lines.push(`a=label:${idx + 1}`);
    });
    return lines.join(CRLF) + CRLF;
  }

  _response(req, status, reason, {body, contentType} = {}) {
    const out = [`SIP/2.0 ${status} ${reason}`];
    for (const l of req.rawHeaders) {
      const name = l.split(':')[0].trim().toLowerCase();
      if (['via', 'from', 'call-id', 'cseq', 'record-route'].includes(name)) out.push(l);
    }
    let to = req.headers['to'];
    if (!/;tag=/i.test(to)) to += `;tag=${this.toTag}`;
    out.push(`To: ${to}`);
    out.push(`Contact: <sip:${this.advertiseIp}:${this.sipPort}>`);
    out.push('User-Agent: jambonz-smoke-srs');
    if (body) {
      out.push(`Content-Type: ${contentType}`);
      out.push(`Content-Length: ${Buffer.byteLength(body)}`);
    }
    else out.push('Content-Length: 0');
    return out.join(CRLF) + CRLF + CRLF + (body || '');
  }

  _send(msg, rinfo) {
    this.sip.send(Buffer.from(msg), rinfo.port, rinfo.address, (err) => {
      if (err) this.logger(`fake SRS send error: ${err.message}`);
    });
  }
}

module.exports = FakeSrs;
