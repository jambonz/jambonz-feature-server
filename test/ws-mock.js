class MockWebsocket {
    static eventResponses = new Map();
    static actionLoops = new Map();
    eventListeners = new Map();

    constructor(url, protocols, options) {
        this.u = url;
        this.pros = protocols;
        this.opts = options;
        setTimeout(() => {
            this.open();
        }, 500)
    }

    static addJsonMapping(key, value) {
        MockWebsocket.eventResponses.set(key, value);
    }

    static getAndIncreaseActionLoops(key) {
        const ret = MockWebsocket.actionLoops.has(key) ? MockWebsocket.actionLoops.get(key) : 0;
        MockWebsocket.actionLoops.set(key, ret + 1);
        return ret;
    }

    once(event, listener) {
        // Websocket.ws = this;
        this.eventListeners.set(event, listener);
        return this;
    }

    on(event, listener) {
        // Websocket.ws = this;
        this.eventListeners.set(event, listener);
        return this;
    }

    open() {
        if (this.eventListeners.has('open')) {
            this.eventListeners.get('open')();
        }
    }

    removeAllListeners() {
        this.eventListeners.clear();
    }

    send(data, callback) {
        const json = JSON.parse(data);
        console.log({json}, 'got message from ws-requestor');
        if (MockWebsocket.eventResponses.has(json.call_sid)) {

            const resp_data = MockWebsocket.eventResponses.get(json.call_sid);
            const action = resp_data.action[MockWebsocket.getAndIncreaseActionLoops(json.call_sid)];
            if (action === 'connect') {
                setTimeout(()=> {
                    const msg = {
                        type: 'ack',
                        msgid: json.msgid,
                        command: 'command',
                        call_sid: json.call_sid,
                        queueCommand: false, 
                        data: resp_data.body}
                    console.log({msg}, 'sending ack to ws-requestor');
                    this.mockOnMessage(JSON.stringify(msg));
                }, 100);
            } else if (action === 'close') {
                if (this.eventListeners.has('close')) {
                    this.eventListeners.get('close')(500);
                }
            } else if (action === 'terminate') {
                if (this.eventListeners.has('close')) {
                    this.eventListeners.get('close')(1000);
                }
            } else if (action === 'error') {
                if (this.eventListeners.has('error')) {
                    this.eventListeners.get('error')();
                }
            } else if (action === 'unexpected-response') {
                if (this.eventListeners.has('unexpected-response')) {
                    this.eventListeners.get('unexpected-response')();
                }
            }
            
        }
        if (callback) {
            callback();
        }
    }

    mockOnMessage(message, isBinary=false) {
        if (this.eventListeners.has('message')) {
            this.eventListeners.get('message')(message, isBinary);
        }
    }
}

module.exports = MockWebsocket;