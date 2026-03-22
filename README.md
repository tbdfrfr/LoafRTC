# LoafRTC

LoafRTC is a browser-based game streaming platform made of three components in one monorepo:

- `loafhost/`: Windows Electron host app with native Rust pipeline and Go input bridge.
- `frontend/`: Browser viewer (vanilla HTML/CSS/JS, no build step).
- `server/`: Node.js signaling server that also serves the frontend and TURN config to peers.

## Architecture Summary

1. Host app starts on Windows and registers with the signaling server.
2. Server returns a 6-character room code.
3. Browser enters code on the web frontend.
4. Host and browser complete WebRTC signaling over WebSocket.
5. Host opens two data channels:
	- `video` channel: unreliable + unordered (`ordered:false`, `maxRetransmits:0`)
	- `control` channel: reliable + ordered
6. Host sends packetized encoded video frames over the `video` data channel.
7. Browser reassembles packets, decodes with WebCodecs, and renders to canvas via WebGPU/WebGL.

Current host policy allows one active viewer per room code.

No WebRTC media tracks are used for video transport.

## Repository Layout

```text
/
├── loafhost/
│   ├── src/
│   │   ├── main.js
│   │   ├── preload.js
│   │   └── renderer/
│   │       ├── index.html
│   │       ├── app.js
│   │       └── styles.css
│   ├── native/
│   │   ├── Cargo.toml
│   │   ├── build.rs
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── capture.rs
│   │       ├── encode.rs
│   │       └── pipeline.rs
│   ├── resources/
│   ├── input-bridge/
│   │   ├── go.mod
│   │   └── main.go
│   ├── scripts/
│   │   └── build-native.sh
│   ├── package.json
│   └── electron-builder.yml
├── frontend/
│   ├── index.html
│   ├── app.js
│   ├── renderer.js
│   └── styles.css
├── server/
│   ├── server.js
│   ├── turn.js
│   └── package.json
├── .github/workflows/
│   └── build-windows.yml
├── docs/
│   └── deploy.md
├── turnserver.conf
├── nginx.conf
├── ecosystem.config.js
└── package.json
```

## Local Development

### Server

```bash
cd server
npm install
npm start
```

Server defaults to `http://localhost:3000`.

Required env in `server/.env`:

```env
TURN_USERNAME=loafuser
TURN_PASSWORD=your_strong_password
TURN_DOMAIN=your-domain-or-ip
PORT=3000
```

### Frontend

The frontend is served by the server from `/frontend`, no separate build required.

### Host (Windows)

```bash
cd loafhost
npm install
npm run build:native
npm run build:bridge
npm start
```

## Deployment

Deployment is manual by design. Follow:

- `docs/deploy.md`

### Recommended Production Topology

Use this split deployment for easiest operations:

1. Frontend viewer on GitHub Pages (static hosting).
2. Signaling backend + TURN on a DigitalOcean Ubuntu droplet.
3. LoafHost on a Windows gaming PC.

### Complete Setup Workflow

1. Set up backend domain and DNS.

- Buy/use a domain and create:
	- `signal.your-domain.com` -> DigitalOcean droplet public IP.
	- `viewer.your-domain.com` -> GitHub Pages CNAME target (or use `https://<user>.github.io/<repo>/`).

2. Deploy backend on DigitalOcean.

- Follow the full server guide in [docs/deploy.md](docs/deploy.md).
- Backend must expose secure WebSocket endpoint:
	- `wss://signal.your-domain.com/ws`
- Validate backend health:
	- `curl -i https://signal.your-domain.com/health`

3. Configure frontend for cross-origin signaling.

- Edit [frontend/index.html](frontend/index.html#L7) and set:

```html
<script>
	window.LOAFRTC_SIGNALING_URL = 'wss://signal.your-domain.com/ws';
</script>
```

4. Publish frontend to GitHub Pages.

- Push repo to GitHub.
- In GitHub repo settings:
	- Open `Settings -> Pages`.
	- Set source to `Deploy from a branch`.
	- Select branch/folder that contains the built frontend files you want to publish.
- Ensure published files include the contents of [frontend/](frontend/) and preserve paths to:
	- [frontend/index.html](frontend/index.html)
	- [frontend/app.js](frontend/app.js)
	- [frontend/renderer.js](frontend/renderer.js)
	- [frontend/styles.css](frontend/styles.css)
- If using a custom domain, set `viewer.your-domain.com` in Pages settings and configure DNS.

5. Configure and run LoafHost on Windows.

- Install prerequisites on Windows host machine:
	- Node.js LTS
	- Rust toolchain
	- Go toolchain
	- Visual Studio Build Tools (for native builds)
- Build and run:

```bash
cd loafhost
npm install
npm run build:native
npm run build:bridge
npm start
```

- In LoafHost UI, set signaling URL to your backend (`https://signal.your-domain.com` if prompted for HTTP base URL).
- Confirm it registers and shows a 6-character room code.

6. Viewer connection test.

- Open your GitHub Pages frontend URL in browser.
- Enter host room code.
- Confirm stream starts and HUD values update (latency/fps/bitrate).

7. NAT/TURN validation.

- Test from a different network (mobile hotspot or remote ISP).
- If local works but remote fails, re-check:
	- TURN credentials in [server/.env.example](server/.env.example)
	- Coturn user/realm alignment in [turnserver.conf](turnserver.conf)
	- Firewall UDP relay range (49152-65535/udp)

8. Ongoing updates.

- Backend updates:
	- Pull latest on droplet and restart PM2 process.
- Frontend updates:
	- Push updated static files to GitHub Pages source branch.
- Host updates:
	- Rebuild and distribute Windows installer from CI artifacts.

Included infra configs:

- `turnserver.conf`
- `nginx.conf`
- `ecosystem.config.js`

## CI

Windows build workflow:

- `.github/workflows/build-windows.yml`

It builds the host app installer and uploads `.exe` artifacts/releases on push to `main`.

No deploy workflow is included.

