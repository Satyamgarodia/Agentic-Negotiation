# Bridge worker — headless WhatsApp audio bridge

Runs where UDP is allowed (your laptop for dev, Fly.io/GCE for real calls).
No browser involved: WhatsApp RTP <-> worker <-> gateway <-> Gemini Live.

## 1. Validate locally first (no server, no Meta needed)

```bash
cd bridge-worker
npm install
npm run self-test
```

This wires two WebRTC peers in-process and pushes a test tone through the
exact `RTCAudioSink` / `RTCAudioSource` code used for real calls. If the
installed `werift` version has a different media API, the test fails fast
with the real API surface printed — paste that output back and the feed
functions get corrected in one round. **Do not skip this step.**

Expected: `SELF-TEST PASSED: received N frames ...`.

## 2. Run against your gateway (local dev, fastest loop)

```bash
# terminal 1: gateway with auto-restart + instant frontend
npm run dev

# terminal 2: bridge worker pointing at it
cd bridge-worker
SERVER_URL=http://localhost:3000 WORKER_ID=dev-1 node worker.js
```

Watch the gateway's **Live Server Logs** tab: on the next incoming call you
should see `waiting_bridge -> bridge_answered -> meta_accepted` (answered
by `bridge-worker` instead of `server`), then `media_flowing_in/out` once
audio moves. The dashboard shows only the passive "AI is on a call" banner —
the phone mockup stays idle.

Real Meta RTP will NOT reach a laptop behind NAT (there is no public UDP
path), so a real phone call still carries no audio in this setup — but the
full signaling + bridge handshake is exercised end to end.

## 3. Real calls (public UDP required)

The worker's host needs a **public IP + open UDP port** (Cloud Run cannot do
this — that is the entire reason this worker exists).

```bash
SERVER_URL=https://gemini-call-link-387274718809.asia-south1.run.app \
WORKER_ID=prod-1 \
PUBLIC_IP=<this host's public IP> \
node worker.js
```

Cheapestfit: Fly.io (`fly launch`, one shared-cpu machine, expose UDP) or a
micro GCE VM. Point `PUBLIC_IP` at that host.

## Protocol (gateway <-> worker, all TCP)

- `POST /api/bridge/heartbeat { workerId, publicIp }` — every 10s, tells the
  gateway a bridge is alive (stale after 45s).
- `GET /api/bridge/pending` — calls with SDP offers whose pipeline started
  (`pickup_started` in history) and no terminal stage reached yet (excludes
  `bridge_answered/timeout`, `meta_*`, `pickup_complete/partial`), with LiveKit
  room + token and media WS URL.
- `POST /api/bridge/answer { callId, sdpAnswer, workerId }` — worker's SDP
  answer; the gateway sends it to Meta as the call accept (9s timeout, then
  falls back to its own SDP).
- `WS /ws/call-media/:callId` — bidirectional PCM: worker sends
  `{ type:'caller_audio', audio:<pcm16k base64> }`, receives
  `{ type:'gemini_audio', audio:<pcm24k base64> }`.

## Troubleshooting

- `npm run self-test` fails -> paste the whole output (it prints the real
  `RTCAudioSource` API surface on feed failure).
- Logs show `bridge_timeout` -> worker not polling (check `SERVER_URL`,
  firewall egress) or `handleCall` crashed (see worker console).
- Logs show `meta_failed` after `bridge_answered` -> Meta rejected the SDP
  (its message is in the log line) — usually ICE/host candidates unreachable
  from Meta, i.e. `PUBLIC_IP`/firewall.
- Caller hears silence but `media_flowing_in` present and no
  `media_flowing_out` -> Gemini session issue, check `[gemini]` lines.
