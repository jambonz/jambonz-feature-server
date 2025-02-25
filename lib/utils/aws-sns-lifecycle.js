const Emitter = require('events');
const bent = require('bent');
const assert = require('assert');
const {
  AWS_REGION,
  AWS_SNS_PORT: PORT,
  AWS_SNS_TOPIC_ARN,
  AWS_SNS_PORT_MAX,
} = require('../config');
const {LifeCycleEvents} = require('./constants');
const express = require('express');
const app = express();
const getString = bent('string');
const {
  SNSClient,
  SubscribeCommand,
  UnsubscribeCommand } = require('@aws-sdk/client-sns');
const snsClient = new SNSClient({ region: AWS_REGION, apiVersion: '2010-03-31' });
const {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  CompleteLifecycleActionCommand } = require('@aws-sdk/client-auto-scaling');
const autoScalingClient = new AutoScalingClient({ region: AWS_REGION, apiVersion: '2011-01-01' });
const {Parser} = require('xml2js');
const parser = new Parser();
const {validatePayload} = require('verify-aws-sns-signature');

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
      AWS_SNS_PORT_MAX &&
      e.port < AWS_SNS_PORT_MAX) {

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
      this.logger.info({headers: req.headers, body: parsedBody}, 'Received HTTP POST from AWS');
      if (!validatePayload(parsedBody)) {
        this.logger.info('incoming AWS SNS HTTP POST failed signature validation');
        return res.sendStatus(403);
      }
      this.logger.info('incoming HTTP POST passed validation');
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

          const group = data.AutoScalingGroups.find((group) =>
            group.Instances && group.Instances.some((instance) => instance.InstanceId === this.instanceId)
          );
          if (!group) {
            this.logger.error('Current instance not found in any Auto Scaling group', data);
          } else {
            const instance = group.Instances.find((instance) => instance.InstanceId === this.instanceId);
            this.lifecycleState = instance.LifecycleState;
          }

          //this.lifecycleState = data.AutoScalingGroups[0].Instances[0].LifecycleState;
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
              this.logger.info(`SnsNotifier - instance ${msg.EC2InstanceId} is scaling in (not us)`);
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
      this.logger.info('SnsNotifier: retrieving instance data');
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
      const params = {
        Protocol: 'http',
        TopicArn: AWS_SNS_TOPIC_ARN,
        Endpoint: this.snsEndpoint
      };
      const response = await snsClient.send(new SubscribeCommand(params));
      this.logger.info({response}, `response to SNS subscribe to ${AWS_SNS_TOPIC_ARN}`);
    } catch (err) {
      this.logger.error({err}, `Error subscribing to SNS topic arn ${AWS_SNS_TOPIC_ARN}`);
    }
  }

  async unsubscribe() {
    if (!this.subscriptionArn) throw new Error('SnsNotifier#unsubscribe called without an active subscription');
    try {
      const params = {
        SubscriptionArn: this.subscriptionArn
      };
      const response = await snsClient.send(new UnsubscribeCommand(params));
      this.logger.info({response}, `response to SNS unsubscribe to ${AWS_SNS_TOPIC_ARN}`);
    } catch (err) {
      this.logger.error({err}, `Error unsubscribing to SNS topic arn ${AWS_SNS_TOPIC_ARN}`);
    }
  }

  completeScaleIn() {
    assert(this.scaleInParams);
    autoScalingClient.send(new CompleteLifecycleActionCommand(this.scaleInParams))
      .then((data) => {
        return this.logger.info({data}, 'Successfully completed scale-in action');
      })
      .catch((err) => {
        this.logger.error({err}, 'Error completing scale-in');
      });
  }

  describeInstance() {
    return new Promise((resolve, reject) => {
      if (!this.instanceId) return reject('instance-id unknown');
      autoScalingClient.send(new DescribeAutoScalingGroupsCommand({
        InstanceIds: [this.instanceId]
      }))
        .then((data) => {
          this.logger.info({data}, 'SnsNotifier: describeInstance');
          return resolve(data);
        })
        .catch((err) => {
          this.logger.error({err}, 'Error describing instances');
          reject(err);
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
      const state = data.AutoScalingGroups[0].Instances[0].LifecycleState;
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
