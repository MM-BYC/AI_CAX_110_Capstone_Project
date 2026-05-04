// In production the frontend is served by FastAPI itself, so use a same-origin
// (relative) base. In local dev the static server runs on :3000 and needs to
// hit the backend on :8000 explicitly.
const API_BASE = (window.location.port === "3000" || window.location.protocol === "file:")
  ? "http://127.0.0.1:8000"
  : "";

document.getElementById("copyright").textContent = `© ${new Date().getFullYear()} AI-Translate. All rights reserved.`;

// Text tab elements
const textSourceLang = document.getElementById("textSourceLang");
const textTargetLang = document.getElementById("textTargetLang");
const inputText      = document.getElementById("inputText");
const outputBox      = document.getElementById("outputText");
const charCount      = document.getElementById("charCount");
const copyBtn        = document.getElementById("copyBtn");
const textSwapBtn    = document.getElementById("textSwapBtn");

// Audio tab elements
const audioSourceLang    = document.getElementById("audioSourceLang");
const audioTargetLang    = document.getElementById("audioTargetLang");
const audioFile          = document.getElementById("audioFile");
const dropZone           = document.getElementById("dropZone");
const dropFileName       = document.getElementById("dropFileName");
const audioPlayer        = document.getElementById("audioPlayer");
const audioTranscript    = document.getElementById("audioTranscript");
const audioOutputBox     = document.getElementById("audioOutputText");
const audioQualityBadge  = document.getElementById("audioQualityBadge");
const audioQualityCritique = document.getElementById("audioQualityCritique");
// audioDetectedLang element removed from HTML — not used
const audioCopyBtn       = document.getElementById("audioCopyBtn");

// Tab elements
const tabText  = document.getElementById("tabText");
const tabAudio = document.getElementById("tabAudio");
const tabLive  = document.getElementById("tabLive");
const tabConv  = document.getElementById("tabConv");
const textTab  = document.getElementById("textTab");
const audioTab = document.getElementById("audioTab");
const liveTab  = document.getElementById("liveTab");
const convTab  = document.getElementById("convTab");

// Live tab elements
const liveSourceLang        = document.getElementById("liveSourceLang");
const liveTargetLang        = document.getElementById("liveTargetLang");
const micBtn                = document.getElementById("micBtn");
const liveStatus            = document.getElementById("liveStatus");
const liveTranscript        = document.getElementById("liveTranscript");
const liveOutputText        = document.getElementById("liveOutputText");
const liveCopyBtn            = document.getElementById("liveCopyBtn");
const liveTranslationCopyBtn = document.getElementById("liveTranslationCopyBtn");
const liveResetBtn           = document.getElementById("liveResetBtn");

const spinner = document.getElementById("spinner");

// Language code → display name map
const LANG_NAMES = {
  en: "English", es: "Spanish", fr: "French", de: "German",
  it: "Italian", pt: "Portuguese", zh: "Chinese", ja: "Japanese",
  ko: "Korean", ar: "Arabic", ru: "Russian", hi: "Hindi",
  nl: "Dutch", pl: "Polish", tr: "Turkish", tl: "Tagalog"
};

// ── Block file drops everywhere except the audio drop zone ─────────────────
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => {
  if (!dropZone.contains(e.target)) e.preventDefault();
});

// ── Drop zone ──────────────────────────────────────────────────────────────
function showFileName(file) {
  dropFileName.textContent = file ? file.name : "MP3, WAV, M4A, OGG supported";
  dropFileName.classList.toggle("has-file", !!file);
}

dropZone.addEventListener("click", () => audioFile.click());

audioFile.addEventListener("change", () => {
  showFileName(audioFile.files[0]);
  translateAudio();
});

dropZone.addEventListener("dragover", e => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));

dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    audioFile.files = dt.files;
    showFileName(file);
    translateAudio();
  }
});

// ── Tab switching ───────────────────────────────────────────────────────────
function showTab(active) {
  [tabText, tabAudio, tabLive, tabConv].forEach(t => t.classList.remove("active"));
  [textTab, audioTab, liveTab, convTab].forEach(t => { t.style.display = "none"; });
  active.btn.classList.add("active");
  active.panel.style.display = "block";
  // Stop mics/camera if leaving live or conversation tabs
  if (active.btn !== tabLive && isListening) stopListening();
  if (active.btn !== tabConv && convIsListening) convStopListening();
  if (active.btn !== tabConv && convCamOn) convStopCamera();
}

tabText.addEventListener("click",  () => showTab({ btn: tabText,  panel: textTab }));
tabAudio.addEventListener("click", () => showTab({ btn: tabAudio, panel: audioTab }));
tabLive.addEventListener("click",  () => showTab({ btn: tabLive,  panel: liveTab }));
tabConv.addEventListener("click",  () => showTab({ btn: tabConv,  panel: convTab }));

// ── Language detection helper (Text tab only) ──────────────────────────────
let detectTimer = null;

async function detectAndShowLanguage(text) {
  if (!text.trim() || textSourceLang.value !== "auto") return;
  try {
    const res = await fetch(`${API_BASE}/detect_language?text=${encodeURIComponent(text)}`, { method: "POST" });
    if (!res.ok) return;
    const data = await res.json();
    updateDetectOption(textSourceLang, data.detected_language);
  } catch (_) {}
}

function updateDetectOption(selectEl, langCode) {
  const opt = selectEl.querySelector('option[value="auto"]');
  if (!opt) return;
  opt.textContent = langCode ? `Detected: ${LANG_NAMES[langCode] ?? langCode}` : "Detect Language";
}

function resetTextDetectOption() {
  updateDetectOption(textSourceLang, null);
}

function updateCharCount(len) {
  charCount.textContent = `${len} character${len !== 1 ? "s" : ""}`;
}

// ── Live translate ──────────────────────────────────────────────────────────
let translateTimer   = null;
let liveController   = null;
let typewriterTimer  = null;
let detectedLangCode = null;
let lastTranslation  = "";

async function liveTranslate(sourceOverride) {
  const text = inputText.value.trim();
  if (!text) { setOutput(""); return; }

  if (liveController) liveController.abort();
  liveController = new AbortController();

  showTypingIndicator();

  const sourceCode = sourceOverride ?? (textSourceLang.value === "auto" ? "en" : textSourceLang.value);

  try {
    const params = new URLSearchParams({ source: sourceCode, target: textTargetLang.value, text });

    const res = await fetch(`${API_BASE}/translate_text?${params.toString()}`, {
      method: "POST",
      signal: liveController.signal
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "Unknown error" }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const data = await res.json();
    detectedLangCode = data.detected_language;
    if (textSourceLang.value === "auto") updateDetectOption(textSourceLang, detectedLangCode);

    lastTranslation = data.translation;
    typewriterOutput(data.translation);
  } catch (err) {
    if (err.name === "AbortError") return;
    setOutput(`Error: ${err.message}`);
  }
}

function showTypingIndicator() {
  clearInterval(typewriterTimer);
  outputBox.innerHTML = '<span class="typing-indicator"><span></span><span></span><span></span></span>';
  copyBtn.style.display = "none";
}

function typewriterOutput(text) {
  clearInterval(typewriterTimer);
  outputBox.textContent = "";
  copyBtn.style.display = "none";
  let i = 0;
  typewriterTimer = setInterval(() => {
    if (i < text.length) {
      outputBox.textContent += text[i++];
    } else {
      clearInterval(typewriterTimer);
      copyBtn.style.display = "inline-block";
    }
  }, 18);
}

// ── Character counter + live detection ─────────────────────────────────────
inputText.addEventListener("input", () => {
  const len = inputText.value.length;
  updateCharCount(len);

  // When the field is cleared, reset source to auto so the next word typed
  // gets detected fresh — even if a previous swap had locked it to a language.
  if (len === 0 && textSourceLang.value !== "auto") {
    textSourceLang.value = "auto";
    resetTextDetectOption();
  }

  clearTimeout(detectTimer);
  if (len > 1 && textSourceLang.value === "auto") {
    detectTimer = setTimeout(() => detectAndShowLanguage(inputText.value), 50);
  } else if (len <= 1) {
    resetTextDetectOption();
  }

  clearTimeout(translateTimer);
  if (len > 0) {
    translateTimer = setTimeout(liveTranslate, 300);
  } else {
    setOutput("");
  }
});

textSourceLang.addEventListener("change", () => {
  if (textSourceLang.value !== "auto") resetTextDetectOption();
});

// ── Swap languages (Text tab) ───────────────────────────────────────────────
textSwapBtn.addEventListener("click", () => {
  const sav_detect_language       = textSourceLang.value === "auto" ? detectedLangCode : textSourceLang.value;
  if (!sav_detect_language) return;

  // Abort any in-flight request and stop the typewriter before reading state
  if (liveController) { liveController.abort(); liveController = null; }
  clearInterval(typewriterTimer);
  clearTimeout(translateTimer);

  const sav_enter_text_to_translate = inputText.value;
  const sav_target_language         = textTargetLang.value;
  const sav_translation             = lastTranslation;

  // Apply swap: each field receives its counterpart's saved value
  textSourceLang.value = sav_target_language;
  resetTextDetectOption();
  lastTranslation      = sav_enter_text_to_translate;
  inputText.value      = sav_translation;
  updateCharCount(sav_translation.length);
  textTargetLang.value = sav_detect_language;
  if (inputText.value.trim()) liveTranslate();
  else setOutput("");
});

// ── Re-translate when target language changes (Text tab) ───────────────────
textTargetLang.addEventListener("change", () => {
  if (inputText.value.trim()) liveTranslate();
});

// ── Audio translation ──────────────────────────────────────────────────────
async function translateAudio() {
  const file = audioFile.files[0];
  if (!file) return;

  showSpinner(true, "Transcribing audio with Whisper… this may take up to 60 seconds");

  try {
    const formData = new FormData();
    formData.append("file", file);

    const params = new URLSearchParams({
      source: audioSourceLang.value === "auto" ? "en" : audioSourceLang.value,
      target: audioTargetLang.value
    });

    const res = await fetch(`${API_BASE}/translate_audio?${params.toString()}`, {
      method: "POST",
      body: formData
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "Unknown error" }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const data = await res.json();
    if (audioSourceLang.value === "auto") updateDetectOption(audioSourceLang, data.detected_language);

    audioTranscript.value = "";

    const objectURL = URL.createObjectURL(file);
    audioPlayer.src = objectURL;
    audioPlayer.style.display = "block";

    const words = data.words || [];

    audioPlayer.ontimeupdate = () => {
      const t = audioPlayer.currentTime;
      const heard = words.filter(w => w.start <= t).map(w => w.word.trim()).join(" ");
      audioTranscript.value = heard;
      audioTranscript.scrollTop = audioTranscript.scrollHeight;
    };

    audioPlayer.play().catch(() => {});

    setAudioOutput(data.translation);
    setAudioQualityBadge(data.quality ?? null);
  } catch (err) {
    setAudioOutput(`Error: ${err.message}`);
    setAudioQualityBadge(null);
  } finally {
    showSpinner(false);
  }
}

// ── Copy buttons ───────────────────────────────────────────────────────────
copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(outputBox.textContent.trim()).then(() => {
    copyBtn.querySelector("span").textContent = "Copied!";
    setTimeout(() => { copyBtn.querySelector("span").textContent = "Copy"; }, 1500);
  });
});

// ── Re-translate transcription when target language changes (Audio tab) ────
audioTargetLang.addEventListener("change", async () => {
  const text = audioTranscript.value.trim();
  if (!text) return;

  setAudioQualityBadge(null);
  showSpinner(true);
  try {
    const params = new URLSearchParams({
      source: audioSourceLang.value === "auto" ? "en" : audioSourceLang.value,
      target: audioTargetLang.value,
      text
    });
    const res = await fetch(`${API_BASE}/translate_text?${params.toString()}`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setAudioOutput(data.translation);
  } catch (err) {
    setAudioOutput(`Error: ${err.message}`);
  } finally {
    showSpinner(false);
  }
});

audioCopyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(audioOutputBox.textContent.trim()).then(() => {
    audioCopyBtn.querySelector("span").textContent = "Copied!";
    setTimeout(() => { audioCopyBtn.querySelector("span").textContent = "Copy"; }, 1500);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────
function setOutput(translation) {
  if (translation) {
    lastTranslation = translation;
    outputBox.textContent = translation;
    copyBtn.style.display = "inline-block";
  } else {
    lastTranslation = "";
    outputBox.innerHTML = '<span class="placeholder">Translation will appear here...</span>';
    copyBtn.style.display = "none";
  }
}

function setAudioOutput(translation) {
  if (translation) {
    audioOutputBox.textContent = translation;
    audioCopyBtn.style.display = "inline-block";
  } else {
    audioOutputBox.innerHTML = '<span class="placeholder">Translation will appear here...</span>';
    audioCopyBtn.style.display = "none";
  }
}

function setAudioQualityBadge(quality) {
  if (!quality) {
    audioQualityBadge.style.display = "none";
    audioQualityCritique.style.display = "none";
    return;
  }
  audioQualityBadge.style.display = "inline-flex";
  audioQualityBadge.className = quality.passed ? "quality-badge passed" : "quality-badge flagged";
  audioQualityBadge.innerHTML = quality.passed
    ? '<i data-lucide="check-circle"></i> Passed'
    : '<i data-lucide="alert-triangle"></i> Flagged';
  lucide.createIcons({ nodes: [audioQualityBadge] });

  if (!quality.passed && quality.critique) {
    audioQualityCritique.textContent = quality.critique;
    audioQualityCritique.style.display = "block";
  } else {
    audioQualityCritique.style.display = "none";
  }
}

function showSpinner(visible, message = "Translating…") {
  spinner.style.display = visible ? "flex" : "none";
  if (visible) spinner.querySelector("p").textContent = message;
}

// ── Live Listen ─────────────────────────────────────────────────────────────
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const LANG_LOCALES = {
  en: "en-US", es: "es-ES", fr: "fr-FR", de: "de-DE",
  it: "it-IT", pt: "pt-BR", zh: "zh-CN", ja: "ja-JP",
  ko: "ko-KR", ar: "ar-SA", ru: "ru-RU", hi: "hi-IN",
  nl: "nl-NL", pl: "pl-PL", tr: "tr-TR", tl: "fil-PH",
};

let recognition    = null;
let isListening    = false;
let finalText      = "";
let liveXlateTimer = null;
let liveDetectTimer = null;
let liveDetectedLang = null;

function startListening() {
  if (!SpeechRecognition) {
    liveStatus.textContent = "Speech recognition not supported — use Chrome or Edge";
    return;
  }

  finalText = "";
  liveDetectedLang = null;
  liveTranscript.innerHTML = '<span class="placeholder">Listening…</span>';
  liveOutputText.innerHTML = '<span class="placeholder">Translation will appear here…</span>';
  liveCopyBtn.style.display = "none";
  liveTranslationCopyBtn.style.display = "none";

  recognition = new SpeechRecognition();
  recognition.continuous     = true;
  recognition.interimResults = true;
  recognition.lang           = LANG_LOCALES[liveSourceLang.value] || "en-US";

  recognition.onresult = e => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalText += e.results[i][0].transcript + " ";
        clearTimeout(liveXlateTimer);
        liveXlateTimer = setTimeout(() => translateLiveText(finalText.trim()), 400);
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    const fullText = (finalText + interim).trim();
    liveTranscript.innerHTML =
      (finalText || "") +
      (interim ? `<span class="interim">${interim}</span>` : "");
    liveCopyBtn.style.display = finalText.trim() ? "inline-block" : "none";
    if (fullText) {
      clearTimeout(liveDetectTimer);
      liveDetectTimer = setTimeout(() => detectLiveLanguage(fullText), 100);
      clearTimeout(liveXlateTimer);
      liveXlateTimer = setTimeout(() => translateLiveText(fullText), 50);
    }
  };

  // Auto-restart so recognition doesn't silently stop mid-session
  recognition.onend = () => { if (isListening) recognition.start(); };

  recognition.onerror = e => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      stopListening();
      liveStatus.textContent = "Microphone blocked — see instructions below";
      alert(
        "Microphone access was denied.\n\n" +
        "To fix:\n" +
        "1. Click the lock (or ⓘ) icon in the address bar.\n" +
        "2. Set Microphone to Allow.\n" +
        "3. Reload the page and try again.\n\n" +
        "If on macOS, also check System Settings → Privacy & Security → Microphone."
      );
    } else if (e.error !== "no-speech") {
      liveStatus.textContent = `Microphone error: ${e.error}`;
    }
  };

  recognition.start();
  isListening = true;
  micBtn.classList.add("active");
  liveStatus.textContent = "Listening…";
}

function stopListening() {
  isListening = false;
  if (recognition) { recognition.stop(); recognition = null; }
  micBtn.classList.remove("active");
  liveStatus.textContent = "Click the mic to start listening";
  clearTimeout(liveDetectTimer);
}

micBtn.addEventListener("click", () => {
  isListening ? stopListening() : startListening();
});

liveResetBtn.addEventListener("click", () => {
  stopListening();
  finalText = "";
  liveDetectedLang = null;
  clearTimeout(liveXlateTimer);
  clearTimeout(liveDetectTimer);
  liveTranscript.innerHTML = '<span class="placeholder">Your speech will appear here…</span>';
  liveOutputText.innerHTML = '<span class="placeholder">Translation will appear here…</span>';
  liveCopyBtn.style.display = "none";
  liveTranslationCopyBtn.style.display = "none";
  liveStatus.textContent = "Click the mic to start listening";
});

async function detectLiveLanguage(text) {
  if (!text.trim() || text.length < 3) return;
  try {
    const res = await fetch(`${API_BASE}/detect_language?text=${encodeURIComponent(text)}`, { method: "POST" });
    if (!res.ok) return;
    const data = await res.json();
    const detected = data.detected_language;
    if (detected && detected !== liveDetectedLang) {
      liveDetectedLang = detected;
      liveSourceLang.value = detected;
    }
  } catch (_) {}
}

async function translateLiveText(text) {
  if (!text.trim()) return;
  try {
    const params = new URLSearchParams({
      source: liveSourceLang.value,
      target: liveTargetLang.value,
      text,
    });
    const res = await fetch(`${API_BASE}/translate_text?${params}`, { method: "POST" });
    if (!res.ok) return;
    const data = await res.json();
    liveOutputText.textContent = data.translation;
    liveTranslationCopyBtn.style.display = "inline-block";
  } catch (_) {}
}

// Restart recognition with new language if changed mid-session
liveSourceLang.addEventListener("change", () => {
  if (isListening) { stopListening(); startListening(); }
});

// Re-translate existing transcript when target language changes
liveTargetLang.addEventListener("change", () => {
  if (finalText.trim()) translateLiveText(finalText.trim());
});

liveCopyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(liveTranscript.textContent.trim()).then(() => {
    liveCopyBtn.querySelector("span").textContent = "Copied!";
    setTimeout(() => { liveCopyBtn.querySelector("span").textContent = "Copy"; }, 1500);
  });
});

liveTranslationCopyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(liveOutputText.textContent.trim()).then(() => {
    liveTranslationCopyBtn.querySelector("span").textContent = "Copied!";
    setTimeout(() => { liveTranslationCopyBtn.querySelector("span").textContent = "Copy"; }, 1500);
  });
});

// ── Live Conversation (multi-user) ────────────────────────────────────────
let convWs           = null;
let convRoomId       = null;
let convUserId       = null;   // this session's user_id assigned by server
let convIsHost       = false;
let convUsers        = {};     // user_id → {name, language, is_host, mic_on, camera_on}
let convIsListening  = false;
let convRecognition  = null;
let convXlateTimer   = null;
let convFinalText    = "";
let convInterimTimer = null;
let convCamStream    = null;
let convCamOn        = false;
let _convReconnectAttempts = 0;
const _CONV_MAX_RECONNECTS = 3;

const convSetup          = document.getElementById("convSetup");
const convActive         = document.getElementById("convActive");
const convNameInput      = document.getElementById("convName");
const convLangSelect     = document.getElementById("convLang");
const convCreateBtn      = document.getElementById("convCreateBtn");
const convJoinBtn        = document.getElementById("convJoinBtn");
const convRoomInput      = document.getElementById("convRoomInput");
const convRoomCode       = document.getElementById("convRoomCode");
const convCopyCodeBtn    = document.getElementById("convCopyCodeBtn");
const convLeaveBtn       = document.getElementById("convLeaveBtn");
const convParticipantsBar = document.getElementById("convParticipantsBar");
const convMessages       = document.getElementById("convMessages");
const convMicBtn         = document.getElementById("convMicBtn");
const convMicLabel       = document.getElementById("convMicLabel");
const convCamBtn         = document.getElementById("convCamBtn");
const convCamLabel       = document.getElementById("convCamLabel");
const convCamPreview     = document.getElementById("convCamPreview");
const convCamVideo       = document.getElementById("convCamVideo");

function convShowScreen(screen) {
  convSetup.style.display  = "none";
  convActive.style.display = "none";
  screen.style.display     = "block";
}

function convGetWsBase() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host  = (window.location.port === "3000" || window.location.protocol === "file:")
    ? "127.0.0.1:8000"
    : window.location.host;
  return `${proto}//${host}`;
}

// ── Participant chip rendering ─────────────────────────────────────────────
function convRenderParticipants() {
  convParticipantsBar.innerHTML = "";
  Object.entries(convUsers).forEach(([uid, user]) => {
    const isMe = uid === convUserId;

    const chip = document.createElement("div");
    chip.className = "conv-participant-chip" + (isMe ? " me" : "");
    chip.id = `conv-chip-${uid}`;

    const avatar = document.createElement("div");
    avatar.className = "conv-participant-avatar-sm";
    avatar.textContent = user.name[0].toUpperCase();

    const info = document.createElement("div");
    info.className = "conv-participant-chip-info";

    const nameEl = document.createElement("div");
    nameEl.className = "conv-participant-chip-name";
    nameEl.textContent = user.name + (isMe ? " (You)" : "");

    const langEl = document.createElement("div");
    langEl.className = "conv-participant-chip-lang";
    langEl.textContent = LANG_NAMES[user.language] || user.language;

    info.appendChild(nameEl);
    info.appendChild(langEl);
    chip.appendChild(avatar);
    chip.appendChild(info);

    if (user.is_host) {
      const badge = document.createElement("span");
      badge.className = "conv-host-badge";
      badge.textContent = "Host";
      chip.appendChild(badge);
    }

    // Mic status dot (round, red when on)
    const micEl = document.createElement("div");
    micEl.className = "conv-participant-mic-dot" + (user.mic_on ? " on" : "");
    micEl.id = `conv-mic-dot-${uid}`;
    chip.appendChild(micEl);

    // Camera status dot (square-ish, green when on)
    const camEl = document.createElement("div");
    camEl.className = "conv-participant-cam-dot" + (user.camera_on ? " on" : "");
    camEl.id = `conv-cam-dot-${uid}`;
    chip.appendChild(camEl);

    convParticipantsBar.appendChild(chip);
  });
}

function convUpdateChipMic(userId, isOn) {
  const chip = document.getElementById(`conv-chip-${userId}`);
  if (chip) chip.classList.toggle("speaking", isOn);
  const dot = document.getElementById(`conv-mic-dot-${userId}`);
  if (dot) dot.className = "conv-participant-mic-dot" + (isOn ? " on" : "");
}

function convUpdateChipCam(userId, isOn) {
  const dot = document.getElementById(`conv-cam-dot-${userId}`);
  if (dot) dot.className = "conv-participant-cam-dot" + (isOn ? " on" : "");
}

// ── Message rendering ──────────────────────────────────────────────────────
function convAddMessage(msg) {
  convClearInterim();

  const bubble = document.createElement("div");
  bubble.className = `conv-bubble ${msg.is_self ? "self" : "partner"}`;

  const nameEl = document.createElement("div");
  nameEl.className = "conv-bubble-name";
  nameEl.textContent = msg.from;

  const mainEl = document.createElement("div");
  mainEl.className = "conv-bubble-main";
  mainEl.textContent = msg.is_self ? msg.original : msg.translation;

  const subEl = document.createElement("div");
  subEl.className = "conv-bubble-sub";
  subEl.textContent = msg.is_self ? `→ ${msg.translation}` : `Original: ${msg.original}`;

  bubble.appendChild(nameEl);
  bubble.appendChild(mainEl);
  bubble.appendChild(subEl);

  convMessages.querySelector(".conv-start-hint")?.remove();
  convMessages.appendChild(bubble);
  convMessages.scrollTop = convMessages.scrollHeight;
}

function convShowInterim(fromId, fromName, text) {
  let el = convMessages.querySelector(".conv-interim");
  if (!el) {
    el = document.createElement("div");
    el.className = "conv-interim";
    convMessages.appendChild(el);
  }
  el.textContent = `${fromName}: ${text}…`;
  convMessages.scrollTop = convMessages.scrollHeight;
  const dot = document.getElementById(`conv-mic-dot-${fromId}`);
  if (dot) dot.classList.add("pulsing");
}

function convClearInterim() {
  convMessages.querySelector(".conv-interim")?.remove();
  document.querySelectorAll(".conv-participant-mic-dot.pulsing")
    .forEach(d => d.classList.remove("pulsing"));
}

function convAddSystemMsg(text) {
  const el = document.createElement("div");
  el.className = "conv-system-msg";
  el.textContent = text;
  convMessages.appendChild(el);
  convMessages.scrollTop = convMessages.scrollHeight;
}

// ── Mic UI ─────────────────────────────────────────────────────────────────
function convSetMicUI(isOn) {
  convMicBtn.classList.toggle("active", isOn);
  convMicBtn.innerHTML = isOn
    ? '<i data-lucide="mic"></i>'
    : '<i data-lucide="mic-off"></i>';
  convMicLabel.textContent = isOn ? "Mic on — tap to mute" : "Tap to speak";
  lucide.createIcons({ nodes: [convMicBtn] });
  if (convUserId && convUsers[convUserId]) {
    convUsers[convUserId].mic_on = isOn;
    convUpdateChipMic(convUserId, isOn);
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────
async function convConnect(roomId) {
  convRoomId = roomId;
  const name = convNameInput.value.trim();
  const lang = convLangSelect.value;

  const wsUrl = `${convGetWsBase()}/ws/conversation/${roomId}`;
  convWs = new WebSocket(wsUrl);

  convWs.onopen = () => {
    _convReconnectAttempts = 0;
    convWs.send(JSON.stringify({ type: "join", name, language: lang }));
  };

  convWs.onmessage = e => {
    convHandleMessage(JSON.parse(e.data));
  };

  convWs.onclose = event => {
    if (event.code !== 1000 && convUserId) {
      if (_convReconnectAttempts < _CONV_MAX_RECONNECTS) {
        _convReconnectAttempts++;
        convAddSystemMsg(`Connection lost. Reconnecting…`);
        setTimeout(() => convConnect(roomId), _convReconnectAttempts * 2000);
      } else {
        convHandleDisconnect("Connection lost. Please rejoin.");
      }
    } else if (convUserId) {
      convHandleDisconnect();
    } else {
      convCreateBtn.disabled = false;
      convCreateBtn.querySelector("span").textContent = "Create Room";
      if (event.code !== 1000) alert("Could not connect to server. Please try again.");
    }
  };

  convWs.onerror = err => console.error("[Conv] WS error:", err);
}

function convHandleMessage(msg) {
  switch (msg.type) {

    case "joined":
      convUserId = msg.user_id;
      convIsHost = msg.is_host;
      convRoomCode.textContent = msg.room;
      convUsers = {};
      msg.users.forEach(u => {
        convUsers[u.user_id] = {
          name: u.name, language: u.language,
          is_host: u.is_host, mic_on: u.mic_on || false,
        };
      });
      convRenderParticipants();
      convShowScreen(convActive);
      break;

    case "user_joined":
      convUsers[msg.user.user_id] = {
        name: msg.user.name, language: msg.user.language,
        is_host: msg.user.is_host, mic_on: false,
      };
      convRenderParticipants();
      convAddSystemMsg(`${msg.user.name} joined the room.`);
      webrtcOnUserJoined(msg.user.user_id);
      break;

    case "user_left":
      webrtcOnUserLeft(msg.user_id);
      delete convUsers[msg.user_id];
      convRenderParticipants();
      convAddSystemMsg(`${msg.name} left the room.`);
      break;

    case "webrtc_offer":  rtcHandleOffer(msg.from_id, msg.sdp);  break;
    case "webrtc_answer": rtcHandleAnswer(msg.from_id, msg.sdp); break;
    case "webrtc_ice":    rtcHandleIce(msg.from_id, msg.candidate); break;

    case "host_changed":
      if (msg.new_host_id === convUserId) {
        convIsHost = true;
        if (convUsers[convUserId]) convUsers[convUserId].is_host = true;
        convRenderParticipants();
        convAddSystemMsg("You are now the host.");
      }
      break;

    case "message":
      convAddMessage(msg);
      break;

    case "interim":
      convShowInterim(msg.from_id, msg.from, msg.text);
      break;

    case "user_mic_status":
      if (convUsers[msg.user_id]) convUsers[msg.user_id].mic_on = msg.is_on;
      convUpdateChipMic(msg.user_id, msg.is_on);
      break;

    case "user_camera_status":
      if (convUsers[msg.user_id]) convUsers[msg.user_id].camera_on = msg.is_on;
      convUpdateChipCam(msg.user_id, msg.is_on);
      break;

    case "error":
      alert(msg.message || "Could not join room.");
      convReset();
      break;
  }
}

// ── Mic start / stop ───────────────────────────────────────────────────────
async function convStartListening() {
  if (!SpeechRecognition) {
    alert("Speech recognition is not supported — please use Chrome or Edge.");
    return;
  }

  // Microphone requires a secure context (HTTPS or localhost).
  if (!window.isSecureContext) {
    alert(
      "Microphone access requires a secure connection.\n\n" +
      "Open this app via HTTPS or http://localhost instead of a plain HTTP address."
    );
    return;
  }

  const myInfo = convUsers[convUserId];
  if (!myInfo) return;

  // Check permission state before starting so we can give specific guidance.
  if (navigator.permissions) {
    try {
      const perm = await navigator.permissions.query({ name: "microphone" });
      if (perm.state === "denied") {
        alert(
          "Microphone is blocked for this site.\n\n" +
          "To unblock it:\n" +
          "1. Click the lock (or ⓘ) icon in your browser's address bar.\n" +
          "2. Set Microphone to Allow.\n" +
          "3. Reload the page and try again."
        );
        return;
      }
    } catch (_) { /* Permissions API unavailable — proceed and let onerror handle it */ }
  }

  convFinalText = "";
  convRecognition = new SpeechRecognition();
  convRecognition.continuous     = true;
  convRecognition.interimResults = true;
  convRecognition.lang           = LANG_LOCALES[myInfo.language] || "en-US";

  convRecognition.onresult = e => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        convFinalText += e.results[i][0].transcript + " ";
        clearTimeout(convXlateTimer);
        convXlateTimer = setTimeout(() => {
          const text = convFinalText.trim();
          if (text && convWs?.readyState === WebSocket.OPEN) {
            convWs.send(JSON.stringify({ type: "speech", text, is_final: true }));
            convFinalText = "";
          }
        }, 300);
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    if (interim && convWs?.readyState === WebSocket.OPEN) {
      clearTimeout(convInterimTimer);
      convInterimTimer = setTimeout(() => {
        convWs.send(JSON.stringify({ type: "interim", text: interim }));
      }, 100);
    }
  };

  convRecognition.onend = () => { if (convIsListening) convRecognition.start(); };

  convRecognition.onerror = e => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      convStopListening();
      alert(
        "Microphone access was denied.\n\n" +
        "To fix:\n" +
        "1. Click the lock (or ⓘ) icon in the address bar.\n" +
        "2. Set Microphone to Allow.\n" +
        "3. Reload the page and try again.\n\n" +
        "If on macOS, also check System Settings → Privacy & Security → Microphone."
      );
    }
  };

  convRecognition.start();
  convIsListening = true;
  convWs?.readyState === WebSocket.OPEN &&
    convWs.send(JSON.stringify({ type: "mic_status", is_on: true }));
  convSetMicUI(true);
  webrtcStartAudio();
}

function convStopListening() {
  convIsListening = false;
  if (convRecognition) { convRecognition.stop(); convRecognition = null; }
  convWs?.readyState === WebSocket.OPEN &&
    convWs.send(JSON.stringify({ type: "mic_status", is_on: false }));
  convSetMicUI(false);
  webrtcStopAudio();
}

convMicBtn.addEventListener("click", () => {
  convIsListening ? convStopListening() : convStartListening();
});

// ── Camera start / stop ────────────────────────────────────────────────────
async function convStartCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert("Camera is not supported in this browser.");
    return;
  }
  if (!window.isSecureContext) {
    alert(
      "Camera access requires a secure connection.\n\n" +
      "Open this app via HTTPS or http://localhost."
    );
    return;
  }

  if (navigator.permissions) {
    try {
      const perm = await navigator.permissions.query({ name: "camera" });
      if (perm.state === "denied") {
        alert(
          "Camera is blocked for this site.\n\n" +
          "To unblock it:\n" +
          "1. Click the lock (or ⓘ) icon in the address bar.\n" +
          "2. Set Camera to Allow.\n" +
          "3. Reload the page and try again."
        );
        return;
      }
    } catch (_) {}
  }

  // Confirm a video input device is actually present before requesting access.
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hasCamera = devices.some(d => d.kind === "videoinput");
    if (!hasCamera) {
      alert("No camera detected on this device. Please connect a camera and try again.");
      return;
    }
  } catch (_) {}

  // Try to open the camera. If the browser rejects the boolean shorthand
  // (`video: true`) with a constraint error, retry with an empty constraints
  // object — both are spec-equivalent but some engines handle them differently.
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  } catch (err) {
    const n = err.name;
    if (n === "NotAllowedError" || n === "PermissionDeniedError") {
      alert(
        "Camera access was denied.\n\n" +
        "To fix:\n" +
        "1. Click the lock (or ⓘ) icon in the address bar.\n" +
        "2. Set Camera to Allow.\n" +
        "3. Reload the page and try again.\n\n" +
        "If on macOS, also check System Settings → Privacy & Security → Camera."
      );
      return;
    }
    if (n === "NotReadableError" || n === "TrackStartError") {
      alert("Camera is already in use by another application. Close it and try again.");
      return;
    }
    if (n === "NotFoundError" || n === "DevicesNotFoundError") {
      alert("No camera found. Please connect a camera and try again.");
      return;
    }
    // Constraint / overconstrained / unknown — retry with minimal constraints.
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: {}, audio: false });
    } catch (_) {
      alert("Could not open camera. Make sure no other app is using it, then try again.");
      return;
    }
  }

  convCamStream = stream;
  convCamVideo.srcObject = stream;
  convCamPreview.style.display = "flex";
  convCamOn = true;
  convSetCamUI(true);
  convWs?.readyState === WebSocket.OPEN &&
    convWs.send(JSON.stringify({ type: "camera_status", is_on: true }));
  webrtcStartVideo(stream);
}

function convStopCamera() {
  if (convCamStream) {
    convCamStream.getTracks().forEach(t => t.stop());
    convCamStream = null;
  }
  convCamVideo.srcObject = null;
  convCamPreview.style.display = "none";
  convCamOn = false;
  convSetCamUI(false);
  convWs?.readyState === WebSocket.OPEN &&
    convWs.send(JSON.stringify({ type: "camera_status", is_on: false }));
  webrtcStopVideo();
}

function convSetCamUI(isOn) {
  convCamBtn.classList.toggle("active", isOn);
  convCamBtn.innerHTML = isOn
    ? '<i data-lucide="video"></i>'
    : '<i data-lucide="video-off"></i>';
  convCamLabel.textContent = isOn ? "Camera on — tap to stop" : "Tap for camera";
  lucide.createIcons({ nodes: [convCamBtn] });
  if (convUserId && convUsers[convUserId]) {
    convUsers[convUserId].camera_on = isOn;
    convUpdateChipCam(convUserId, isOn);
  }
}

convCamBtn.addEventListener("click", () => {
  convCamOn ? convStopCamera() : convStartCamera();
});

// ── Reset / disconnect ─────────────────────────────────────────────────────
function convHandleDisconnect(reason) {
  if (convWs) { convWs.onclose = null; convWs.onerror = null; convWs = null; }
  convStopListening();
  if (reason) alert(reason + "\nReturning to setup.");
  convReset();
}

function convReset() {
  webrtcCloseAll();
  convStopListening();
  convStopCamera();
  if (convWs) { convWs.close(); convWs = null; }
  convRoomId  = null;
  convUserId  = null;
  convIsHost  = false;
  convUsers   = {};
  convMessages.innerHTML = '<div class="conv-start-hint">Press your mic to start speaking</div>';
  convRoomCode.textContent = "------";
  convShowScreen(convSetup);
  convCreateBtn.disabled = false;
  convCreateBtn.querySelector("span").textContent = "Create Room";
}

// ── Create / Join buttons ──────────────────────────────────────────────────
convCreateBtn.addEventListener("click", async () => {
  const name = convNameInput.value.trim();
  if (!name) { convNameInput.focus(); return; }

  convCreateBtn.disabled = true;
  convCreateBtn.querySelector("span").textContent = "Connecting…";

  try {
    const res = await fetch(`${API_BASE}/create_room`);
    if (!res.ok) {
      convCreateBtn.disabled = false;
      convCreateBtn.querySelector("span").textContent = "Create Room";
      alert(`Backend error (${res.status}). Is the server running?`);
      return;
    }
    const data = await res.json();
    if (!data.room_id) {
      convCreateBtn.disabled = false;
      convCreateBtn.querySelector("span").textContent = "Create Room";
      alert("Invalid response from server.");
      return;
    }
    await convConnect(data.room_id);
  } catch (e) {
    convCreateBtn.disabled = false;
    convCreateBtn.querySelector("span").textContent = "Create Room";
    alert(`Failed to create room: ${e.message}`);
  }
});

convJoinBtn.addEventListener("click", () => {
  const roomId = convRoomInput.value.trim().toUpperCase();
  if (!roomId) { convRoomInput.focus(); return; }
  const name   = convNameInput.value.trim();
  if (!name)   { convNameInput.focus(); return; }
  convConnect(roomId);
});

convRoomInput.addEventListener("keydown", e => { if (e.key === "Enter") convJoinBtn.click(); });
convNameInput.addEventListener("keydown", e => { if (e.key === "Enter") convCreateBtn.click(); });

convLeaveBtn.addEventListener("click", () => convReset());

convCopyCodeBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(convRoomCode.textContent).then(() => {
    convCopyCodeBtn.title = "Copied!";
    setTimeout(() => { convCopyCodeBtn.title = "Copy room code"; }, 1500);
  });
});

const convInviteBtn = document.getElementById("convInviteBtn");
convInviteBtn.addEventListener("click", () => {
  const code = convRoomCode.textContent.trim();
  const url  = window.location.origin + window.location.pathname;
  const text = `You're invited to a live AI Translate conversation!\n\nRoom Code: ${code}\nOpen the app: ${url}\n\nEnter the room code after clicking "Join".`;

  if (navigator.share) {
    navigator.share({ title: "Join my AI Translate room", text }).catch(() => {});
  } else {
    navigator.clipboard.writeText(text).then(() => {
      convInviteBtn.querySelector("span").textContent = "Copied!";
      setTimeout(() => { convInviteBtn.querySelector("span").textContent = "Invite"; }, 2000);
    });
  }
});

// ── Keyboard Input Module ──────────────────────────────────────────────────
const convKeyboardInput = document.getElementById("convKeyboardInput");
const convKeyboardSend  = document.getElementById("convKeyboardSend");

function convSendKeyboard() {
  const text = convKeyboardInput.value.trim();
  if (!text || convWs?.readyState !== WebSocket.OPEN) return;
  convWs.send(JSON.stringify({ type: "keyboard", text }));
  convKeyboardInput.value = "";
  convKeyboardSend.disabled = false;
}

convKeyboardSend.addEventListener("click", convSendKeyboard);

convKeyboardInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    convSendKeyboard();
  }
});

// ── WebRTC Module ─────────────────────────────────────────────────────────
const WEBRTC_ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const convVideoGrid = document.getElementById("convVideoGrid");

let rtcPeers        = {};   // userId → RTCPeerConnection
let rtcAudioTrack   = null; // local mic audio track (for WebRTC)
let rtcVideoTrack   = null; // local camera video track (for WebRTC)
let rtcAudioContext = null; // created on user click so it's always activated
let rtcAudioSources = {};   // userId → AudioContext source node

function rtcLocalTracks() {
  return [rtcAudioTrack, rtcVideoTrack].filter(Boolean);
}

function rtcCreatePeer(userId, isOffer) {
  if (rtcPeers[userId]) return rtcPeers[userId];

  const pc = new RTCPeerConnection({ iceServers: WEBRTC_ICE });
  rtcPeers[userId] = pc;

  rtcLocalTracks().forEach(t => pc.addTrack(t));

  pc.ontrack = ({ track, streams }) => {
    if (track.kind === "video") rtcShowRemoteVideo(userId, track);
    else rtcPlayRemoteAudio(userId, track);
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate && convWs?.readyState === WebSocket.OPEN) {
      convWs.send(JSON.stringify({
        type: "webrtc_ice", target_id: userId,
        candidate: candidate.toJSON(),
      }));
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") {
      rtcRemoveRemote(userId);
      pc.close();
      delete rtcPeers[userId];
    }
  };

  if (isOffer) rtcNegotiate(userId, pc);
  return pc;
}

async function rtcNegotiate(userId, pc) {
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    convWs?.readyState === WebSocket.OPEN && convWs.send(JSON.stringify({
      type: "webrtc_offer", target_id: userId,
      sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
    }));
  } catch (e) { console.error("[WebRTC] negotiate:", e); }
}

async function rtcHandleOffer(fromId, sdp) {
  let pc = rtcPeers[fromId];
  if (!pc) pc = rtcCreatePeer(fromId, false);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    convWs?.readyState === WebSocket.OPEN && convWs.send(JSON.stringify({
      type: "webrtc_answer", target_id: fromId,
      sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
    }));
  } catch (e) { console.error("[WebRTC] handle offer:", e); }
}

async function rtcHandleAnswer(fromId, sdp) {
  try {
    await rtcPeers[fromId]?.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (e) { console.error("[WebRTC] handle answer:", e); }
}

async function rtcHandleIce(fromId, candidate) {
  if (!candidate || !rtcPeers[fromId]) return;
  try {
    await rtcPeers[fromId].addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) { console.error("[WebRTC] ICE:", e); }
}

function rtcShowRemoteVideo(userId, track) {
  let tile = document.getElementById(`conv-remote-${userId}`);
  if (tile) {
    const vid = tile.querySelector("video");
    if (!vid.srcObject) {
      vid.srcObject = new MediaStream([track]);
      vid.play().catch(() => {});
    } else if (!vid.srcObject.getVideoTracks().length) {
      vid.srcObject.addTrack(track);
    }
    return;
  }

  tile = document.createElement("div");
  tile.className = "conv-remote-tile";
  tile.id = `conv-remote-${userId}`;

  const vid = document.createElement("video");
  vid.autoplay    = true;
  vid.playsInline = true;
  vid.muted       = true;   // muted = guaranteed autoplay; audio handled separately
  vid.srcObject   = new MediaStream([track]);

  const label = document.createElement("div");
  label.className = "conv-remote-tile-name";
  label.textContent = convUsers[userId]?.name || "Participant";

  tile.appendChild(vid);
  tile.appendChild(label);
  convVideoGrid.appendChild(tile);
  vid.play().catch(() => {});
}

function rtcPlayRemoteAudio(userId, track) {
  // Lazy-create AudioContext on first remote audio arrival — by this point the
  // user has clicked Join/Create and the page is activated, so resume() works.
  if (!rtcAudioContext) rtcAudioContext = new AudioContext();
  if (rtcAudioContext.state === "suspended") rtcAudioContext.resume();
  rtcAudioSources[userId]?.disconnect();
  const source = rtcAudioContext.createMediaStreamSource(new MediaStream([track]));
  source.connect(rtcAudioContext.destination);
  rtcAudioSources[userId] = source;
}

function rtcRemoveRemote(userId) {
  document.getElementById(`conv-remote-${userId}`)?.remove();
  rtcAudioSources[userId]?.disconnect();
  delete rtcAudioSources[userId];
}

async function webrtcStartAudio() {
  if (rtcAudioTrack) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    rtcAudioTrack = s.getAudioTracks()[0];
    // Add to existing peers
    for (const [uid, pc] of Object.entries(rtcPeers)) {
      if (!pc.getSenders().some(s => s.track?.kind === "audio")) {
        pc.addTrack(rtcAudioTrack);
        rtcNegotiate(uid, pc);
      }
    }
    // Open connections to peers not yet connected
    Object.keys(convUsers).filter(uid => uid !== convUserId && !rtcPeers[uid])
      .forEach(uid => rtcCreatePeer(uid, true));
  } catch (e) { console.error("[WebRTC] audio start:", e); }
}

function webrtcStopAudio() {
  if (!rtcAudioTrack) return;
  rtcAudioTrack.stop();
  rtcAudioTrack = null;
  for (const [uid, pc] of Object.entries(rtcPeers)) {
    pc.getSenders().filter(s => s.track?.kind === "audio").forEach(s => pc.removeTrack(s));
    rtcNegotiate(uid, pc);
  }
}

function webrtcStartVideo(stream) {
  const vt = stream.getVideoTracks()[0];
  if (!vt) return;
  rtcVideoTrack = vt;
  for (const [uid, pc] of Object.entries(rtcPeers)) {
    const sender = pc.getSenders().find(s => s.track?.kind === "video");
    if (sender) { sender.replaceTrack(vt); }
    else { pc.addTrack(vt); rtcNegotiate(uid, pc); }
  }
  Object.keys(convUsers).filter(uid => uid !== convUserId && !rtcPeers[uid])
    .forEach(uid => rtcCreatePeer(uid, true));
}

function webrtcStopVideo() {
  rtcVideoTrack = null;
  for (const [uid, pc] of Object.entries(rtcPeers)) {
    pc.getSenders().filter(s => s.track?.kind === "video").forEach(s => pc.removeTrack(s));
    rtcNegotiate(uid, pc);
  }
}

function webrtcOnUserJoined(userId) {
  if (rtcAudioTrack || rtcVideoTrack) rtcCreatePeer(userId, true);
}

function webrtcOnUserLeft(userId) {
  rtcPeers[userId]?.close();
  delete rtcPeers[userId];
  rtcRemoveRemote(userId);
}

function webrtcCloseAll() {
  Object.keys(rtcPeers).forEach(uid => {
    rtcPeers[uid].close();
    rtcRemoveRemote(uid);
  });
  rtcPeers = {};
  rtcAudioTrack?.stop();
  rtcAudioTrack = null;
  rtcVideoTrack = null;
  rtcAudioSources = {};
  convVideoGrid.innerHTML = "";
}
