(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const lobby = $("lobby"), callView = $("call"), joinForm = $("join-form");
  const state = {
    room: "", name: "", id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    ws: null, localStream: null, peers: new Map(), peerNames: new Map(), peerStreams: new Map(),
    micOn: true, cameraOn: true, joined: false, reconnectTimer: null, toastTimer: null,
    config: { signalingUrl: "wss://call.yakton.net/ws" }
  };
  const rtcConfig = { iceServers: [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" }
    // Add a TURN server here for reliable connectivity across restrictive networks.
  ]};

  $("year").textContent = new Date().getFullYear();
  const params = new URLSearchParams(location.search);
  if (params.get("room")) $("room-code").value = sanitizeRoom(params.get("room"));
  if (params.get("name")) $("display-name").value = params.get("name").slice(0,32);

  function sanitizeRoom(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0,32); }
  function initials(name) { return (name.trim().split(/\s+/).map(p => p[0]).join("").slice(0,2) || "?").toUpperCase(); }
  function toast(message) {
    const el = $("toast"); el.textContent = message; el.classList.add("show");
    clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }
  function setStatus(text, kind="") {
    const el = $("connection-status"); el.innerHTML = `<span class="status-dot"></span> ${text}`;
    el.className = `status-pill ${kind}`;
  }
  function send(message) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(message));
  }
  function appendSystem(text) {
    const wrap = document.createElement("div"); wrap.className = "chat-system-message";
    const star = document.createElement("span"); star.className = "system-star"; star.textContent = "✳";
    const p = document.createElement("p"); p.textContent = text; wrap.append(star,p); $("chat-messages").append(wrap); scrollChat();
  }
  function scrollChat() { $("chat-messages").scrollTop = $("chat-messages").scrollHeight; }
  function appendMessage(name, text, time = new Date()) {
    const wrap = document.createElement("div"); wrap.className = "message";
    const avatar = document.createElement("div"); avatar.className = "message-avatar"; avatar.textContent = initials(name);
    const content = document.createElement("div"); content.className = "message-content";
    const meta = document.createElement("div"); meta.className = "message-meta";
    const who = document.createElement("span"); who.className = "message-name"; who.textContent = name;
    const stamp = document.createElement("span"); stamp.className = "message-time"; stamp.textContent = time.toLocaleTimeString([], {hour:"numeric",minute:"2-digit"});
    const body = document.createElement("div"); body.className = "message-text"; body.textContent = String(text).slice(0,500);
    meta.append(who,stamp); content.append(meta,body); wrap.append(avatar,content); $("chat-messages").append(wrap); scrollChat();
  }
  function addRemoteTile(id, name, stream) {
    let tile = $(`peer-${id}`);
    if (!tile) {
      tile = document.createElement("article"); tile.className = "video-tile"; tile.id = `peer-${id}`;
      const video = document.createElement("video"); video.autoplay = true; video.playsInline = true; video.dataset.peer = id;
      const placeholder = document.createElement("div"); placeholder.className = "video-placeholder"; placeholder.innerHTML = `<span class="placeholder-avatar"></span><span>Waiting for video…</span>`;
      const label = document.createElement("div"); label.className = "tile-label";
      const dot = document.createElement("span"); dot.className = "you-dot"; dot.style.background = "#7e9cff";
      const n = document.createElement("span"); n.className = "remote-name"; n.textContent = name;
      const mic = document.createElement("div"); mic.className = "tile-mic"; mic.textContent = "🎙";
      label.append(dot,n); tile.append(video,placeholder,label,mic); $("video-grid").append(tile);
    }
    tile.querySelector(".remote-name").textContent = name;
    const video = tile.querySelector("video"); if (video.srcObject !== stream) video.srcObject = stream;
    tile.querySelector(".placeholder-avatar").textContent = initials(name);
    tile.querySelector(".video-placeholder").classList.toggle("hidden", stream.getVideoTracks().some(t => t.enabled && t.readyState === "live"));
    updateParticipantCount();
  }
  function removeRemoteTile(id) {
    const tile = $(`peer-${id}`); if (tile) tile.remove();
    state.peerStreams.delete(id); state.peerNames.delete(id); updateParticipantCount();
    if (state.peers.has(id)) { try { state.peers.get(id).close(); } catch {} state.peers.delete(id); }
  }
  function updateParticipantCount() {
    const count = 1 + state.peerNames.size;
    $("participant-count").textContent = `${count} ${count === 1 ? "person" : "people"} here`;
    $("empty-state").classList.toggle("hidden", state.peerNames.size > 0);
  }
  async function createPeer(id, name, shouldOffer) {
    if (state.peers.has(id)) return state.peers.get(id);
    const pc = new RTCPeerConnection(rtcConfig);
    state.peers.set(id, pc); state.peerNames.set(id, name || "Guest");
    state.localStream?.getTracks().forEach(track => pc.addTrack(track, state.localStream));
    pc.onicecandidate = e => { if (e.candidate) send({type:"signal",to:id,signal:{candidate:e.candidate}}); };
    pc.ontrack = e => {
      let stream = state.peerStreams.get(id);
      if (!stream) { stream = e.streams[0] || new MediaStream(); state.peerStreams.set(id,stream); }
      if (!e.streams[0] && !stream.getTracks().some(t=>t.id===e.track.id)) stream.addTrack(e.track);
      addRemoteTile(id, state.peerNames.get(id) || name || "Guest", stream);
      e.track.onmute = () => { const tile = $(`peer-${id}`); if (tile && e.track.kind === "video") tile.querySelector(".video-placeholder").classList.remove("hidden"); };
      e.track.onunmute = () => { const tile = $(`peer-${id}`); if (tile && e.track.kind === "video") tile.querySelector(".video-placeholder").classList.add("hidden"); };
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") { pc.restartIce?.(); toast(`Connection issue with ${state.peerNames.get(id) || "a participant"}.`); }
      if (pc.connectionState === "closed" || pc.connectionState === "disconnected") {
        const tile = $(`peer-${id}`); if (tile) tile.classList.add("disconnected");
      }
    };
    if (shouldOffer) {
      try { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); send({type:"signal",to:id,signal:{description:pc.localDescription}}); }
      catch (e) { console.error("Offer failed", e); }
    }
    updateParticipantCount(); return pc;
  }
  async function handleSignal(msg) {
    const from = msg.from; if (!from || from === state.id) return;
    const name = msg.name || state.peerNames.get(from) || "Guest";
    const pc = await createPeer(from,name,false);
    if (msg.signal.description) {
      const desc = msg.signal.description;
      await pc.setRemoteDescription(desc);
      if (desc.type === "offer") { const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); send({type:"signal",to:from,signal:{description:pc.localDescription}}); }
    } else if (msg.signal.candidate) {
      try { await pc.addIceCandidate(msg.signal.candidate); } catch (e) { console.debug("ICE candidate ignored",e); }
    }
  }
  async function startLocalMedia() {
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({audio:true,video:{width:{ideal:1280},height:{ideal:720},facingMode:"user"}});
    } catch (firstError) {
      try { state.localStream = await navigator.mediaDevices.getUserMedia({audio:true,video:false}); state.cameraOn = false; toast("Camera unavailable. Joining with microphone only."); }
      catch (e) {
        try { state.localStream = await navigator.mediaDevices.getUserMedia({audio:false,video:false}); state.micOn=false; state.cameraOn=false; toast("Camera and microphone unavailable. You can still use room chat."); }
        catch { throw new Error("Camera/microphone permission was denied. Allow access in your browser settings and try again."); }
      }
    }
    $("local-video").srcObject = state.localStream;
    $("local-name").textContent = `${state.name}`;
    $("local-avatar").textContent = initials(state.name);
    $("local-placeholder").classList.toggle("hidden", state.localStream.getVideoTracks().some(t=>t.enabled));
    state.localStream.getAudioTracks().forEach(t => t.enabled = state.micOn);
    state.localStream.getVideoTracks().forEach(t => t.enabled = state.cameraOn);
    updateControlButtons(); await populateDevices();
  }
  async function populateDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      fillSelect($("mic-select"),devices.filter(d=>d.kind==="audioinput"),"Microphone unavailable");
      fillSelect($("camera-select"),devices.filter(d=>d.kind==="videoinput"),"Camera unavailable");
      fillSelect($("output-select"),devices.filter(d=>d.kind==="audiooutput"),"Default speaker");
      $("output-select").disabled = !("setSinkId" in HTMLMediaElement.prototype);
    } catch(e) { console.debug("Device enumeration unavailable",e); }
  }
  function fillSelect(select, devices, fallback) {
    const old = select.value; select.replaceChildren();
    if (!devices.length) { const o=document.createElement("option");o.value="";o.textContent=fallback;select.append(o);return; }
    devices.forEach((d,i)=>{const o=document.createElement("option");o.value=d.deviceId;o.textContent=d.label||`${d.kind.replace("input","").replace("video","Camera")} ${i+1}`;select.append(o);});
    if ([...select.options].some(o=>o.value===old)) select.value=old;
  }
  async function switchDevice(kind, deviceId) {
    if (!deviceId || !state.localStream) return;
    const isVideo = kind === "videoinput";
    try {
      const fresh = await navigator.mediaDevices.getUserMedia(isVideo ? {video:{deviceId:{exact:deviceId}},audio:false} : {audio:{deviceId:{exact:deviceId}},video:false});
      const track = fresh.getTracks()[0];
      const old = isVideo ? state.localStream.getVideoTracks()[0] : state.localStream.getAudioTracks()[0];
      if (old) {
        state.localStream.removeTrack(old); old.stop();
        for (const pc of state.peers.values()) {
          const sender = pc.getSenders().find(s=>s.track && s.track.kind===track.kind);
          if (sender) await sender.replaceTrack(track); else pc.addTrack(track,state.localStream);
        }
      } else { for (const pc of state.peers.values()) pc.addTrack(track,state.localStream); }
      state.localStream.addTrack(track); track.enabled = isVideo ? state.cameraOn : state.micOn;
      $("local-video").srcObject = state.localStream;
      await populateDevices();
    } catch(e) { toast(`Couldn't switch ${isVideo?"camera":"microphone"}. Check browser permissions.`); }
  }
  function updateControlButtons() {
    const mic=$("mic-btn"), cam=$("camera-btn");
    mic.classList.toggle("active",state.micOn);mic.classList.toggle("off",!state.micOn);
    mic.setAttribute("aria-label",state.micOn?"Mute microphone":"Unmute microphone");mic.title=state.micOn?"Mute microphone":"Unmute microphone";
    mic.innerHTML=state.micOn?'<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21m-4 0h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>':'<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21m-4 0h8M4 4l16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    cam.classList.toggle("active",state.cameraOn);cam.classList.toggle("off",!state.cameraOn);
    cam.setAttribute("aria-label",state.cameraOn?"Turn camera off":"Turn camera on");cam.title=state.cameraOn?"Turn camera off":"Turn camera on";
    cam.innerHTML=state.cameraOn?'<svg viewBox="0 0 24 24"><rect x="3" y="6" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m15 10 6-3v10l-6-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>':'<svg viewBox="0 0 24 24"><rect x="3" y="6" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m15 10 6-3v10l-6-3M4 4l16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    $("local-placeholder").classList.toggle("hidden",state.cameraOn && state.localStream?.getVideoTracks().some(t=>t.readyState==="live"));
    $("local-mic-state").textContent=state.micOn?"🎙":"🔇";$("local-mic-state").classList.toggle("muted",!state.micOn);
    state.localStream?.getAudioTracks().forEach(t=>t.enabled=state.micOn);
    state.localStream?.getVideoTracks().forEach(t=>t.enabled=state.cameraOn);
  }
  function connectSocket() {
    return new Promise((resolve,reject)=>{
      const url = new URL(state.config.signalingUrl);
      url.searchParams.set("room",state.room);url.searchParams.set("id",state.id);
      let ws;
      try { ws = new WebSocket(url); } catch { reject(new Error("Could not open signaling connection."));return; }
      state.ws=ws;
      const timeout=setTimeout(()=>{if(ws.readyState!==WebSocket.OPEN){ws.close();reject(new Error("Signaling server timed out. Check your Cloudflare Worker deployment."));}},9000);
      ws.onopen=()=>{clearTimeout(timeout);send({type:"hello",id:state.id,name:state.name});setStatus("Connected","connected");resolve();};
      ws.onerror=()=>{clearTimeout(timeout);setStatus("Connection issue","error");};
      ws.onclose=()=>{setStatus("Disconnected","error");if(state.joined){appendSystem("Connection to the room server was lost. Try leaving and rejoining.");}};
      ws.onmessage=async event=>{
        let msg;try{msg=JSON.parse(event.data)}catch{return}
        try {
          if(msg.type==="welcome"){(msg.peers||[]).forEach(p=>{state.peerNames.set(p.id,p.name);});}
          else if(msg.type==="peer-joined"){appendSystem(`${msg.name||"Someone"} joined the room.`);await createPeer(msg.id,msg.name,true);}
          else if(msg.type==="peer-left"){appendSystem(`${msg.name||"Someone"} left the room.`);removeRemoteTile(msg.id);}
          else if(msg.type==="signal"){await handleSignal(msg);}
          else if(msg.type==="chat"){appendMessage(msg.name||"Guest",msg.text,new Date(msg.time||Date.now()));}
          else if(msg.type==="error"){toast(msg.message||"Room server error.");}
        } catch(e){console.error("Message handling error",e);}
      };
    });
  }
  async function joinRoom(event) {
    event?.preventDefault();
    const name=$("display-name").value.trim().slice(0,32);
    const room=sanitizeRoom($("room-code").value);
    $("lobby-error").textContent="";
    if(!name){$("lobby-error").textContent="Please enter your name.";return;}
    if(room.length<3){$("lobby-error").textContent="Room codes must be at least 3 characters.";return;}
    if(!/^[a-z0-9_-]+$/.test(room)){$("lobby-error").textContent="Use letters, numbers, hyphens, or underscores.";return;}
    if(!navigator.mediaDevices && !("WebSocket" in window)){$("lobby-error").textContent="This browser does not support calling.";return;}
    state.name=name;state.room=room;state.joined=true;
    $("call-room-title").textContent=room;$("local-name").textContent=name;
    lobby.classList.add("hidden");$("how-it-works").classList.add("hidden");callView.classList.remove("hidden");
    history.replaceState(null,"",`${location.pathname}?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`);
    try { await startLocalMedia(); } catch(e) { toast(e.message); }
    try { await connectSocket(); } catch(e) { setStatus("Offline","error");toast(e.message);appendSystem("Room chat and calls need the Cloudflare signaling Worker to be deployed."); }
    updateParticipantCount();
  }
  async function leaveRoom() {
    state.joined=false;clearTimeout(state.reconnectTimer);
    try{send({type:"leave"});state.ws?.close();}catch{}
    for(const pc of state.peers.values()){try{pc.close()}catch{}}
    state.peers.clear();state.peerNames.clear();state.peerStreams.clear();
    state.localStream?.getTracks().forEach(t=>t.stop());state.localStream=null;
    $("local-video").srcObject=null;
    document.querySelectorAll("#video-grid .video-tile:not(#local-tile)").forEach(el=>el.remove());
    $("chat-messages").replaceChildren();appendSystem("Welcome to the room. Say hello while everyone joins.");
    callView.classList.add("hidden");lobby.classList.remove("hidden");$("how-it-works").classList.remove("hidden");
    setStatus("Connecting");history.replaceState(null,"",location.pathname);updateParticipantCount();
  }
  joinForm.addEventListener("submit",joinRoom);
  $("generate-code").addEventListener("click",()=>{$("room-code").value=`room-${Math.random().toString(36).slice(2,8)}`;});
  $("mic-btn").addEventListener("click",()=>{state.micOn=!state.micOn;updateControlButtons();});
  $("camera-btn").addEventListener("click",async()=>{if(!state.cameraOn&&!state.localStream?.getVideoTracks().length){try{const s=await navigator.mediaDevices.getUserMedia({video:true,audio:false});const track=s.getVideoTracks()[0];state.localStream.addTrack(track);for(const pc of state.peers.values()){const sender=pc.getSenders().find(x=>x.track?.kind==="video");if(sender)await sender.replaceTrack(track);else pc.addTrack(track,state.localStream);} $("local-video").srcObject=state.localStream;state.cameraOn=true;}catch{toast("Camera permission was denied.");return;}}else state.cameraOn=!state.cameraOn;updateControlButtons();});
  $("mic-menu-btn").addEventListener("click",()=>{$("mic-menu").classList.toggle("hidden");$("camera-menu").classList.add("hidden");});
  $("camera-menu-btn").addEventListener("click",()=>{$("camera-menu").classList.toggle("hidden");$("mic-menu").classList.add("hidden");});
  $("mic-select").addEventListener("change",e=>switchDevice("audioinput",e.target.value));
  $("camera-select").addEventListener("change",e=>switchDevice("videoinput",e.target.value));
  $("output-select").addEventListener("change",async e=>{const id=e.target.value;for(const v of document.querySelectorAll("video"))if(v.setSinkId){try{await v.setSinkId(id)}catch{toast("Could not change audio output.");}}});
  $("chat-form").addEventListener("submit",e=>{e.preventDefault();const input=$("chat-input");const text=input.value.trim().slice(0,500);if(!text)return;if(!state.ws||state.ws.readyState!==WebSocket.OPEN){toast("Chat is unavailable while disconnected.");return;}send({type:"chat",text});input.value="";});
  $("copy-invite").addEventListener("click",async()=>{const url=new URL(location.href);url.searchParams.set("room",state.room);url.searchParams.delete("name");await copyText(url.toString(),"Invite link copied");});
  $("copy-room-code").addEventListener("click",()=>copyText(state.room,"Room code copied"));
  $("leave-btn").addEventListener("click",leaveRoom);
  async function copyText(text,msg){try{await navigator.clipboard.writeText(text);toast(msg);}catch{const t=document.createElement("textarea");t.value=text;document.body.append(t);t.select();document.execCommand("copy");t.remove();toast(msg);}}
  navigator.mediaDevices?.addEventListener?.("devicechange",populateDevices);
  window.addEventListener("beforeunload",()=>{try{state.ws?.close()}catch{}state.localStream?.getTracks().forEach(t=>t.stop());});
})();
