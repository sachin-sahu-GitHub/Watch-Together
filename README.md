# WatchTogether — YouTube Watch Party

A real-time YouTube watch party built with React, TypeScript, Express, Socket.IO, and the YouTube IFrame Player API.

## Features

- Create a room or join by room code / invite link
- Host and participant roles; host can promote/demote moderators and remove participants
- Server-side permission enforcement for playback controls
- Play/pause, seek, and change-video synchronization
- Room participant list and live chat
- Responsive dark UI

## Requirements

- Node.js 20 or newer
- npm

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

On Windows PowerShell, copy the environment template with:

```powershell
Copy-Item .env.example .env
```

- Frontend: http://localhost:5173
- Backend health check: http://localhost:4000/health

Open the app in two browser windows. Create a room in one, copy the room code, and join from the other.

## Environment variables

Server `.env`:
- `PORT=4000`
- `CLIENT_ORIGIN=http://localhost:5173`

Client `client/.env` (optional):
- `VITE_SERVER_URL=http://localhost:4000`

For production, set `VITE_SERVER_URL` to the deployed backend URL and set `CLIENT_ORIGIN` on the backend to the deployed frontend origin. Use `https://` and `wss://` in production as appropriate.

## Architecture

The browser embeds a YouTube IFrame Player. The client sends playback actions to the Socket.IO server. The server validates the sender's role and updates the room's authoritative playback state. It broadcasts the new state to all room members, and clients apply it to their local player. The server is the security boundary: UI-disabled buttons alone are not authorization.

Room state is currently in memory for the MVP. Rooms disappear when the server restarts or when everyone leaves. Add a database for persistence and Redis Pub/Sub or the Socket.IO Redis adapter for multi-instance scaling.

## Deployment

Deploy the backend as a persistent Node web service (for example, Render) and the frontend as a static site (for example, Render Static Site or Vercel). The backend must support WebSocket connections.

### Backend service

- Root directory: repository root
- Build command: `npm install && npm run build -w server`
- Start command: `npm run start -w server`
- Environment: `PORT` is provided by the platform; set `CLIENT_ORIGIN` to your deployed frontend URL

### Frontend static site

- Root directory: `client`
- Build command (from repository root if configured): `npm install && npm run build -w client`
- Publish directory: `client/dist`
- Environment variable: `VITE_SERVER_URL=https://YOUR-BACKEND-URL`

After deployment, replace this section with the actual live URL.

## Important MVP notes

- Host disconnect promotes the next connected participant to host.
- In-memory state is not durable and does not support cross-instance synchronization.
- The current-time updates are event-driven. For production-grade drift correction, add periodic state snapshots and carefully suppress player-originated events while applying remote updates.
- Do not use this MVP as-is for untrusted public rooms without adding stronger abuse protection, rate limiting, and identity/authentication.
