import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { Server, Socket } from "socket.io";

type Role = "host" | "moderator" | "participant";
type Playback = {
  videoId: string;
  playing: boolean;
  currentTime: number;
  updatedAt: number;
};
type Person = {
  userId: string;
  username: string;
  role: Role;
  socketId: string;
};
type Room = {
  roomId: string;
  hostId: string;
  people: Map<string, Person>;
  playback: Playback;
};

const app = express();
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN?.split(",") ?? "http://localhost:5173",
  }),
);
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_ORIGIN?.split(",") ?? "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

const rooms = new Map<string, Room>();
const socketToUser = new Map<string, { roomId: string; userId: string }>();

app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "watch-party-server" }),
);

function makeRoomCode() {
  return randomBytes(3).toString("hex").toUpperCase();
}
function snapshot(room: Room) {
  return {
    roomId: room.roomId,
    hostId: room.hostId,
    playback: room.playback,
    participants: [...room.people.values()].map(
      ({ userId, username, role }) => ({ userId, username, role }),
    ),
  };
}
function broadcastRoom(room: Room) {
  io.to(room.roomId).emit("room_state", snapshot(room));
}
function findPerson(socket: Socket) {
  const link = socketToUser.get(socket.id);
  if (!link) return null;
  const room = rooms.get(link.roomId);
  const person = room?.people.get(link.userId);
  if (!room || !person) return null;
  return { room, person, link };
}
function mayControl(role: Role) {
  return role === "host" || role === "moderator";
}
function reject(socket: Socket, message: string) {
  socket.emit("operation_error", { message });
}
function validVideoId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{11}$/.test(value);
}
function extractVideoId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (validVideoId(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.slice(1);
      return validVideoId(id) ? id : null;
    }
    if (
      [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
      ].includes(url.hostname)
    ) {
      const id = url.searchParams.get("v");
      if (id && validVideoId(id)) return id;
      const match = url.pathname.match(/^\/embed\/([a-zA-Z0-9_-]{11})/);
      return match?.[1] ?? null;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

io.on("connection", (socket) => {
  socket.on(
    "create_room",
    (payload: { username?: string }, ack?: (result: unknown) => void) => {
      const username = String(payload?.username ?? "")
        .trim()
        .slice(0, 24);
      if (!username) return ack?.({ ok: false, message: "Enter a username." });

      let roomId = makeRoomCode();
      while (rooms.has(roomId)) roomId = makeRoomCode();
      const userId = randomUUID();
      const room: Room = {
        roomId,
        hostId: userId,
        people: new Map(),
        playback: {
          videoId: "M7lc1UVf-VE",
          playing: false,
          currentTime: 0,
          updatedAt: Date.now(),
        },
      };
      room.people.set(userId, {
        userId,
        username,
        role: "host",
        socketId: socket.id,
      });
      rooms.set(roomId, room);
      socket.join(roomId);
      socketToUser.set(socket.id, { roomId, userId });
      ack?.({ ok: true, userId, roomId, state: snapshot(room) });
      broadcastRoom(room);
    },
  );

  socket.on(
    "join_room",
    (
      payload: { roomId?: string; username?: string },
      ack?: (result: unknown) => void,
    ) => {
      const roomId = String(payload?.roomId ?? "")
        .trim()
        .toUpperCase();
      const username = String(payload?.username ?? "")
        .trim()
        .slice(0, 24);
      const room = rooms.get(roomId);
      if (!username) return ack?.({ ok: false, message: "Enter a username." });
      if (!room)
        return ack?.({
          ok: false,
          message: "Room not found. Check the code or create a new room.",
        });
      if (room.people.size >= 50)
        return ack?.({ ok: false, message: "This room is full." });

      const userId = randomUUID();
      room.people.set(userId, {
        userId,
        username,
        role: "participant",
        socketId: socket.id,
      });
      socket.join(roomId);
      socketToUser.set(socket.id, { roomId, userId });
      ack?.({ ok: true, userId, roomId, state: snapshot(room) });
      broadcastRoom(room);
    },
  );

  socket.on(
    "playback_action",
    (payload: { action?: string; currentTime?: number; video?: string }) => {
      const found = findPerson(socket);
      if (!found) return reject(socket, "Join a room first.");
      const { room, person } = found;
      if (!mayControl(person.role))
        return reject(
          socket,
          "Only the host or a moderator can control playback.",
        );

      const action = payload?.action;
      if (action === "play" || action === "pause") {
        room.playback.playing = action === "play";
        if (
          typeof payload.currentTime === "number" &&
          Number.isFinite(payload.currentTime)
        ) {
          room.playback.currentTime = Math.max(0, payload.currentTime);
        }
      } else if (action === "seek") {
        if (
          typeof payload.currentTime !== "number" ||
          !Number.isFinite(payload.currentTime) ||
          payload.currentTime < 0
        ) {
          return reject(socket, "Invalid seek position.");
        }
        room.playback.currentTime = payload.currentTime;
      } else if (action === "change_video") {
        const videoId = extractVideoId(payload.video);
        if (!videoId)
          return reject(
            socket,
            "Enter a valid YouTube URL or 11-character video ID.",
          );
        room.playback.videoId = videoId;
        room.playback.currentTime = 0;
        room.playback.playing = false;
      } else {
        return reject(socket, "Unknown playback action.");
      }
      room.playback.updatedAt = Date.now();
      broadcastRoom(room);
    },
  );

  socket.on("assign_role", (payload: { userId?: string; role?: Role }) => {
    const found = findPerson(socket);
    if (!found) return reject(socket, "Join a room first.");
    const { room, person } = found;
    if (person.role !== "host")
      return reject(socket, "Only the host can assign roles.");
    const targetId = String(payload?.userId ?? "");
    const role = payload?.role;
    if (role !== "moderator" && role !== "participant") {
      return reject(socket, "Choose Moderator or Participant.");
    }
    if (targetId === room.hostId)
      return reject(socket, "The host role cannot be changed here.");
    const target = room.people.get(targetId);
    if (!target)
      return reject(socket, "Participant is no longer in this room.");
    target.role = role;
    broadcastRoom(room);
  });

  socket.on("remove_participant", (payload: { userId?: string }) => {
    const found = findPerson(socket);
    if (!found) return reject(socket, "Join a room first.");
    const { room, person } = found;
    if (person.role !== "host")
      return reject(socket, "Only the host can remove participants.");
    const targetId = String(payload?.userId ?? "");
    if (!targetId || targetId === room.hostId)
      return reject(socket, "You cannot remove the host.");
    const target = room.people.get(targetId);
    if (!target)
      return reject(socket, "Participant is no longer in this room.");
    io.to(target.socketId).emit("removed_from_room", {
      message: "The host removed you from this room.",
    });
    io.sockets.sockets.get(target.socketId)?.leave(room.roomId);
    socketToUser.delete(target.socketId);
    room.people.delete(targetId);
    broadcastRoom(room);
  });

  socket.on("chat_message", (payload: { message?: string }) => {
    const found = findPerson(socket);
    if (!found) return reject(socket, "Join a room first.");
    const message = String(payload?.message ?? "")
      .trim()
      .slice(0, 500);
    if (!message) return;
    io.to(found.room.roomId).emit("chat_message", {
      userId: found.person.userId,
      username: found.person.username,
      message,
      sentAt: Date.now(),
    });
  });

  socket.on("disconnect", () => {
    const link = socketToUser.get(socket.id);
    if (!link) return;
    socketToUser.delete(socket.id);
    const room = rooms.get(link.roomId);
    if (!room) return;
    room.people.delete(link.userId);
    if (room.people.size === 0) {
      rooms.delete(room.roomId);
    } else {
      // If the host disconnects, promote the earliest remaining participant.
      if (room.hostId === link.userId) {
        const next = room.people.values().next().value as Person | undefined;
        if (next) {
          next.role = "host";
          room.hostId = next.userId;
        }
      }
      broadcastRoom(room);
    }
  });
});

const port = Number(process.env.PORT ?? 4000);
httpServer.listen(port, () =>
  console.log(`Watch Party API listening on http://localhost:${port}`),
);
