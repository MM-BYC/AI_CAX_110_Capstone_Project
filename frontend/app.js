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
  // Stop mics if leaving live or conversation tabs
  if (active.btn !== tabLive && isListening) stopListening();
  if (active.btn !== tabConv && convIsListening) convStopListening();
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
    if (e.error === "not-allowed") {
      liveStatus.textContent = "Microphone access denied — check browser permissions";
    } else if (e.error !== "no-speech") {
      liveStatus.textContent = `Error: ${e.error}`;
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
      if (isListening) {
        stopListening();
        startListening();
      }
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

// ── Live Conversation ──────────────────────────────────────────────────────
let convWs = null;
let convPosition = -1;
let convUsers = [null, null];
let convRecognition = null;
let convIsListening = false;
let convXlateTimer = null;
let convFinalText = "";
let convInterimTimer = null;

const convSetup = document.getElementById("convSetup");
const convWaiting = document.getElementById("convWaiting");
const convActive = document.getElementById("convActive");
const convNameInput = document.getElementById("convName");
const convLangSelect = document.getElementById("convLang");
const convCreateBtn = document.getElementById("convCreateBtn");
const convJoinBtn = document.getElementById("convJoinBtn");
const convRoomInput = document.getElementById("convRoomInput");
const convCancelBtn = document.getElementById("convCancelBtn");
const convRoomCode = document.getElementById("convRoomCode");
const convMessages = document.getElementById("convMessages");
const convMicBtn0 = document.getElementById("convMicBtn0");
const convMicBtn1 = document.getElementById("convMicBtn1");
const convMicLabel0 = document.getElementById("convMicLabel0");
const convMicLabel1 = document.getElementById("convMicLabel1");
const convUserName0 = document.getElementById("convUserName0");
const convUserName1 = document.getElementById("convUserName1");
const convUserLang0 = document.getElementById("convUserLang0");
const convUserLang1 = document.getElementById("convUserLang1");
const convAvatar0 = document.getElementById("convAvatar0");
const convAvatar1 = document.getElementById("convAvatar1");

function convShowScreen(screen) {
  convSetup.style.display = "none";
  convWaiting.style.display = "none";
  convActive.style.display = "none";
  screen.style.display = "block";
}

function convGetWsBase() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = (window.location.port === "3000" || window.location.protocol === "file:")
    ? "127.0.0.1:8000"
    : window.location.host;
  return `${proto}//${host}`;
}

function convIsLocalDev() {
  return window.location.port === "3000" || window.location.protocol === "file:";
}

async function convConnect(roomId) {
  const name = convNameInput.value.trim();
  const lang = convLangSelect.value;

  if (!name) {
    alert("Please enter your name.");
    return;
  }

  const wsUrl = `${convGetWsBase()}/ws/conversation/${roomId}`;
  convWs = new WebSocket(wsUrl);

  convWs.onopen = () => {
    console.log("[Conv] WebSocket connected, sending join message");
    convWs.send(JSON.stringify({ type: "join", name, language: lang }));
  };

  convWs.onmessage = e => {
    console.log("[Conv] Received:", e.data);
    const msg = JSON.parse(e.data);
    convHandleMessage(msg);
  };

  convWs.onclose = (event) => {
    console.log("[Conv] WebSocket closed", event);
    // Only show error if it was an unexpected close (code != 1000)
    if (event.code !== 1000 && convPosition >= 0) {
      convHandleDisconnect("Connection closed unexpectedly");
    } else if (convPosition >= 0) {
      convHandleDisconnect();
    }
  };

  convWs.onerror = (err) => {
    console.error("[Conv] WebSocket error:", err);
    const isProduction = !convIsLocalDev();
    const errorMsg = isProduction
      ? `WebSocket not supported on this server.\n\nThe Conversation feature works best on local development:\n\ncd backend && ./startback.sh\ncd frontend && ./startfront.sh\n\nThen open: http://localhost:3000`
      : `WebSocket connection failed.\n\nMake sure backend is running:\ncd backend && ./startback.sh`;
    convHandleDisconnect(errorMsg);
  };
}

function convHandleMessage(msg) {
  switch (msg.type) {
    case "joined":
      convPosition = msg.position;
      convRoomCode.textContent = msg.room;
      convShowScreen(convWaiting);
      break;

    case "error":
      alert(msg.message || "Could not join room.");
      convReset();
      break;

    case "paired":
      convUsers = msg.users;
      convSetupActiveScreen();
      convShowScreen(convActive);
      break;

    case "message":
      convAddMessage(msg);
      convClearInterim();
      break;

    case "interim":
      convShowInterim(msg.from, msg.text);
      break;

    case "partner_left":
      convAddSystemMsg("Partner disconnected.");
      convStopListening();
      convMicBtn0.disabled = true;
      convMicBtn1.disabled = true;
      break;
  }
}

function convSetupActiveScreen() {
  for (let i = 0; i < 2; i++) {
    const user = convUsers[i];
    if (!user) continue;
    document.getElementById(`convUserName${i}`).textContent = user.name;
    document.getElementById(`convUserLang${i}`).textContent = LANG_NAMES[user.language] || user.language;
    document.getElementById(`convAvatar${i}`).textContent = user.name[0].toUpperCase();
    document.getElementById(`convMicLabel${i}`).textContent = user.name;
  }

  const myBtn = convPosition === 0 ? convMicBtn0 : convMicBtn1;
  const partnerBtn = convPosition === 0 ? convMicBtn1 : convMicBtn0;
  myBtn.disabled = false;
  partnerBtn.disabled = true;

  convMessages.innerHTML = '<div class="conv-start-hint">Press your mic to start speaking</div>';
}

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

  const hint = convMessages.querySelector(".conv-start-hint");
  if (hint) hint.remove();

  convMessages.appendChild(bubble);
  convMessages.scrollTop = convMessages.scrollHeight;
}

function convShowInterim(fromName, text) {
  let interim = convMessages.querySelector(".conv-interim");
  if (!interim) {
    interim = document.createElement("div");
    interim.className = "conv-interim";
    convMessages.appendChild(interim);
  }
  interim.textContent = `${fromName}: ${text}…`;
  convMessages.scrollTop = convMessages.scrollHeight;

  const partnerPos = 1 - convPosition;
  const partnerBtn = partnerPos === 0 ? convMicBtn0 : convMicBtn1;
  partnerBtn.classList.add("partner-speaking");
}

function convClearInterim() {
  const interim = convMessages.querySelector(".conv-interim");
  if (interim) interim.remove();

  const partnerPos = 1 - convPosition;
  const partnerBtn = partnerPos === 0 ? convMicBtn0 : convMicBtn1;
  partnerBtn.classList.remove("partner-speaking");
}

function convAddSystemMsg(text) {
  const msg = document.createElement("div");
  msg.className = "conv-system-msg";
  msg.textContent = text;
  convMessages.appendChild(msg);
  convMessages.scrollTop = convMessages.scrollHeight;
}

function convHandleDisconnect(reason) {
  if (convWs) {
    convWs.onclose = null;
    convWs.onerror = null;
    convWs = null;
  }
  convStopListening();
  if (reason) {
    alert(reason + "\nReturning to setup.");
  }
  convReset();
}

function convReset() {
  convStopListening();
  if (convWs) {
    convWs.close();
    convWs = null;
  }
  convPosition = -1;
  convUsers = [null, null];
  convMessages.innerHTML = '<div class="conv-start-hint">Press your mic to start speaking</div>';
  convRoomCode.textContent = "------";
  convShowScreen(convSetup);
}

function convStartListening() {
  if (!SpeechRecognition) {
    alert("Speech recognition not supported — use Chrome or Edge");
    return;
  }

  convFinalText = "";
  convRecognition = new SpeechRecognition();
  convRecognition.continuous = true;
  convRecognition.interimResults = true;
  convRecognition.lang = LANG_LOCALES[convUsers[convPosition]?.language] || "en-US";

  convRecognition.onresult = e => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        convFinalText += e.results[i][0].transcript + " ";
        clearTimeout(convXlateTimer);
        convXlateTimer = setTimeout(() => {
          const text = convFinalText.trim();
          if (text && convWs && convWs.readyState === WebSocket.OPEN) {
            convWs.send(JSON.stringify({ type: "speech", text, is_final: true }));
            convFinalText = "";
          }
        }, 300);
      } else {
        interim += e.results[i][0].transcript;
      }
    }

    if (interim && convWs && convWs.readyState === WebSocket.OPEN) {
      clearTimeout(convInterimTimer);
      convInterimTimer = setTimeout(() => {
        convWs.send(JSON.stringify({ type: "interim", text: interim }));
      }, 100);
    }
  };

  convRecognition.onend = () => {
    if (convIsListening) convRecognition.start();
  };

  convRecognition.onerror = e => {
    if (e.error === "not-allowed") {
      alert("Microphone access denied — check browser permissions");
    }
  };

  convRecognition.start();
  convIsListening = true;

  const myBtn = convPosition === 0 ? convMicBtn0 : convMicBtn1;
  myBtn.classList.add("active");
}

function convStopListening() {
  convIsListening = false;
  if (convRecognition) {
    convRecognition.stop();
    convRecognition = null;
  }
  const myBtn = convPosition === 0 ? convMicBtn0 : convMicBtn1;
  if (myBtn) myBtn.classList.remove("active");
}

convMicBtn0.addEventListener("click", () => {
  if (convPosition !== 0) return;
  convIsListening ? convStopListening() : convStartListening();
});

convMicBtn1.addEventListener("click", () => {
  if (convPosition !== 1) return;
  convIsListening ? convStopListening() : convStartListening();
});

convCreateBtn.addEventListener("click", async () => {
  const name = convNameInput.value.trim();
  if (!name) {
    convNameInput.focus();
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/create_room`);
    if (!res.ok) {
      alert(`Backend error (${res.status}). Is the server running on port 8000?`);
      return;
    }
    const data = await res.json();
    if (!data.room_id) {
      alert("Invalid response from server.");
      return;
    }
    await convConnect(data.room_id);
  } catch (e) {
    alert(`Failed to create room: ${e.message}\n\nMake sure backend is running:\ncd backend && ./startback.sh`);
  }
});

convJoinBtn.addEventListener("click", () => {
  const roomId = convRoomInput.value.trim().toUpperCase();
  if (!roomId) {
    convRoomInput.focus();
    return;
  }
  const name = convNameInput.value.trim();
  if (!name) {
    convNameInput.focus();
    return;
  }
  convConnect(roomId);
});

convRoomInput.addEventListener("keydown", e => {
  if (e.key === "Enter") convJoinBtn.click();
});

convNameInput.addEventListener("keydown", e => {
  if (e.key === "Enter") convCreateBtn.click();
});

convCancelBtn.addEventListener("click", () => convReset());
