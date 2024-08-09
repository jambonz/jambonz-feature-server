const Task = require('./task');
const {TaskName} = require('../utils/constants');
const makeTask = require('./make_task');
const { normalizeJambones } = require('@jambonz/verb-specifications');
const DtmfCollector = require('../utils/dtmf-collector');

/**
 * Manages an outdial made via REST API
 */

function parseDtmfOptions(logger, dtmfCapture) {
  let parentDtmfCollector, childDtmfCollector;
  const parentKeys = [], childKeys = [];

  if (Array.isArray(dtmfCapture)) {
    Array.prototype.push.apply(parentKeys, dtmfCapture);
    Array.prototype.push.apply(childKeys, dtmfCapture);
  }
  else if (dtmfCapture.childCall || dtmfCapture.parentCall) {
    if (dtmfCapture.childCall && Array.isArray(dtmfCapture.childCall)) {
      Array.prototype.push.apply(childKeys, dtmfCapture.childCall);
    }
    if (dtmfCapture.parentCall && Array.isArray(dtmfCapture.parentCall)) {
      Array.prototype.push.apply(childKeys, dtmfCapture.parentCall);
    }
  }
  if (childKeys.length) {
    childDtmfCollector = new DtmfCollector({logger, patterns: childKeys});
  }
  if (parentKeys.length) {
    parentDtmfCollector = new DtmfCollector({logger, patterns: parentKeys});
  }

  return {childDtmfCollector, parentDtmfCollector};
}

class TaskRestDial extends Task {
  constructor(logger, opts) {
    super(logger, opts);

    this.from = this.data.from;
    this.callerName = this.data.callerName;
    this.fromHost = this.data.fromHost;
    this.to = this.data.to;
    this.call_hook = this.data.call_hook;
    this.dtmfHook = this.data.dtmfHook;
    this.timeout = this.data.timeout || 60;
    this.sipRequestWithinDialogHook = this.data.sipRequestWithinDialogHook;
    this.referHook = this.data.referHook;

    if (this.dtmfHook) {
      const {parentDtmfCollector, childDtmfCollector} = parseDtmfOptions(logger, this.data.dtmfCapture || {});
      if (parentDtmfCollector) {
        this.parentDtmfCollector = parentDtmfCollector;
      }
      if (childDtmfCollector) {
        this.childDtmfCollector = childDtmfCollector;
      }
    }

    this.on('connect', this._onConnect.bind(this));
    this.on('callStatus', this._onCallStatus.bind(this));
  }

  get name() { return TaskName.RestDial; }

  set appJson(app_json) {
    this.app_json = app_json;
  }

  /**
   * INVITE has just been sent at this point
   */
  async exec(cs) {
    await super.exec(cs);
    this.cs = cs;
    this.canCancel = true;

    if (this.data.amd) {
      this.startAmd = cs.startAmd;
      this.stopAmd = cs.stopAmd;
      this.on('amd', this._onAmdEvent.bind(this, cs));
    }

    this._setCallTimer();
    await this.awaitTaskDone();
  }

  turnOffAmd() {
    if (this.callSession.ep && this.callSession.ep.amd) this.stopAmd(this.callSession.ep, this);
  }

  kill(cs) {
    super.kill(cs);
    this._clearCallTimer();
    if (this.canCancel) {
      this.canCancel = false;
      cs?.req?.cancel();
    }

    // Remove DTMF detection
    this._removeDtmfDetection(cs.dlg);

    this.notifyTaskDone();
  }

  async _onConnect(dlg) {
    this.canCancel = false;
    const cs = this.callSession;
    cs.setDialog(dlg);
    cs.referHook = this.referHook;
    this.logger.debug('TaskRestDial:_onConnect - call connected');

    // Attach DTMF detection
    if (this.parentDtmfCollector || this.childDtmfCollector) {
      this._installDtmfDetection(cs, dlg);
    }

    if (this.sipRequestWithinDialogHook) this._initSipRequestWithinDialogHandler(cs, dlg);
    try {
      const b3 = this.getTracingPropagation();
      const httpHeaders = b3 && {b3};
      const params = {
        ...(cs.callInfo.toJSON()),
        defaults: {
          synthesizer: {
            vendor: cs.speechSynthesisVendor,
            language: cs.speechSynthesisLanguage,
            voice: cs.speechSynthesisVoice
          },
          recognizer: {
            vendor:  cs.speechRecognizerVendor,
            language: cs.speechRecognizerLanguage
          }
        }
      };
      if (this.startAmd) {
        try {
          this.startAmd(this.callSession, this.callSession.ep, this, this.data.amd);
        } catch (err) {
          this.logger.info({err}, 'Rest:dial:Call established - Error calling startAmd');
        }
      }
      let tasks;
      if (this.app_json) {
        this.logger.debug('TaskRestDial: using app_json from task data');
        tasks = JSON.parse(this.app_json);
      } else {
        this.logger.debug({call_hook: this.call_hook}, 'TaskRestDial: retrieving application');
        tasks = await cs.requestor.request('session:new', this.call_hook, params, httpHeaders);
      }
      if (tasks && Array.isArray(tasks)) {
        this.logger.debug({tasks: tasks}, `TaskRestDial: replacing application with ${tasks.length} tasks`);
        cs.replaceApplication(normalizeJambones(this.logger, tasks).map((tdata) => makeTask(this.logger, tdata)));
      }
    } catch (err) {
      this.logger.error(err, 'TaskRestDial:_onConnect error retrieving or parsing application, ending call');
      this.notifyTaskDone();
    }
  }

  _onCallStatus(status) {
    this.logger.debug(`CallStatus: ${status}`);
    if (status >= 200) {
      this.canCancel = false;
      this._clearCallTimer();
      if (status !== 200) this.notifyTaskDone();
    }
  }

  _setCallTimer() {
    this.timer = setTimeout(this._onCallTimeout.bind(this), this.timeout * 1000);
  }

  _clearCallTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _onCallTimeout() {
    this.logger.debug('TaskRestDial: timeout expired without answer, killing task');
    this.timer = null;
    if (this.canCancel) {
      this.canCancel = false;
      this.cs?.req?.cancel();
    }
  }

  _onAmdEvent(cs, evt) {
    this.logger.info({evt}, 'Rest:dial:_onAmdEvent');
    const {actionHook} = this.data.amd;
    this.performHook(cs, actionHook, evt)
        .catch((err) => {
          this.logger.error({err}, 'Rest:dial:_onAmdEvent - error calling actionHook');
        });
  }

  _installDtmfDetection(cs, dlg) {
    dlg.on('info', this._onInfo.bind(this, cs, dlg));
  }

  _onInfo(cs, dlg, req, res) {
    res.send(200);
    if (req.get('Content-Type') !== 'application/dtmf-relay') {
      return;
    }

    const dtmfDetector = dlg === cs.dlg ? this.parentDtmfCollector : this.childDtmfCollector;
    if (!dtmfDetector) return;

    const arr = /Signal=([0-9#*])/.exec(req.body);
    if (!arr) return;

    const key = arr[1];
    const match = dtmfDetector.keyPress(key);

    if (match) {
      const b3 = this.getTracingPropagation();
      const httpHeaders = b3 && {b3};
      this.logger.info({callSid: cs.callSid}, `RestDial:_onInfo triggered dtmf match: ${match}`);

      cs.requestor.request('verb:hook', this.dtmfHook, {dtmf: match, ...cs.callInfo.toJSON()}, httpHeaders)
          .catch((err) => this.logger.info(err, 'RestDial:_onDtmf - error'));
    }
  }

  _removeDtmfDetection(dlg) {
    dlg && dlg.removeAllListeners('info');
  }

  _initSipRequestWithinDialogHandler(cs, dlg) {
    cs.sipRequestWithinDialogHook = this.sipRequestWithinDialogHook;
    dlg.on('info', this._onRequestWithinDialog.bind(this, cs));
    dlg.on('message', this._onRequestWithinDialog.bind(this, cs));
  }

  async _onRequestWithinDialog(cs, req, res) {
    cs._onRequestWithinDialog(req, res);
  }
}

module.exports = TaskRestDial;
