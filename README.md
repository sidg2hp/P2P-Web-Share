# P2P Web Share

A direct browser-to-browser file sharing app built from the `P2P Web Share - Direct Browser-to-Browser File Transfer` specification in `Mars_open_project_2026.pdf`.

## What it implements

- React frontend with a drag-and-drop file picker
- Unique room creation and shareable invite links
- Node.js + Socket.io signaling server for SDP and ICE exchange only
- WebRTC data-channel file transfer with no file payload stored on the server
- Per-chunk SHA-256 verification on the receiver
- Final whole-file SHA-256 verification before auto-download
- Real-time transfer progress, speed, verified chunk count, and connection status
- Graceful peer disconnect messaging

## Project structure

```text
client/   React + Vite frontend
server/   Express + Socket.io signaling backend
```

## Local setup

### 1. Install dependencies

```bash
npm install
```

### 2. Start the app in development

```bash
npm run dev
```

This starts:

- frontend on `http://localhost:5173`
- signaling server on `http://localhost:4000`

### 3. Test the transfer flow

1. Open `http://localhost:5173` in one browser window.
2. Drop a file smaller than `50 MB`.
3. Click `Create share room`.
4. Copy the generated invite link.
5. Open that link in a second browser window or on another device.
6. Wait for the WebRTC handshake to finish.
7. The receiver will automatically download the verified file once all chunks pass validation.

## Environment variables

### Frontend

Create `client/.env.local` if you need a non-default backend:

```bash
VITE_SIGNALING_URL=http://localhost:4000
```

### Backend

Create `server/.env` if you want to override defaults:

```bash
PORT=4000
CORS_ORIGIN=http://localhost:5173
```

If `CORS_ORIGIN` is omitted, the backend allows all origins for easier local testing.

## Production build

```bash
npm run build
```

The frontend build is emitted to [dist](./dist). The signaling server runs with:

```bash
npm run start
```

## Notes

- The MVP intentionally enforces the PDF's recommended `<50 MB` transfer size.
- The WebRTC data channel is ordered and reliable, and the app still verifies each chunk cryptographically to catch corruption.
- The server only coordinates room creation and handshake messages. It never reads or stores file bytes.
