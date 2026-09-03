# smoke test: SIPREC recording across a cross-feature-server dequeue

Reproduces, and then validates the fix for, a SIPREC recording breaking when a queued
call is moved to another feature server by `enqueue`/`dequeue`.

This is **not** part of `npm test`. It needs a medium deployment (two or more feature
servers, an SBC, rtpengine, a carrier or SIP endpoint for the agent leg) and a real
inbound call, so it is kept out of the mocha suite and run by hand.

## Two modes

`SMOKE_MODE=rest` (default) needs **nothing configured in the portal**: the script
creates both call legs itself with the feature server's `createCall` API and answers
them with its own built-in SIP endpoint, which streams a continuous PCMU tone. The
recorded leg is then a REST call, so this exercises the transfer path in
**sbc-outbound**.

`SMOKE_MODE=inbound` waits for a real inbound call to an application whose call hook
points at the script, exercising the transfer path in **sbc-inbound**. That needs a
carrier/DID (or a registered device) and a caller that transmits audio continuously.

## What it checks

The script is the jambonz application, and also plays the recorder:

1. answers the recorded call, starts SIPREC recording, and puts the call in a queue
2. creates the agent call **directly on a different feature server** (that is the
   forcing function - it is what makes jambonz move the queued call with a REFER)
3. returns `dequeue` with the inbound `callSid` when the agent answers
4. watches its own fake SRS: did the SIPREC INVITE arrive, did RTP keep flowing across
   the move, and was the session BYEd when the call ended

It then prints PASS/FAIL with the packet rates it judged on.

## Requirements

- two or more feature servers, reachable from this host on port 3000
- this host reachable **from** the feature servers (HTTP hooks) and **from rtpengine**
  (SIP + RTP for the fake SRS)
- `SMOKE_ACCOUNT_SID`, and nothing else, in the default `rest` mode - the script places
  both legs itself and answers them with its own endpoint

In `inbound` mode only, additionally:

- an application in the jambonz portal whose call hook points at this script
- a caller that transmits audio continuously - sipp with a pcap, or a softphone playing
  music. A muted caller sends no RTP, and the media check then proves nothing (the
  script says so rather than passing).

## Configuration

| variable | required | default | meaning |
|---|---|---|---|
| `SMOKE_FEATURE_SERVERS` | yes | - | `10.0.0.11:3000,10.0.0.12:3000` - at least two |
| `SMOKE_ACCOUNT_SID` | yes | - | account the agent call is created for |
| `SMOKE_HTTP_ADVERTISE` | yes | - | `host:port` the feature servers reach this script on |
| `SMOKE_SRS_ADVERTISE_IP` | yes | - | IP rtpengine and the SBC reach the fake SRS on |
| `SMOKE_AGENT_SIP_URI` | inbound mode | - | agent target, e.g. `sip:agent@10.0.0.50` |
| `SMOKE_AGENT_TO_JSON` | inbound mode | - | full `to` object instead, e.g. `{"type":"phone","number":"+15551234567","trunk":"my-carrier"}` |
| `SMOKE_MODE` | no | rest | `rest` or `inbound` |
| `SMOKE_EP_SIP_PORT` | no | 5094 | built-in SIP endpoint port (rest mode) |
| `SMOKE_EP_RTP_PORT_BASE` | no | 40200 | first RTP port for the endpoint |
| `SMOKE_HTTP_PORT` | no | 3111 | local listen port for the hooks |
| `SMOKE_SRS_PORT` | no | 5093 | fake SRS SIP port (UDP) |
| `SMOKE_SRS_RTP_PORT_BASE` | no | 40100 | first RTP port; one even port per stream |
| `SMOKE_AGENT_FROM` | no | 15551234567 | calling number for the agent leg |
| `SMOKE_QUEUE` | no | smoke-siprec | queue name |
| `SMOKE_SETTLE_SECS` | no | 15 | how long to watch the recording after the bridge |
| `SMOKE_HANGUP_BY` | no | jambonz | `jambonz` or `caller` - see below |
| `SMOKE_WAIT_SECS` | no | 300 | how long to wait for the inbound call |

In `rest` mode the agent target is the built-in endpoint, so neither agent variable is
needed - `SMOKE_ACCOUNT_SID` and the addresses are the whole configuration.

## Running it

```bash
cd smoke-tests/siprec-fs-transfer

SMOKE_FEATURE_SERVERS=10.0.0.11:3000,10.0.0.12:3000 \
SMOKE_ACCOUNT_SID=6a2d1d1b-... \
SMOKE_HTTP_ADVERTISE=10.0.0.99:3111 \
SMOKE_SRS_ADVERTISE_IP=10.0.0.99 \
node index.js
```

In `rest` mode that is the whole run: it places both calls itself and exits 0 on PASS,
1 on FAIL, 2 if it could not run the scenario at all. In `inbound` mode it prints the
hook URLs and waits for you to place the call.

Run it from a host the feature servers can reach on `SMOKE_HTTP_PORT`, and that
rtpengine can reach on the SRS and endpoint ports - the SBC host itself is the easy
choice, since then all the media stays on that box.

`SMOKE_HANGUP_BY=jambonz` (the default) ends the call from the feature server side,
which is the case that leaves an orphaned SIPREC session when the fix is missing. Use
`SMOKE_HANGUP_BY=caller` to check the other direction: hang the caller up yourself.

## Reading the result

| output | meaning |
|---|---|
| `no SIPREC INVITE reached the recorder` | the SBC never started the session - check `X-Srs-Url` reachability and the SBC log for `startCallRecording` |
| `recording went silent at the transfer` | the media fork was not rebuilt after the move - `SrsClient.resubscribe()` missing or ineffective |
| `Nms of silence after the transfer` | fork rebuilt late or only partly |
| `no BYE for the SIPREC session` | the transferred leg's teardown does not stop the recording; the recorder is left to time out |
| `the SBC opened a second SIPREC session` | the call is being recorded twice - state was not carried across the transfer |
| `no media before the transfer either` | the caller is not sending audio; fix that and re-run, the run is inconclusive |

Run it against the deployment **before** rolling out the fix to see the bug (expect
`went silent` and `no BYE`), then again after, on the same call flow.

## Ports to open

- UDP `SMOKE_SRS_PORT` from the SBC
- UDP `SMOKE_SRS_RTP_PORT_BASE` .. `+3` from rtpengine (two streams)
- UDP `SMOKE_EP_SIP_PORT` and `SMOKE_EP_RTP_PORT_BASE` .. `+3` from the SBC (rest mode)
- TCP `SMOKE_HTTP_PORT` from the feature servers

None of that leaves the box if you run the script on the SBC host.
