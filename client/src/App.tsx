import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { ArrowRight, Check, Copy, Crown, Link2, LogOut, MessageCircle, Play, Send, Shield, ShieldCheck, Users, Video, X } from "lucide-react";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";
type Role = "host" | "moderator" | "participant";
type Participant = { userId: string; username: string; role: Role };
type Playback = { videoId: string; playing: boolean; currentTime: number; updatedAt: number };
type RoomState = { roomId: string; hostId: string; playback: Playback; participants: Participant[] };
type ChatMessage = { userId: string; username: string; message: string; sentAt: number };
declare global { interface Window { YT?: any; onYouTubeIframeAPIReady?: () => void } }

function getSocket() {
  const socket = io(SERVER_URL, {
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
  });

  socket.on("connect", () => {
    console.log("[Socket.IO] Connected:", socket.id);
    console.log(
      "[Socket.IO] Transport:",
      socket.io.engine.transport.name
    );
  });

  socket.on("connect_error", (error) => {
    console.error("[Socket.IO] Connection failed:", error.message);
  });

  socket.on("disconnect", (reason) => {
    console.warn("[Socket.IO] Disconnected:", reason);
  });

  return socket;
}
function videoIdFromUrl(value: string) {
  const input = value.trim();
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname === "youtu.be") return url.pathname.slice(1);
    if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(url.hostname)) {
      return url.searchParams.get("v") || url.pathname.match(/^\/embed\/([\w-]{11})/)?.[1] || "";
    }
  } catch {}
  return "";
}

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [username, setUsername] = useState("");
  const [roomCode, setRoomCode] = useState(new URLSearchParams(window.location.search).get("room") || "");
  const [room, setRoom] = useState<RoomState | null>(null);
  const [userId, setUserId] = useState("");
  const [error, setError] = useState("");
  const [videoInput, setVideoInput] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(false);
  const playerRef = useRef<any>(null);
  const playerReady = useRef(false);
  const lastApplied = useRef("");
  const roomRef = useRef<RoomState | null>(null);
  const userRef = useRef("");
  const canControl = useMemo(() => {
    const role = room?.participants.find((p) => p.userId === userId)?.role;
    return role === "host" || role === "moderator";
  }, [room, userId]);
  const isHost = room?.hostId === userId;

  useEffect(() => {
    const s = getSocket();
    setSocket(s);
    s.on("connect", () => setConnected(true));
    s.on("disconnect", () => setConnected(false));
    s.on("room_state", (state: RoomState) => { roomRef.current = state; setRoom(state); });
    s.on("operation_error", (payload: { message: string }) => setError(payload.message));
    s.on("removed_from_room", (payload: { message: string }) => {
      setError(payload.message); setRoom(null); setUserId(""); setMessages([]);
      window.history.replaceState({}, "", window.location.pathname);
    });
    s.on("chat_message", (message: ChatMessage) => setMessages((old) => [...old.slice(-99), message]));
    return () => { s.disconnect(); };
  }, []);

  useEffect(() => {
    if (!room) return;
    if (!window.YT) {
      const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
      if (!existing) {
        const tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(tag);
      }
      window.onYouTubeIframeAPIReady = () => createPlayer();
    } else if (!playerRef.current) createPlayer();

    function createPlayer() {
      const YT = window.YT;
      if (!YT?.Player || playerRef.current) return;
      playerRef.current = new YT.Player("youtube-player", {
        width: "100%", height: "100%", videoId: room.playback.videoId,
        playerVars: { playsinline: 1, rel: 0 },
        events: {
          onReady: () => { playerReady.current = true; applyPlayback(roomRef.current?.playback); },
          onStateChange: (event: any) => {
            const current = roomRef.current;
            if (!current || !playerReady.current) return;
            // Only privileged users publish local player state changes.
            if (event.data === window.YT?.PlayerState?.PLAYING && canControl) socket?.emit("playback_action", { action: "play", currentTime: playerRef.current.getCurrentTime() });
            if (event.data === window.YT?.PlayerState?.PAUSED && canControl) socket?.emit("playback_action", { action: "pause", currentTime: playerRef.current.getCurrentTime() });
          }
        }
      });
    }
    // The IFrame API may have loaded while the component was mounting.
    if (window.YT?.Player && !playerRef.current) createPlayer();
  // Player is created once; room updates are handled by the next effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!room]);

  const applyPlayback = useCallback((playback?: Playback) => {
    const player = playerRef.current;
    if (!playback || !playerReady.current || !player) return;
    const signature = `${playback.videoId}|${playback.playing}|${Math.round(playback.currentTime)}`;
    if (lastApplied.current === signature) return;
    lastApplied.current = signature;
    try {
      if (player.getVideoData?.().video_id !== playback.videoId) {
        player.loadVideoById({ videoId: playback.videoId, startSeconds: playback.currentTime });
      } else {
        const now = player.getCurrentTime?.() ?? 0;
        if (Math.abs(now - playback.currentTime) > 2) player.seekTo(playback.currentTime, true);
        if (playback.playing) player.playVideo(); else player.pauseVideo();
      }
    } catch (e) { console.warn("Could not apply playback state yet", e); }
  }, []);

  useEffect(() => { if (room) applyPlayback(room.playback); }, [room?.playback.videoId, room?.playback.playing, room?.playback.currentTime, applyPlayback]);

  // Keep the local user's identity stable for event callbacks.
  useEffect(() => { userRef.current = userId; }, [userId]);

  const enterRoom = (mode: "create" | "join") => {
    setError("");
    if (!socket?.connected) return setError("Connecting to the server. Please try again in a moment.");
    const name = username.trim();
    if (!name) return setError("Enter your name first.");
    const event = mode === "create" ? "create_room" : "join_room";
    socket.emit(event, { username: name, roomId: roomCode }, (result: any) => {
      if (!result?.ok) return setError(result?.message || "Could not enter the room.");
      setUserId(result.userId);
      roomRef.current = result.state;
      setRoom(result.state);
      setRoomCode(result.roomId);
      window.history.replaceState({}, "", `?room=${result.roomId}`);
      setError("");
    });
  };

  const action = (name: string, payload: Record<string, unknown> = {}) => {
    if (!canControl) return setError("Only the host or a moderator can control playback.");
    socket?.emit("playback_action", { action: name, ...payload });
  };
  const changeVideo = () => {
    const id = videoIdFromUrl(videoInput);
    if (!id) return setError("Paste a valid YouTube URL or 11-character video ID.");
    action("change_video", { video: id }); setVideoInput(""); setError("");
  };
  const copyInvite = async () => {
    const invite = `${window.location.origin}${window.location.pathname}?room=${room?.roomId}`;
    try { await navigator.clipboard.writeText(invite); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
    catch { setError(`Copy this invite link: ${invite}`); }
  };
  const sendChat = (e: React.FormEvent) => {
    e.preventDefault(); if (!chatInput.trim()) return;
    socket?.emit("chat_message", { message: chatInput.trim() }); setChatInput("");
  };
  const leaveRoom = () => {
    socket?.disconnect(); setRoom(null); setUserId(""); setMessages([]);
    window.history.replaceState({}, "", window.location.pathname);
    const fresh = getSocket(); setSocket(fresh);
    fresh.on("connect", () => setConnected(true));
    fresh.on("disconnect", () => setConnected(false));
    fresh.on("room_state", (state: RoomState) => { roomRef.current = state; setRoom(state); });
    fresh.on("operation_error", (p: { message: string }) => setError(p.message));
    fresh.on("removed_from_room", (p: { message: string }) => { setError(p.message); setRoom(null); setUserId(""); });
    fresh.on("chat_message", (m: ChatMessage) => setMessages((old) => [...old.slice(-99), m]));
  };

  if (!room) return (
    <main className="landing">
      <nav className="topbar"><div className="brand"><span className="brand-icon"><Video size={20}/></span> watch<span>together</span></div><div className={`status ${connected ? "online" : ""}`}><i/> {connected ? "Server connected" : "Connecting…"}</div></nav>
      <section className="hero">
        <div className="eyebrow"><span className="pulse"/> REAL-TIME VIDEO HANGOUTS</div>
        <h1>Same video.<br/><span>Same moment.</span></h1>
        <p className="hero-copy">Bring your people together. Watch YouTube in sync, share reactions, and make every moment a group experience.</p>
        <div className="entry-card">
          <label>Your display name</label>
          <input value={username} maxLength={24} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. Sachin" onKeyDown={(e) => e.key === "Enter" && enterRoom("create")}/>
          <button className="primary full" onClick={() => enterRoom("create")}><Play size={17} fill="currentColor"/> Create a watch party <ArrowRight size={17}/></button>
          <div className="or"><span/>OR<span/></div>
          <label>Have a room code?</label>
          <div className="join-row"><input value={roomCode} onChange={(e) => setRoomCode(e.target.value.toUpperCase())} placeholder="ENTER CODE" maxLength={12} onKeyDown={(e) => e.key === "Enter" && enterRoom("join")}/><button className="secondary" onClick={() => enterRoom("join")}>Join room</button></div>
          {error && <div className="error"><X size={15}/>{error}</div>}
        </div>
        <div className="feature-row"><span><Users size={16}/> Up to 50 people</span><span><ShieldCheck size={16}/> Role-based controls</span><span><MessageCircle size={16}/> Live chat</span></div>
      </section>
      <footer>MADE FOR MOVIE NIGHTS, MUSIC SESSIONS & FRIENDS</footer>
    </main>
  );

  const currentPerson = room.participants.find((p) => p.userId === userId);
  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand"><span className="brand-icon"><Video size={20}/></span> watch<span>together</span></div>
        <div className="room-chip"><span className="live-dot"/> ROOM <b>{room.roomId}</b><button onClick={copyInvite} title="Copy invite link">{copied ? <Check size={15}/> : <Copy size={15}/>} {copied ? "Copied" : "Invite"}</button></div>
        <button className="leave-button" onClick={leaveRoom}><LogOut size={16}/> Leave</button>
      </header>
      <div className="workspace">
        <section className="main-column">
          <div className="room-heading"><div><div className="eyebrow">YOUR PRIVATE WATCH ROOM</div><h1>Movie night <span>is on.</span></h1></div><div className="watching"><span className="live-dot"/>{room.participants.length} watching</div></div>
          <div className="player-frame"><div id="youtube-player" /><div className="player-corner"><span className="live-dot"/> SYNCED PLAYER</div></div>
          <div className="video-toolbar">
            <div className="video-info"><span className="video-icon"><Video size={18}/></span><div><strong>Now watching</strong><small>YouTube video · Synced for everyone</small></div></div>
            <div className="playback-controls">
              <button disabled={!canControl} onClick={() => action("play")} title="Play"><Play size={17} fill="currentColor"/></button>
              <button disabled={!canControl} onClick={() => action("pause")} title="Pause"><span className="pause-glyph">Ⅱ</span></button>
              <button disabled={!canControl} onClick={() => action("seek", { currentTime: Math.max(0, (room.playback.currentTime || 0) - 10) })} title="Back 10s">−10s</button>
              <button disabled={!canControl} onClick={() => action("seek", { currentTime: (room.playback.currentTime || 0) + 10 })} title="Forward 10s">+10s</button>
            </div>
          </div>
          <div className="change-video panel">
            <div><strong>Change the video</strong><p>Paste a YouTube link or video ID to sync a new video.</p></div>
            <div className="video-input-row"><input disabled={!canControl} value={videoInput} onChange={(e) => setVideoInput(e.target.value)} placeholder="https://youtube.com/watch?v=..." onKeyDown={(e) => e.key === "Enter" && changeVideo()}/><button className="primary" disabled={!canControl} onClick={changeVideo}>Load video <ArrowRight size={16}/></button></div>
            {!canControl && <small className="muted"><Shield size={13}/> Playback controls are available to the host and moderators.</small>}
          </div>
          {error && <div className="error room-error"><X size={15}/>{error}<button onClick={() => setError("")}>Dismiss</button></div>}
        </section>
        <aside className="sidebar">
          <section className="panel people-panel">
            <div className="panel-title"><div><Users size={17}/><strong>In this room</strong></div><span className="count">{room.participants.length}</span></div>
            <div className="participant-list">
              {room.participants.map((person, index) => <div className="participant" key={person.userId}>
                <div className={`avatar avatar-${index % 5}`}>{person.username.slice(0, 1).toUpperCase()}</div>
                <div className="person-meta"><strong>{person.username}{person.userId === userId ? " (you)" : ""}</strong><small>{person.role === "host" ? "Room host" : person.role === "moderator" ? "Can control playback" : "Watching"}</small></div>
                <span className={`role-badge ${person.role}`}>{person.role === "host" ? <Crown size={12}/> : person.role === "moderator" ? <ShieldCheck size={12}/> : null}{person.role}</span>
                {isHost && person.userId !== userId && <div className="person-actions">
                  <select aria-label={`Role for ${person.username}`} value={person.role} onChange={(e) => socket?.emit("assign_role", { userId: person.userId, role: e.target.value })}>
                    <option value="participant">Participant</option><option value="moderator">Moderator</option>
                  </select>
                  <button className="icon-button danger" title="Remove participant" onClick={() => socket?.emit("remove_participant", { userId: person.userId })}><X size={14}/></button>
                </div>}
              </div>)}
            </div>
            {isHost && <div className="host-note"><Crown size={14}/> You're the host. Manage roles from the participant list.</div>}
          </section>
          <section className="panel chat-panel">
            <div className="panel-title"><div><MessageCircle size={17}/><strong>Room chat</strong></div><span className="chat-live">LIVE</span></div>
            <div className="chat-messages">
              {messages.length === 0 && <div className="chat-empty"><MessageCircle size={25}/><p>Break the ice.</p><span>Say hello to everyone watching.</span></div>}
              {messages.map((m, i) => <div className={`chat-message ${m.userId === userId ? "mine" : ""}`} key={`${m.sentAt}-${i}`}><div><strong>{m.username}</strong><time>{new Date(m.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><p>{m.message}</p></div>)}
            </div>
            <form className="chat-form" onSubmit={sendChat}><input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="Send a message…" maxLength={500}/><button className="send-button" aria-label="Send message"><Send size={16}/></button></form>
          </section>
          <div className="sync-status"><span className="live-dot"/><div><strong>You're in sync</strong><small>Room state updates in real time</small></div><Link2 size={17}/></div>
        </aside>
      </div>
      <footer>GOOD PEOPLE. GREAT VIDEOS. ZERO “WAIT, WHAT TIME ARE YOU AT?”</footer>
    </main>
  );
}
