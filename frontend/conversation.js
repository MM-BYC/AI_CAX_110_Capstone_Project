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

const _CONV_WS_URL = "ws://127.0.0.1:8000/ws/room";

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

    // DOM refs
    this._nameInput = $("convName");
    this._langSelect = $("convLang");
    this._codeInput = $("convRoomCode");
    this._codeDisplay = $("convCodeDisplay");
    this._micBtn = $("convMicBtn");
    this._micStatus = $("convMicStatus");
    this._errEl = $("convSetupError");

    // Wire buttons
    $("convCreateBtn").addEventListener("click", () => this._createRoom());
    $("convJoinBtn").addEventListener("click", () => this._joinRoom());
    $("convLeaveBtn").addEventListener("click", () => this._leaveRoom());
    this._micBtn.addEventListener("click", () => this._toggleMic());
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
    this._ws.send({ type: "leave_room" });
    this._ws.close();
    this._roomCode = null;
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
      } catch (_) {
        this._setError("Mic access denied. Check browser permissions.");
      }
    }
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
      case "joined":
        this._roomCode = msg.code;
        this._codeDisplay.textContent = msg.code;
        this._pList.setAll(msg.participants);
        this._showRoomPanel();
        break;

      case "join_error":
        this._setError(msg.message);
        this._ws.close();
        break;

      case "participant_joined":
        this._pList.add(msg);
        break;

      case "participant_left":
        this._pList.remove(msg.id);
        break;

      case "speaker_translation":
        this._feed.push(msg.speaker_name, msg.original, msg.translation);
        this._tts.speak(msg.translation, msg.target_lang);
        break;

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
