# Nova UV

Nova frontend (UI) + Ultraviolet (UV) proxy backend. Works with Google, YouTube, and all major sites. Scramjet has been fully removed.

## Stack

- **Frontend**: Nova UI (sleek dark/light theme, games, apps, settings, panic key)
- **Proxy Engine**: [Ultraviolet (UV)](https://github.com/titaniumnetwork-dev/Ultraviolet) via `@nebula-services/bare-server-node`
- **Transport**: Bare Server at `/ca/` with WebSocket upgrade support

## Setup

```bash
npm install
# or
pnpm install

npm start
```

Server runs at `http://localhost:8080` by default. Set `PORT` env var to change.

## How it works

1. The service worker (`/sw.js`) intercepts requests under the `/a/` path prefix
2. UV decodes those URLs and proxies them through the bare server at `/ca/`
3. Google.com works because WebSocket upgrades are routed through the bare server (HTTPS → WSS transport)

## Files

```
index.js          — Express server + bare server
config.js         — Optional password protection
static/
  index.html      — Nova UI (single-file, all pages)
  sw.js           — UV service worker
  assets/
    mathematics/  — UV bundle, config, handler, sw
    history/      — Dynamic proxy worker + config
```

## Password Protection

Edit `config.js`:

```js
const config = {
  challenge: true,
  users: {
    admin: "yourpassword",
  },
};
```
# Nova01
# Nova01
