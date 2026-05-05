// ── Conversation Tab ──────────────────────────────────────────────────────────
//
// Module map
// ──────────────────────────────────────────────────────────────────────────────
//  ConversationWS     WebSocket wrapper for /ws/room
//  MicController      MediaRecorder: toggle on/off, fires onAudioReady(bytes)
//                     when the recording stops (push-to-talk style)
//  ParticipantList    DOM: render participants, enforce no-duplicate render
//  TranslationFeed    DOM: append incoming speaker translations
//  AudioTTS           Browser speechSynthesis for audible translated output
//  ConversationTab    Orchestrator: owns state, wires all modules together
//
// Each module has a single responsibility. ConversationTab is the only place
// that knows about the others.
// ──────────────────────────────────────────────────────────────────────────────

// Derive WebSocket URL from the page's own origin so any device on the same
// network (hotspot, LAN) reaches the right host without hard-coding 127.0.0.1.
const _wsProto = window.location.protocol === "https:" ? "wss" : "ws";
const _CONV_WS_URL = `${_wsProto}://${window.location.hostname}:8000/ws/room`;

const _LANG_BCP47 = {
  en: "en-US", es: "es-ES", fr: "fr-FR", de: "de-DE",
  it: "it-IT", pt: "pt-PT", zh: "zh-CN", ja: "ja-JP",
  ko: "ko-KR", ar: "ar-SA", ru: "ru-RU", hi: "hi-IN",
  nl: "nl-NL", pl: "pl-PL", tr: "tr-TR", tl: "fil-PH",
};

// ── ConversationWS ────────────────────────────────────────────────────────────
// Manages the WebSocket connection. Caller provides onMessage and onClose hooks.
class ConversationWS {
  constructor(onMessage, onClose) {
    this._onMessage = onMessage;
    this._onClose = onClose;
    this._ws = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(_CONV_WS_URL);
      this._ws.onopen = resolve;
      this._ws.onerror = reject;
      this._ws.onmessage = (e) => {
        try { this._onMessage(JSON.parse(e.data)); } catch (_) {}
      };
      this._ws.onclose = () => this._onClose();
    });
  }

  send(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  close() {
    if (this._ws) {
      this._ws.onclose = null; // suppress the onClose callback on intentional close
      this._ws.close();
      this._ws = null;
    }
  }
}

// ── MicController ─────────────────────────────────────────────────────────────
// Handles mic permission + MediaRecorder lifecycle.
// start() begins recording; stop() ends it and fires onAudioReady with all bytes.
class MicController {
  constructor(onAudioReady) {
    this._onAudioReady = onAudioReady;
    this._recorder = null;
    this._stream = null;
    this._chunks = [];
    this.active = false;
  }

  static _bestMimeType() {
    for (const t of ["audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }

  async start() {
    if (this.active) return;
    // Safari on iOS blocks getUserMedia on plain HTTP (non-localhost) origins.
    // Detect this early and surface a clear message instead of iOS's cryptic
    // "Speech recognition service unavailable" dialog.
    if (!navigator.mediaDevices?.getUserMedia) {
      const needsHttps = window.location.protocol !== "https:" &&
                         window.location.hostname !== "localhost" &&
                         window.location.hostname !== "127.0.0.1";
      throw new Error(
        needsHttps
          ? "Microphone requires HTTPS on iPhone/iPad. Run make-certs.sh then restart both servers with SSL."
          : "Microphone access is not available in this browser."
      );
    }
    this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this._chunks = [];
    const opts = { mimeType: MicController._bestMimeType() };
    this._recorder = new MediaRecorder(this._stream, opts);
    this._recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this._chunks.push(e.data);
    };
    this._recorder.onstop = async () => {
      const blob = new Blob(this._chunks, { type: this._recorder.mimeType });
      const buffer = await blob.arrayBuffer();
      this._onAudioReady(new Uint8Array(buffer));
      this._chunks = [];
    };
    this._recorder.start();
    this.active = true;
  }

  stop() {
    if (!this.active) return;
    this._recorder.stop();
    this._stream.getTracks().forEach((t) => t.stop());
    this.active = false;
  }
}

// ── ParticipantList ───────────────────────────────────────────────────────────
// Renders and manages the participant list in the sidebar.
// Enforces one DOM entry per participant ID — no phantom duplicates.
class ParticipantList {
  constructor(listEl) {
    this._el = listEl;
    this._ids = new Set();
  }

  setAll(participants) {
    this._el.innerHTML = "";
    this._ids.clear();
    participants.forEach((p) => this._render(p));
  }

  add(p) {
    if (this._ids.has(p.id)) return; // strict: already present, skip
    this._render(p);
  }

  remove(id) {
    this._ids.delete(id);
    const li = this._el.querySelector(`[data-pid="${id}"]`);
    if (li) li.remove();
  }

  setSpeaking(id, speaking) {
    const li = this._el.querySelector(`[data-pid="${id}"]`);
    if (li) li.classList.toggle("conv-speaking", speaking);
  }

  _render(p) {
    this._ids.add(p.id);
    const li = document.createElement("li");
    li.className = "conv-participant-item";
    li.dataset.pid = p.id;
    li.innerHTML =
      `<span class="p-dot${p.is_host ? " p-dot--host" : ""}"></span>` +
      `<span class="p-name">${p.name}${p.is_host ? " <em>(host)</em>" : ""}</span>` +
      `<span class="p-lang">${p.lang.toUpperCase()}</span>`;
    this._el.appendChild(li);
  }
}

// ── TranslationFeed ───────────────────────────────────────────────────────────
// Prepends new translation entries to the feed (newest at top).
class TranslationFeed {
  constructor(feedEl) {
    this._el = feedEl;
  }

  push(speakerName, original, translation) {
    const entry = document.createElement("div");
    entry.className = "conv-feed-entry";
    entry.innerHTML =
      `<div class="feed-speaker">${speakerName}</div>` +
      `<div class="feed-original">${original}</div>` +
      `<div class="feed-translation">&#8594; ${translation}</div>`;
    this._el.prepend(entry);
  }

  clear() {
    this._el.innerHTML = "";
  }
}

// ── AudioTTS ──────────────────────────────────────────────────────────────────
// Speaks translated text using the browser's speechSynthesis API.
// Each new utterance cancels the previous one so translations don't pile up.
class AudioTTS {
  speak(text, langCode) {
    if (!window.speechSynthesis) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = _LANG_BCP47[langCode] ?? langCode;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }
}

// ── VideoCallManager ──────────────────────────────────────────────────────────
// Manages one RTCPeerConnection per remote participant (full-mesh, video only).
// Audio translation is handled entirely by the existing WebSocket pipeline —
// this class never touches audio tracks.
//
// Black-screen guarantee:
//   Local video tracks are added to each PeerConnection BEFORE createOffer()
//   is called (WebRTC spec requires this ordering for video to flow).
//   Remote video is attached via the ontrack event, never beforehand.
//
// Polite/impolite negotiation (RFC 8829 §4.1.1):
//   The peer whose UUID sorts higher is "impolite" and always initiates.
//   This ensures exactly one side sends the offer per pair, eliminating glare.
class VideoCallManager {
  constructor(sendFn, localId) {
    this._send = sendFn;
    this._localId = localId;
    this._localStream = null;    // video-only stream from getUserMedia
    this._peers = {};            // remoteId → { pc, tile, video }
    this._gridEl = document.getElementById("convVideoGrid");
    this._localVideoEl = document.getElementById("convLocalVideo");
    this._cameraEnabled = true;
  }

  // Start local camera. Called once when entering the room.
  async start() {
    try {
      this._localStream = await navigator.mediaDevices.getUserMedia(
        { video: true, audio: false }
      );
      this._localVideoEl.srcObject = this._localStream;
      this._cameraEnabled = true;
    } catch (_) {
      // Camera denied — video simply won't be sent. Audio pipeline unaffected.
      this._localStream = null;
      this._cameraEnabled = false;
    }
  }

  // Toggle camera on/off without closing peer connections.
  // Returns the new enabled state.
  toggleCamera() {
    if (!this._localStream) return false;
    const track = this._localStream.getVideoTracks()[0];
    if (!track) return false;
    this._cameraEnabled = !track.enabled;
    track.enabled = this._cameraEnabled;
    return this._cameraEnabled;
  }

  // Create a peer connection to a remote participant and send an offer if
  // we are the impolite peer (higher UUID). Called for every participant
  // already in the room (from `joined`) and for each new joiner.
  async connectToParticipant(remoteId, remoteName) {
    if (this._peers[remoteId]) return;
    const pc = this._createPeerConnection(remoteId, remoteName);
    if (this._localId > remoteId) {
      // We are impolite: initiate. Tracks are already added inside
      // _createPeerConnection so the SDP will contain our video.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._send({ type: "webrtc_offer", to_id: remoteId, sdp: pc.localDescription });
    }
    // Polite peer just waits; the offer will arrive as a webrtc_offer message.
  }

  // Route incoming WebRTC signaling messages from the server relay.
  async onSignal(msg) {
    const remoteId = msg.from_id;
    switch (msg.type) {
      case "webrtc_offer": {
        if (!this._peers[remoteId]) this._createPeerConnection(remoteId, "");
        const { pc } = this._peers[remoteId];
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._send({ type: "webrtc_answer", to_id: remoteId, sdp: pc.localDescription });
        break;
      }
      case "webrtc_answer": {
        const peer = this._peers[remoteId];
        if (peer) await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        break;
      }
      case "webrtc_ice": {
        const peer = this._peers[remoteId];
        if (peer && msg.candidate) {
          try { await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); }
          catch (_) {}
        }
        break;
      }
    }
  }

  // Close and remove a specific peer's connection and video tile.
  disconnectParticipant(remoteId) {
    const peer = this._peers[remoteId];
    if (!peer) return;
    peer.pc.close();
    peer.tile.remove();
    delete this._peers[remoteId];
  }

  // Stop everything: close all peers, stop local camera.
  stopAll() {
    Object.keys(this._peers).forEach((id) => this.disconnectParticipant(id));
    if (this._localStream) {
      this._localStream.getTracks().forEach((t) => t.stop());
      this._localStream = null;
    }
    this._localVideoEl.srcObject = null;
  }

  _createPeerConnection(remoteId, remoteName) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    // ★ Critical: add local tracks BEFORE createOffer() so they appear in SDP.
    if (this._localStream) {
      this._localStream.getTracks().forEach((t) =>
        pc.addTrack(t, this._localStream)
      );
    }

    // Build the remote video tile.
    const tile = document.createElement("div");
    tile.className = "conv-video-tile";
    tile.dataset.pid = remoteId;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;

    const label = document.createElement("span");
    label.className = "conv-video-label";
    label.textContent = remoteName || "Participant";

    tile.appendChild(video);
    tile.appendChild(label);
    this._gridEl.appendChild(tile);

    this._peers[remoteId] = { pc, tile, video };

    // ★ Attach remote stream via ontrack — never before it fires.
    pc.ontrack = (e) => { video.srcObject = e.streams[0]; };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this._send({
          type: "webrtc_ice",
          to_id: remoteId,
          candidate: e.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") this.disconnectParticipant(remoteId);
    };

    return pc;
  }

  // Update the label on a remote tile (e.g. after we learn their name).
  updateLabel(remoteId, name) {
    const peer = this._peers[remoteId];
    if (peer) peer.tile.querySelector(".conv-video-label").textContent = name;
  }
}

// ── ConversationTab ───────────────────────────────────────────────────────────
// Orchestrator. Owns all state and wires the modules together.
// One instance per app session (lazy-initialized on first tab activation).
class ConversationTab {
  constructor() {
    const $ = (id) => document.getElementById(id);

    // Instantiate sub-modules
    this._ws = new ConversationWS(
      (msg) => this._onMessage(msg),
      () => this._onDisconnect(),
    );
    this._mic = new MicController((bytes) => this._sendAudio(bytes));
    this._pList = new ParticipantList($("convParticipants"));
    this._feed = new TranslationFeed($("convFeed"));
    this._tts = new AudioTTS();

    // Persistent session ID prevents phantom duplicate entries on reconnect.
    // sessionStorage is per browser-tab, so two tabs = two different IDs.
    this._participantId = this._getOrCreateSessionId();
    this._roomCode = null;
    this._participants = {}; // id → {id, name, lang, is_host}

    this._video = new VideoCallManager(
      (msg) => this._ws.send(msg),
      this._participantId,
    );

    // DOM refs
    this._nameInput = $("convName");
    this._langSelect = $("convLang");
    this._codeInput = $("convRoomCode");
    this._codeDisplay = $("convCodeDisplay");
    this._micBtn = $("convMicBtn");
    this._micStatus = $("convMicStatus");
    this._camBtn = $("convCamBtn");
    this._camStatus = $("convCamStatus");
    this._errEl = $("convSetupError");

    // Wire buttons
    $("convCreateBtn").addEventListener("click", () => this._createRoom());
    $("convJoinBtn").addEventListener("click", () => this._joinRoom());
    $("convLeaveBtn").addEventListener("click", () => this._leaveRoom());
    this._micBtn.addEventListener("click", () => this._toggleMic());
    this._camBtn.addEventListener("click", () => this._toggleCamera());
  }

  // ── Session identity ──────────────────────────────────────────────────────
  _getOrCreateSessionId() {
    const KEY = "conv_pid";
    if (!sessionStorage.getItem(KEY)) {
      sessionStorage.setItem(KEY, crypto.randomUUID());
    }
    return sessionStorage.getItem(KEY);
  }

  // ── Room actions ──────────────────────────────────────────────────────────
  async _createRoom() {
    const name = this._nameInput.value.trim();
    if (!name) { this._setError("Enter your name first."); return; }
    this._clearError();
    if (!await this._connect()) return;
    this._ws.send({
      type: "create_room",
      participant_id: this._participantId,
      name,
      lang: this._langSelect.value,
    });
  }

  async _joinRoom() {
    const name = this._nameInput.value.trim();
    const code = this._codeInput.value.trim();
    if (!name) { this._setError("Enter your name first."); return; }
    if (!/^\d{6}$/.test(code)) { this._setError("Enter a valid 6-digit room code."); return; }
    this._clearError();
    if (!await this._connect()) return;
    this._ws.send({
      type: "join_room",
      code,
      participant_id: this._participantId,
      name,
      lang: this._langSelect.value,
    });
  }

  _leaveRoom() {
    this._mic.stop();
    this._video.stopAll();
    this._ws.send({ type: "leave_room" });
    this._ws.close();
    this._roomCode = null;
    this._participants = {};
    this._feed.clear();
    this._pList.setAll([]);
    this._showSetupPanel();
  }

  async _connect() {
    try {
      await this._ws.connect();
      return true;
    } catch (_) {
      this._setError("Cannot connect to server. Is the backend running?");
      return false;
    }
  }

  // ── Mic toggle ────────────────────────────────────────────────────────────
  // Click once to start recording (mic unmuted), click again to stop and
  // send the full recording for translation.
  async _toggleMic() {
    if (this._mic.active) {
      this._mic.stop(); // triggers MicController.onstop → _sendAudio
      this._micBtn.classList.remove("conv-mic--active");
      this._micStatus.textContent = "Processing…";
    } else {
      try {
        await this._mic.start();
        this._micBtn.classList.add("conv-mic--active");
        this._micStatus.textContent = "Recording… click to send";
      } catch (e) {
        this._setError(e.message || "Mic access denied. Check browser permissions.");
      }
    }
  }

  // ── Camera toggle ─────────────────────────────────────────────────────────
  _toggleCamera() {
    const on = this._video.toggleCamera();
    this._camBtn.classList.toggle("conv-cam--off", !on);
    this._camStatus.textContent = on ? "Camera on" : "Camera off";
  }

  // ── Audio delivery ────────────────────────────────────────────────────────
  _sendAudio(uint8Array) {
    // Encode bytes to base64 without spread operator (safe for large buffers)
    let binary = "";
    for (let i = 0; i < uint8Array.byteLength; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    this._ws.send({ type: "audio_chunk", data: btoa(binary) });
    this._micStatus.textContent = "Click to speak";
  }

  // ── Incoming message routing ──────────────────────────────────────────────
  _onMessage(msg) {
    switch (msg.type) {
      case "room_created":
      case "joined": {
        this._roomCode = msg.code;
        this._codeDisplay.textContent = msg.code;
        this._participants = {};
        msg.participants.forEach((p) => { this._participants[p.id] = p; });
        this._pList.setAll(msg.participants);
        this._showRoomPanel();

        // Start camera then connect to every participant already in the room.
        this._video.start().then(() => {
          const others = msg.participants.filter(
            (p) => p.id !== this._participantId
          );
          return Promise.all(
            others.map((p) => this._video.connectToParticipant(p.id, p.name))
          );
        }).catch(() => {});
        break;
      }

      case "join_error":
        this._setError(msg.message);
        this._ws.close();
        break;

      case "participant_joined":
        this._participants[msg.id] = msg;
        this._pList.add(msg);
        this._video.connectToParticipant(msg.id, msg.name).catch(() => {});
        break;

      case "participant_left":
        delete this._participants[msg.id];
        this._pList.remove(msg.id);
        this._video.disconnectParticipant(msg.id);
        break;

      case "speaker_translation":
        this._feed.push(msg.speaker_name, msg.original, msg.translation);
        this._tts.speak(msg.translation, msg.target_lang);
        break;

      case "webrtc_offer":
      case "webrtc_answer":
      case "webrtc_ice": {
        // Fill in label if we know this peer's name.
        const name = this._participants[msg.from_id]?.name;
        this._video.onSignal(msg).then(() => {
          if (name) this._video.updateLabel(msg.from_id, name);
        }).catch(() => {});
        break;
      }

      case "error":
        this._setError(msg.message);
        break;
    }
  }

  _onDisconnect() {
    if (this._roomCode) this._setError("Disconnected from server.");
  }

  // ── UI helpers ────────────────────────────────────────────────────────────
  _showSetupPanel() {
    document.getElementById("convSetup").style.display = "";
    document.getElementById("convRoom").style.display = "none";
  }

  _showRoomPanel() {
    document.getElementById("convSetup").style.display = "none";
    document.getElementById("convRoom").style.display = "";
  }

  _setError(msg) {
    this._errEl.textContent = msg;
    this._errEl.style.display = "";
  }

  _clearError() {
    this._errEl.textContent = "";
    this._errEl.style.display = "none";
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
// Called by app.js when the conversation tab is first activated.
// Safe to call multiple times — creates only one instance.
function initConversationTab() {
  if (!window._convTabInst) {
    window._convTabInst = new ConversationTab();
  }
}
