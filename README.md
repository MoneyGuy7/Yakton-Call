# Yakton Call

A browser-based room-code video calling app with live chat, device controls, and a Cloudflare Worker + Durable Objects signaling backend.

## Project files

- `index.html` — lobby, call layout, chat, and controls
- `style.css` — responsive dark UI
- `app.js` — browser UI, WebRTC mesh calls, media/device controls, and WebSocket client
- `worker.js` — Worker endpoint and Durable Object room signaling/chat
- `wrangler.toml` — Cloudflare deployment configuration

## How it works

The browser uses WebRTC to exchange audio/video directly between participants. The Worker and Durable Object coordinate room presence, WebRTC offers/answers/ICE candidates, and chat messages. The Worker does **not** relay audio/video itself.

The app currently uses a peer-to-peer mesh. Each participant makes a separate WebRTC connection to each other participant, so it is best for small groups (the signaling backend caps a room at 12; performance depends on devices and uplink). For larger calls, use an SFU service such as Cloudflare Calls or another WebRTC SFU.

## 1. Deploy the signaling Worker

1. Install Node.js and Wrangler: `npm install -g wrangler`
2. Sign in: `wrangler login`
3. In this directory, deploy: `wrangler deploy`
4. Confirm `https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev/health` returns JSON with `"ok": true`.

The `wrangler.toml` declares a SQLite-backed Durable Object migration. If you already have a Worker with the same name/bindings, review the configuration before deploying.

## 2. Connect `call.yakton.net`

In Cloudflare Dashboard:

1. Open **Workers & Pages** and select the deployed `yakton-call` Worker.
2. Open **Settings → Domains & Routes** and add the custom domain `call.yakton.net`.
3. Make sure the domain is active in the same Cloudflare account and DNS is managed there.

The frontend's default signaling endpoint is `wss://call.yakton.net/ws` in `app.js`. If you host the frontend elsewhere, change `state.config.signalingUrl` to the Worker WebSocket URL you actually use.

## 3. Host the frontend on GitHub

You can publish the static frontend through GitHub Pages or any static host. Upload `index.html`, `style.css`, and `app.js` to the repository root. If using GitHub Pages on a custom domain, follow GitHub's Pages custom-domain instructions and configure DNS carefully. If `call.yakton.net` points to the Worker, choose a separate frontend hostname (for example `meet.yakton.net`) or route static assets and `/ws` through a compatible single-host setup. A single hostname cannot simply point at two independent services without routing configuration.

**Recommended simple split:**
- Frontend: GitHub Pages at `meet.yakton.net`
- Signaling Worker: `call.yakton.net`
- `app.js`: keep `wss://call.yakton.net/ws`

If you want the frontend itself at `call.yakton.net`, configure Cloudflare routing so static requests are served by the frontend and `/ws` is handled by the Worker. Do not configure two competing DNS origins for the same hostname.

## 4. Local development

For the frontend, serve the folder using a local static server (for example, VS Code Live Server). Camera/microphone access usually requires HTTPS, with `localhost` treated as a secure context by browsers.

For the Worker, run `wrangler dev`. A local HTTPS/static frontend and the local Worker URL need to be aligned in `app.js` if you test signaling locally.

## Media permissions and connectivity

- Users must allow camera/microphone access. Browsers generally require HTTPS outside localhost.
- Microphone/camera selectors appear after permissions are granted, because browsers often hide device labels until then.
- Audio output selection (`setSinkId`) is supported only in some browsers.
- The app includes STUN servers to help peers discover network paths. **STUN alone is not enough for every network.** For dependable calls across restrictive NATs, school/work networks, VPNs, or mobile carriers, configure a TURN service and add its ICE server URL and short-lived credentials in `app.js` or load them securely from a Worker endpoint. Never put a long-lived TURN secret in public frontend code.
- Calls are peer-to-peer. Other participants' browsers receive media directly from your browser. Chat and signaling go through Cloudflare.

## Security and limitations

- Room codes are unguessable only if users choose a sufficiently random code; they are not passwords. Do not use this for confidential meetings without adding authentication, rate limits, and stronger room authorization.
- The Worker validates room codes and client IDs, bounds names/messages, and restricts signaling delivery to clients in the same Durable Object room.
- This starter does not implement durable chat history, account identities, moderation, abuse reporting, or sophisticated rate limiting. Room chat exists only while participants are connected.
- The WebRTC mesh and small room limit are intended for small group calls, not webinars.
- Add production monitoring and abuse protections before opening the service publicly.

## Quick test

1. Deploy the Worker and set the signaling URL.
2. Open the frontend in two browser tabs/devices using HTTPS.
3. Enter the same room code with different names.
4. Allow microphone/camera access. Test mute, camera, device selectors, chat, and leave/rejoin.
