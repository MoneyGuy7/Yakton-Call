/**
 * Yakton Call signaling Worker + Durable Object room coordinator.
 * Deploy with Wrangler. This coordinates WebRTC offers/answers/ICE and room chat;
 * it does NOT relay the audio/video media itself.
 */
const ROOM_RE = /^[a-z0-9_-]{3,32}$/;
const MAX_ROOM_SIZE = 12;
const MAX_MESSAGE_LENGTH = 500;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "yakton-call-signaling" });
    }
    if (url.pathname !== "/ws") {
      return new Response("Yakton Call signaling service. Use /ws?room=ROOM_CODE", {
        status: 200, headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const room = (url.searchParams.get("room") || "").toLowerCase();
    const id = url.searchParams.get("id") || "";
    if (!ROOM_RE.test(room)) return new Response("Invalid room code.", { status: 400 });
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) return new Response("Invalid client ID.", { status: 400 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    return stub.fetch(request);
  }
};

export class Room {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    const room = (url.searchParams.get("room") || "").toLowerCase();
    const id = url.searchParams.get("id") || "";
    if (!ROOM_RE.test(room) || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)) {
      return new Response("Invalid room or client ID", { status: 400 });
    }
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_ROOM_SIZE) return new Response("Room is full (maximum 12 participants).", { status: 429 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, name: "Guest", room, joined: false });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, raw) {
    let data;
    try { data = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); }
    catch { return this.safeSend(ws, { type: "error", message: "Invalid message format." }); }
    const meta = ws.deserializeAttachment() || {};
    if (data.type === "hello") {
      const name = String(data.name || "Guest").trim().replace(/[<>]/g, "").slice(0, 32) || "Guest";
      if (meta.joined) return;
      meta.name = name; meta.joined = true; ws.serializeAttachment(meta);
      const peers = this.ctx.getWebSockets().filter(s => s !== ws).map(s => {
        const m = s.deserializeAttachment() || {};
        return { id: m.id, name: m.name || "Guest" };
      }).filter(p => p.id);
      this.safeSend(ws, { type: "welcome", peers });
      this.broadcast({ type: "peer-joined", id: meta.id, name }, ws);
      return;
    }
    if (!meta.joined) return this.safeSend(ws, { type: "error", message: "Send hello before using the room." });
    if (data.type === "chat") {
      const text = String(data.text || "").trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!text) return;
      this.broadcast({ type: "chat", id: meta.id, name: meta.name, text, time: Date.now() });
      return;
    }
    if (data.type === "signal") {
      const to = String(data.to || "");
      if (!to || to === meta.id || !data.signal || typeof data.signal !== "object") return;
      // Only forward to a socket inside this same room.
      const target = this.ctx.getWebSockets().find(s => (s.deserializeAttachment() || {}).id === to);
      if (target) this.safeSend(target, { type: "signal", from: meta.id, name: meta.name, signal: data.signal });
      return;
    }
    if (data.type === "leave") {
      this.closePeer(ws, meta);
    }
  }
  async webSocketClose(ws, code, reason) {
    this.closePeer(ws, ws.deserializeAttachment() || {});
  }
  async webSocketError(ws) {
    this.closePeer(ws, ws.deserializeAttachment() || {});
  }
  closePeer(ws, meta) {
    if (meta.joined && meta.id) {
      this.broadcast({ type: "peer-left", id: meta.id, name: meta.name || "Guest" }, ws);
      const updated = { ...meta, joined: false };
      try { ws.serializeAttachment(updated); } catch {}
    }
  }
  broadcast(message, except = null) {
    const payload = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try { socket.send(payload); } catch {}
    }
  }
  safeSend(ws, message) { try { ws.send(JSON.stringify(message)); } catch {} }
}
