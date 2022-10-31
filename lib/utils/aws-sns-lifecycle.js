const Emitter = require('events');
const bent = require('bent');
const assert = require('assert');
const PORT = process.env.AWS_SNS_PORT || 3010;
const {LifeCycleEvents} = require('./constants');
const express = require('express');
const app = express();
const getString = bent('string');
const AWS = require('aws-sdk');
const sns = new AWS.SNS({apiVersion: '2010-03-31'});
const autoscaling = new AWS.AutoScaling({apiVersion: '2011-01-01'});
const {Parser} = require('xml2js');
const parser = new Parser();
const {validatePayload} = require('verify-aws-sns-signature');

AWS.config.update({region: process.env.AWS_REGION});

class SnsNotifier extends Emitter {
  constructor(logger) {
    super();

    this.logger = logger;
  }
  _doListen(logger, app, port, resolve) {
    return app.listen(port, () => {
      this.snsEndpoint = `http://${this.publicIp}:${port}`;
      logger.info(`SNS lifecycle server listening on http://localhost:${port}`);
      resolve(app);
    });
  }

  _handleErrors(logger, app, resolve, reject, e) {
    if (e.code === 'EADDRINUSE' &&
      process.env.AWS_SNS_PORT_MAX &&
      e.port < process.env.AWS_SNS_PORT_MAX) {

      logger.info(`SNS lifecycle server failed to bind port on ${e.port}, will try next port`);
      const server = this._doListen(logger, app, ++e.port, resolve);
      server.on('error', this._handleErrors.bind(this, logger, app, resolve, reject));
      return;
    }
    reject(e);
  }

  async _handlePost(req, res) {
    try {
      const parsedBody = JSON.parse(req.body);
      this.logger.debug({headers: req.headers, body: parsedBody}, 'Received HTTP POST from AWS');
      if (!validatePayload(parsedBody)) {
        this.logger.info('incoming AWS SNS HTTP POST failed signature validation');
        return res.sendStatus(403);
      }
      this.logger.debug('incoming HTTP POST passed validation');
      res.sendStatus(200);

      switch (parsedBody.Type) {
        case 'SubscriptionConfirmation':
          const response = await getString(parsedBody.SubscribeURL);
          const result = await parser.parseStringPromise(response);
          this.subscriptionArn = result.ConfirmSubscriptionResponse.ConfirmSubscriptionResult[0].SubscriptionArn[0];
          this.subscriptionRequestId = result.ConfirmSubscriptionResponse.ResponseMetadata[0].RequestId[0];
          this.logger.info({
            subscriptionArn: this.subscriptionArn,
            subscriptionRequestId: this.subscriptionRequestId
          }, 'response from SNS SubscribeURL');
          const data = await this.describeInstance();
          this.lifecycleState = data.AutoScalingInstances[0].LifecycleState;
          this.emit('SubscriptionConfirmation', {publicIp: this.publicIp});
          break;

        case 'Notification':
          if (parsedBody.Subject.startsWith('Auto Scaling:  Lifecycle action \'TERMINATING\'')) {
            const msg = JSON.parse(parsedBody.Message);
            if (msg.EC2InstanceId === this.instanceId) {
              this.logger.info('SnsNotifier - begin scale-in operation');
              this.scaleInParams = {
                AutoScalingGroupName: msg.AutoScalingGroupName,
                LifecycleActionResult: 'CONTINUE',
                LifecycleActionToken: msg.LifecycleActionToken,
                LifecycleHookName: msg.LifecycleHookName
              };
              this.operationalState = LifeCycleEvents.ScaleIn;
              this.emit(LifeCycleEvents.ScaleIn);
              this.unsubscribe();
            }
            else {
              this.logger.debug(`SnsNotifier - instance ${msg.EC2InstanceId} is scaling in (not us)`);
            }
          }
          break;

        default:
          this.logger.info(`unhandled SNS Post Type: ${parsedBody.Type}`);
      }

    } catch (err) {
      this.logger.error({err}, 'Error processing SNS POST request');
      if (!res.headersSent) res.sendStatus(500);
    }
  }

  async init() {
    try {
      this.logger.debug('SnsNotifier: retrieving instance data');
      this.instanceId = await getString('http://169.254.169.254/latest/meta-data/instance-id');
      this.publicIp = await getString('http://169.254.169.254/latest/meta-data/public-ipv4');
      this.logger.info({
        instanceId: this.instanceId,
        publicIp: this.publicIp
      }, 'retrieved AWS instance data');

      // start listening
      app.use(express.urlencoded({ extended: true }));
      app.use(express.json());
      app.use(express.text());
      app.post('/', this._handlePost.bind(this));
      app.use((err, req, res, next) => {
        this.logger.error(err, 'burped error');
        res.status(err.status || 500).json({msg: err.message});
      });
      return new Promise((resolve, reject) => {
        const server = this._doListen(this.logger, app, PORT, resolve);
        server.on('error', this._handleErrors.bind(this, this.logger, app, resolve, reject));
      });

    } catch (err) {
      this.logger.error({err}, 'Error retrieving AWS instance metadata');
    }
  }

  async subscribe() {
    try {
      const response = await sns.subscribe({
        Protocol: 'http',
        TopicArn: process.env.AWS_SNS_TOPIC_ARM,
        Endpoint: this.snsEndpoint
      }).promise();
      this.logger.info({response}, `response to SNS subscribe to ${process.env.AWS_SNS_TOPIC_ARM}`);
    } catch (err) {
      this.logger.error({err}, `Error subscribing to SNS topic arn ${process.env.AWS_SNS_TOPIC_ARM}`);
    }
  }

  async unsubscribe() {
    if (!this.subscriptionArn) throw new Error('SnsNotifier#unsubscribe called without an active subscription');
    try {
      const response = await sns.unsubscribe({
        SubscriptionArn: this.subscriptionArn
      }).promise();
      this.logger.info({response}, `response to SNS unsubscribe to ${process.env.AWS_SNS_TOPIC_ARM}`);
    } catch (err) {
      this.logger.error({err}, `Error unsubscribing to SNS topic arn ${process.env.AWS_SNS_TOPIC_ARM}`);
    }
  }

  completeScaleIn() {
    assert(this.scaleInParams);
    autoscaling.completeLifecycleAction(this.scaleInParams, (err, response) => {
      if (err) return this.logger.error({err}, 'Error completing scale-in');
      this.logger.info({response}, 'Successfully completed scale-in action');
    });
  }

  describeInstance() {
    return new Promise((resolve, reject) => {
      if (!this.instanceId) return reject('instance-id unknown');
      autoscaling.describeAutoScalingInstances({
        InstanceIds: [this.instanceId]
      }, (err, data) => {
        if (err) {
          this.logger.error({err}, 'Error describing instances');
          reject(err);
        } else {
          this.logger.info({data}, 'SnsNotifier: describeInstance');
          resolve(data);
        }
      });
    });
  }

}

module.exports = async function(logger) {
  const notifier = new SnsNotifier(logger);
  await notifier.init();
  await notifier.subscribe();

  process.on('SIGHUP', async() => {
    try {
      const data = await notifier.describeInstance();
      const state = data.AutoScalingInstances[0].LifecycleState;
      if (state !== notifier.lifecycleState) {
        notifier.lifecycleState = state;
        switch (state) {
          case 'Standby':
            notifier.emit(LifeCycleEvents.StandbyEnter);
            break;
          case 'InService':
            notifier.emit(LifeCycleEvents.StandbyExit);
            break;
        }
      }
    } catch (err) {
      console.error(err);
    }
  });
  return notifier;
};
