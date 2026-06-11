import cors from "cors";
import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);

const port = Number(process.env.PORT) || 4000;
const corsOrigin = process.env.CORS_ORIGIN || "*";

app.use(
  cors({
    origin: corsOrigin,
  }),
);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "p2p-web-share-signaling",
    timestamp: new Date().toISOString(),
  });
});

const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"],
  },
});

function getRoomSize(roomId) {
  return io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
}

io.on("connection", (socket) => {
  socket.on("create-room", ({ roomId }, callback = () => {}) => {
    if (!roomId) {
      callback({ ok: false, error: "A room ID is required." });
      return;
    }

    if (getRoomSize(roomId) > 0) {
      callback({ ok: false, error: "That room already exists." });
      return;
    }

    socket.join(roomId);
    callback({ ok: true, roomId });
  });

  socket.on("join-room", ({ roomId }, callback = () => {}) => {
    if (!roomId) {
      callback({ ok: false, error: "A room ID is required." });
      return;
    }

    const roomSize = getRoomSize(roomId);

    if (roomSize === 0) {
      callback({ ok: false, error: "The room does not exist or has expired." });
      return;
    }

    if (roomSize >= 2) {
      callback({ ok: false, error: "This room is already full." });
      return;
    }

    socket.join(roomId);
    socket.to(roomId).emit("peer-joined", { roomId });
    callback({ ok: true, roomId });
  });

  socket.on("signal", ({ roomId, payload }) => {
    if (!roomId || !payload) {
      return;
    }

    socket.to(roomId).emit("signal", {
      roomId,
      payload,
    });
  });

  socket.on("disconnecting", () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) {
        continue;
      }

      socket.to(roomId).emit("peer-disconnected", {
        roomId,
      });
    }
  });
});

server.listen(port, () => {
  console.log(`Signaling server listening on http://localhost:${port}`);
});

