const Emitter = require('events');
const {CallStatus} = require('./constants');

class SingleDialer extends Emitter {
  constructor(logger, opts) {
    super();
    this.logger = logger;
    this.cs = opts.cs;
    this.ms = opts.ms;
  }

  get callState() {
    return this._callState;
  }

  /**
   * launch the outdial
   */
  exec() {

  }

  /**
   * kill the call in progress, or stable dialog, whichever
   */
  async kill() {

  }

  /**
   * execute a jambones application on this call / endpoint
   * @param {*} jambones document
   */
  async runApp(document) {

  }

  async _createEndpoint() {

  }

  async _outdial() {

  }

}

function placeOutdial(logger, opts) {
  const singleDialer = new SingleDialer(logger, opts);
  singleDialer.exec();
  return singleDialer;
}

module.exports = placeOutdial;

