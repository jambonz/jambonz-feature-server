# Contributors are welcome!

So, you want to hack on jambonz?  Maybe add some features, maybe help fix some bugs?  Awesome, welcome aboard! 

This brief document should get you started.  Here you will find instructions showing how to set up your laptop to run the regression test suite (which you should always run before committing any changes), as well as some basic info on the structure of the code.

## Getting oriented

First of all, you are in the right place to begin hacking on jambonz. The jambonz-feature-server app is kinda the center of the universe for jambonz.  Most of the core logic in jambonz is implemented here: things like the [webhook verbs](../lib/tasks), [session management](../lib/session), and the [client-side webhook implementation](../lib/utils/http-requestor.js). A common thing you might want to do, for instance, is to add support for an all-new verb, and this code base is where would do that.

This jambonz-feature-server app works together quite closely with a [drachtio server](https://github.com/drachtio/drachtio-server) and a Freeswitch.  In fact, these three components are bundled together into a single VM/instance (or a Deployment, in Kubernetes) that we more generally refer to as "Feature Server".  The Feature Server is a horizontally-scalable unit that is deployed behind the public-facing SBC elements of a jambonz cluster (the SBC is itself a separately scalable unit).  The drachtio-server handles the SIP signaling, the Freeswitch handles media operations and speech vendor integration, and the jambonz-feature-server app orchestrates all of it via the use of [drachtio-srf](https://github.com/drachtio/drachtio-srf) and [drachtio-fsmrf](https://github.com/drachtio/drachtio-fsmrf).

## How to do things

First of all, please join our [slack channel](https://joinslack.jambonz.org) in order to coordinate with us on the work, i.e. to notify us of what you are doing and make sure that no one else is already working on the same thing.

To prepare to make changes, please fork the repo to your own Github account, make changes, test them on your own running jambonz cluster, then run the regression test suite and lint check before giving us a PR.

### lint

We have some opinionated conventions that you must follow - see our [eslintrc.json](../.eslintrc.json) for details. Make sure your code passes by running:

```bash
npm run jslint
```

### test suite

#### Generate speech credentials and create run-tests.sh

The test suite also requires you to provide speech credentials for both GCP and AWS.  You will want to create a new file named `run-tests.sh` in the project folder. Make the file executable and then copy in the text below, substituting your speech credentials where indicated:

```bash
#!/bin/bash
GCP_JSON_KEY='{"type":"service_account","project_id":"...etc"}' \
AWS_ACCESS_KEY_ID='your-aws-access-key-id' \
AWS_SECRET_ACCESS_KEY='your-aws-secret-access-key' \
AWS_REGION='us-east-1' \
JWT_SECRET='foobar' \
npm test
```
>> Note: The project's .gitignore file prevents this file from being sent to Github, so you do not need to worry about exposing your credentials.  Just make sure you name if run-tests.sh and create it in the project folder

The GCP credential is the JSON service key in stringified format.

#### Install Docker

The test suite ralso equires [Docker](https://www.docker.com/) and docker-compose to be installed on your laptop.  Docker is used to set up a network with all of the elements required to test the jambonz-feature-server in a black-box type of fashion.

Once you have docker installed, you can optionally make sure everything Docker-wise is working properly by running this command from the project folder:

```bash
docker-compose -f test/docker-compose-testbed.yaml up -d
```

This may take several minutes to complete, mainly because the mysql schema needs to be installed and seeded, but if successful the output should look like this:

```bash
$ docker-compose -f test/docker-compose-testbed.yaml up -d
Creating network "test_fs" with driver "bridge"
Creating test_webhook-transcribe_1 ... done
Creating test_webhook-decline_1    ... done
Creating test_mysql_1              ... done
Creating test_docker-host_1        ... done
Creating test_webhook-gather_1     ... done
Creating test_webhook-say_1        ... done
Creating test_freeswitch_1         ... done
Creating test_influxdb_1           ... done
Creating test_redis_1              ... done
Creating test_drachtio_1           ... done
```

At that point, you can run `docker ps` to see all of the containers running

```bash
docker ps
CONTAINER ID   IMAGE                                           COMMAND                  CREATED              STATUS                   PORTS                               NAMES
abbc3594f390   drachtio/drachtio-server:latest                 "/entrypoint.sh drac…"   About a minute ago   Up About a minute        0.0.0.0:9060->9022/tcp              test_drachtio_1
1f384a274f87   redis:5-alpine                                  "docker-entrypoint.s…"   2 minutes ago        Up 2 minutes             0.0.0.0:16379->6379/tcp             test_redis_1
78d0bb6ec9b1   influxdb:1.8                                    "/entrypoint.sh infl…"   2 minutes ago        Up 2 minutes             0.0.0.0:8086->8086/tcp              test_influxdb_1
9616ff790709   jambonz/webhook-test-scaffold:latest            "/entrypoint.sh"         2 minutes ago        Up 2 minutes             0.0.0.0:3102->3000/tcp              test_webhook-gather_1
7323ab273ff4   drachtio/drachtio-freeswitch-mrf:v1.10.1-full   "/entrypoint.sh free…"   2 minutes ago        Up 2 minutes (healthy)   0.0.0.0:8022->8021/tcp              test_freeswitch_1
e45e7d28dbc7   mysql:5.7                                       "docker-entrypoint.s…"   2 minutes ago        Up 2 minutes (healthy)   33060/tcp, 0.0.0.0:3360->3306/tcp   test_mysql_1
b626e5f3067e   qoomon/docker-host                              "/entrypoint.sh"         2 minutes ago        Up 2 minutes                                                 test_docker-host_1
b0a94b5e8941   jambonz/webhook-test-scaffold:latest            "/entrypoint.sh"         2 minutes ago        Up 2 minutes             0.0.0.0:3101->3000/tcp              test_webhook-say_1
f80adda48eb5   jambonz/webhook-test-scaffold:latest            "/entrypoint.sh"         2 minutes ago        Up 2 minutes             0.0.0.0:3103->3000/tcp              test_webhook-transcribe_1
223db4a9c670   jambonz/webhook-test-scaffold:latest            "/entrypoint.sh"         2 minutes ago        Up 2 minutes             0.0.0.0:3100->3000/tcp              test_webhook-decline_1
```

#### Run the regression test suite

The test suite has a dependency that the mysql client is installed on your laptop/machine where the test will be run.  This is needed in order to seed the mysql database that is running in the docker network.

Assuming you have installed the mysql client, and done the above steps, you should now be able to run the tests:

```bash
./run-tests.sh
```

If the docker network has not been started (as described above) it will start now, and this will take a minute or two.  Otherwise, the test suite will start running immediately.

In evaluating the test results, be advised that the output is fairly verbose, and also in the process of shutting down once the tests are complete you will see a bunch of errors from redis (`@jambonz/realtimedb-helpers - redis error`).  You can ignore these errors, they are just spit out by jambonz-feature-server as the test environment is torn down and it tries and fails to reconnect to redis.

The final output will indicate the number of tests run and passed:

```bash
1..28
# tests 28
# pass  28

# ok
```

#### Adding your own tests

Running a successful regression test means you haven't broken anything - Great!  

It doesn't, of course, mean that your shiny new feature or bugfix works.  Adding a new test case to the suite is (unfortunately) non-trivial.  We will add more documentation in the future with a how-to guide on that, but be advised it does require knowledge of the SIP protocol and the [SIPp](http://sipp.sourceforge.net/doc/reference.html) tool.

For now, if you are unable to add tests to the regression suite, please do test your feature as thoroughly as you can on your own jambonz cluster before giving us a pull request.



