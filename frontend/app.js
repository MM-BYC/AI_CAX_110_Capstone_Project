// In production the frontend is served by FastAPI itself, so use a same-origin
// (relative) base. In local dev the static server runs on :3000 and needs to
// hit the backend on :8000 explicitly.
const API_BASE = (window.location.port === "3000" || window.location.protocol === "file:")
  ? `http://${window.location.hostname}:8000`
  : "";

// Safari only allows one tab at a time to hold the microphone.
const _isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
// iOS Safari does not support webkitSpeechRecognition reliably — use MediaRecorder instead.
const _isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

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

// Hamburger menu — only visible on mobile. Toggles the .tab-menu-wrap dropdown
// open/closed. Clicking any tab button closes it again.
const hamburgerBtn = document.getElementById("hamburgerBtn");
const tabMenuWrap  = document.getElementById("tabMenuWrap");

function setMenuOpen(open) {
  if (!hamburgerBtn || !tabMenuWrap) return;
  tabMenuWrap.classList.toggle("open", open);
  hamburgerBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

hamburgerBtn?.addEventListener("click", () => {
  const isOpen = tabMenuWrap.classList.contains("open");
  setMenuOpen(!isOpen);
});

const _selectTab = (active) => { showTab(active); setMenuOpen(false); };
tabText.addEventListener("click",  () => _selectTab({ btn: tabText,  panel: textTab }));
tabAudio.addEventListener("click", () => _selectTab({ btn: tabAudio, panel: audioTab }));
tabLive.addEventListener("click",  () => _selectTab({ btn: tabLive,  panel: liveTab }));
tabConv.addEventListener("click",  () => _selectTab({ btn: tabConv,  panel: convTab }));

// Close the dropdown when tapping outside of it (mobile).
document.addEventListener("click", e => {
  if (!tabMenuWrap?.classList.contains("open")) return;
  if (tabMenuWrap.contains(e.target)) return;
  if (hamburgerBtn?.contains(e.target)) return;
  setMenuOpen(false);
});

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
      const isHttpOnMobile = _isSafari && window.location.protocol !== "https:";
      alert(
        isHttpOnMobile
          ? "Safari requires HTTPS to use the microphone.\n\n" +
            "Fix: run  ./make-certs.sh  on the MacBook, restart\n" +
            "both servers, then open  https://<MacBook-IP>:3000\n" +
            "on iPhone and trust the certificate."
          : "Microphone access was denied.\n\n" +
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
let convIsListening         = false;
let convRecognition         = null;
let convXlateTimer          = null;
let convFinalText           = "";
let convInterimTimer        = null;
let _recognitionRestartCount = 0;
let convCamStream    = null;
let convCamOn        = false;
let _convReconnectAttempts = 0;
let _convWasCreator        = false;
const _CONV_MAX_RECONNECTS = 3;

// Persistent colour palette — one colour per participant (8 distinct)
const _PARTICIPANT_PALETTE = [
  "#4f8ef7", "#e84393", "#22b573", "#f7a540",
  "#a259f7", "#e85c3a", "#2ec4b6", "#b59b00",
];
const _participantColors = {};   // user_id → hex colour
let   _paletteIndex = 0;

function convColorFor(userId) {
  if (!_participantColors[userId]) {
    _participantColors[userId] = _PARTICIPANT_PALETTE[_paletteIndex % _PARTICIPANT_PALETTE.length];
    _paletteIndex++;
  }
  return _participantColors[userId];
}

// ── Translated-speech TTS ─────────────────────────────────────────────────
// When a participant unmutes and speaks, every listener hears the translation
// read aloud in their own language via the Web Speech API (speechSynthesis).
// The text has already passed through the full anti-hallucination pipeline
// (ConversationAgent → strict TranslationAgent temp=0 → QualityReviewAgent)
// so TTS is just reading verified text — zero hallucination from synthesis.

let _ttsEnabled  = true;
let _ttsVoices   = [];
let _ttsUnlocked = false;

if (window.speechSynthesis) {
  const _loadVoices = () => { _ttsVoices = window.speechSynthesis.getVoices(); };
  _loadVoices();
  window.speechSynthesis.onvoiceschanged = _loadVoices;
}

// Must be called synchronously from a click/tap handler (user-gesture context).
// Chrome blocks speechSynthesis.speak() from async/WS callbacks until the API
// has been "activated" by at least one call inside a user gesture.
function _unlockTts() {
  if (!window.speechSynthesis || _ttsUnlocked) return;
  // Fire a barely-audible primer utterance inside this user-gesture call so
  // Chrome registers the page as speech-synthesis-activated.  Subsequent
  // calls from WebSocket handlers are then allowed by the browser.
  try {
    const primer = new SpeechSynthesisUtterance(" ");
    primer.volume = 0.01; // non-zero: some Chrome builds require audible output
    primer.rate   = 16;   // completes in milliseconds
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(primer);
    _ttsUnlocked = true;
  } catch (e) {
    console.warn("[TTS] unlock failed:", e);
  }
}

function convSpeak(text, langCode) {
  if (!_ttsEnabled || !window.speechSynthesis || !text.trim()) return;
  const ss = window.speechSynthesis;
  // Always resume — Chrome can silently enter a stuck state that is NOT
  // reflected by ss.paused (happens after tab-switch or long idle periods).
  try { ss.resume(); } catch (_) {}
  // Cancel any queued-but-not-yet-spoken utterances so the listener always
  // hears the *latest* translation rather than a stale backlog.
  if (ss.pending) ss.cancel();
  const locale = LANG_LOCALES[langCode] || langCode;
  const utt    = new SpeechSynthesisUtterance(text.trim());
  utt.lang     = locale;
  utt.rate     = 1.0;
  utt.pitch    = 1.0;
  const voices = _ttsVoices.length ? _ttsVoices : ss.getVoices();
  const prefix = langCode.split("-")[0];
  utt.voice    = voices.find(v => v.lang === locale)
              || voices.find(v => v.lang.startsWith(langCode))
              || voices.find(v => v.lang.startsWith(prefix))
              || null;
  try { ss.speak(utt); }
  catch (e) { console.warn("[TTS] speak failed:", e); }
}

function convSpeakCancel() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

// ── Voice Cloning ──────────────────────────────────────────────────────────
// Captures the speaker's first ~10 s of mic audio, uploads it to
// /api/v1/voices/enroll, then receives "voice_audio" frames containing the
// translated text spoken in the speaker's own cloned voice (XTTS-v2).
// Falls back to browser Web Speech API if cloning is unavailable on the server
// or the cloned audio doesn't arrive within _VOICE_FALLBACK_MS.

let _voiceCloneEnrolled    = false;
let _voiceCloneCapturing   = false;
let _voiceCloneAvailable   = null;       // null = unprobed, true/false after probe
const _VOICE_REF_SEC       = 10;
const _VOICE_FALLBACK_MS   = 1500;
const _voiceAwaiting       = new Map();  // from_id → setTimeout id

async function _voiceCloneProbe() {
  if (_voiceCloneAvailable !== null) return _voiceCloneAvailable;
  try {
    const r = await fetch("/api/v1/voices/status");
    _voiceCloneAvailable = r.ok ? !!(await r.json()).available : false;
  } catch {
    _voiceCloneAvailable = false;
  }
  if (_voiceCloneAvailable) console.log("[VoiceClone] available on this server");
  return _voiceCloneAvailable;
}

async function convVoiceCloneEnroll(stream) {
  if (_voiceCloneEnrolled || _voiceCloneCapturing || !convUserId || !stream) return;
  if (!(await _voiceCloneProbe())) return;
  _voiceCloneCapturing = true;
  try {
    const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    rec.onstop = async () => {
      _voiceCloneCapturing = false;
      try {
        const wav = await _webmBlobToWav(new Blob(chunks, { type: "audio/webm" }));
        if (!wav) return;
        const fd = new FormData();
        fd.append("file", wav, "reference.wav");
        const r = await fetch(
          `/api/v1/voices/enroll?user_id=${encodeURIComponent(convUserId)}`,
          { method: "POST", body: fd },
        );
        if (r.ok) {
          _voiceCloneEnrolled = true;
          console.log("[VoiceClone] enrolled — translations will use cloned voice");
          if (convWs?.readyState === WebSocket.OPEN) {
            convWs.send(JSON.stringify({ type: "voice_enrolled" }));
          }
        } else {
          console.warn("[VoiceClone] enroll HTTP", r.status);
        }
      } catch (e) {
        console.warn("[VoiceClone] enroll upload failed:", e);
      }
    };
    rec.start();
    setTimeout(() => { try { rec.stop(); } catch {} }, _VOICE_REF_SEC * 1000);
  } catch (e) {
    _voiceCloneCapturing = false;
    console.warn("[VoiceClone] capture failed:", e);
  }
}

// Speak the translated text. If voice cloning is available we wait briefly
// for the cloned audio to arrive; otherwise we use browser TTS immediately.
function convSpeakOrAwaitClone(text, langCode, fromId) {
  if (_voiceCloneAvailable !== true) {
    convSpeak(text, langCode);
    return;
  }
  const prev = _voiceAwaiting.get(fromId);
  if (prev) clearTimeout(prev);
  _voiceAwaiting.set(fromId, setTimeout(() => {
    _voiceAwaiting.delete(fromId);
    convSpeak(text, langCode);
  }, _VOICE_FALLBACK_MS));
}

// Play a base64-encoded WAV from a "voice_audio" message and cancel any
// pending browser-TTS fallback for the same speaker.
function convPlayClonedAudio(audioB64, fromId) {
  const tid = _voiceAwaiting.get(fromId);
  if (tid) { clearTimeout(tid); _voiceAwaiting.delete(fromId); }
  try {
    convSpeakCancel();
    const a = new Audio(`data:audio/wav;base64,${audioB64}`);
    a.play().catch(e => console.warn("[VoiceClone] play failed:", e));
  } catch (e) {
    console.warn("[VoiceClone] play exception:", e);
  }
}

// Decode WebM/Opus → mono 22.05 kHz WAV using WebAudio so XTTS can read it.
async function _webmBlobToWav(blob) {
  try {
    const buf = await blob.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const decoded = await ctx.decodeAudioData(buf);
    const sr = 22050;
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * sr), sr);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return _audioBufferToWav(rendered);
  } catch (e) {
    console.warn("[VoiceClone] decode failed:", e);
    return null;
  }
}

function _audioBufferToWav(buf) {
  const sr = buf.sampleRate, samples = buf.getChannelData(0), n = samples.length;
  const ab = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(ab);
  let p = 0;
  const ws = s => { for (let i = 0; i < s.length; i++) dv.setUint8(p++, s.charCodeAt(i)); };
  const w32 = v => { dv.setUint32(p, v, true); p += 4; };
  const w16 = v => { dv.setUint16(p, v, true); p += 2; };
  ws("RIFF"); w32(36 + n * 2); ws("WAVE");
  ws("fmt "); w32(16); w16(1); w16(1); w32(sr); w32(sr * 2); w16(2); w16(16);
  ws("data"); w32(n * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(p, s * 0x7FFF, true); p += 2;
  }
  return new Blob([ab], { type: "audio/wav" });
}

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
// convParticipantsBar removed — replaced by carousel
const convMessages       = document.getElementById("convMessages");
const convMicBtn         = document.getElementById("convMicBtn");
const convMicLabel       = document.getElementById("convMicLabel");
const convCamBtn         = document.getElementById("convCamBtn");
const convCamLabel       = document.getElementById("convCamLabel");
const convTtsBtn         = document.getElementById("convTtsBtn");
const convTtsLabel       = document.getElementById("convTtsLabel");
// convCamPreview / convCamVideo removed — local camera shown in own carousel card

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

// ── Participant carousel ───────────────────────────────────────────────────
// Each participant gets a square card (name overlay + camera video inside).
// Cards fill a 3-row grid; left/right arrows paginate when count exceeds one page.

const _CARD_SLOT = 108;   // card width (100px) + gap (8px)
const _CARD_ROWS = 3;

let _carouselPage  = 0;
const _carouselCards = [];   // ordered DOM elements; order = join order

function _carouselCols() {
  const vp = document.getElementById("convCarouselViewport");
  return vp ? Math.max(2, Math.floor(vp.clientWidth / _CARD_SLOT)) : 3;
}

function _buildCard(uid, user) {
  const isMe  = uid === convUserId;
  const color = convColorFor(uid);

  const card = document.createElement("div");
  card.className = "conv-participant-card" + (isMe ? " me" : "");
  card.id        = `conv-card-${uid}`;
  card.dataset.uid = uid;

  // ── Square video box ──────────────────────────────────────────
  const box = document.createElement("div");
  box.className = "conv-card-box";
  box.style.borderColor = color;

  // Initials placeholder (shown when camera is off). Uniform Space Gray
  // background for all participants — the per-participant palette color is
  // still used elsewhere (card border, name chip) for identification.
  const ph = document.createElement("div");
  ph.className   = "conv-card-placeholder";
  ph.id          = `conv-card-ph-${uid}`;
  const _nameParts = user.name.trim().split(/\s+/);
  ph.textContent = _nameParts.length >= 2
    ? (_nameParts[0][0] + _nameParts[_nameParts.length - 1][0]).toUpperCase()
    : _nameParts[0][0].toUpperCase();
  ph.style.background = "#4A4D52"; // Space Gray

  // Video element (hidden until camera opens)
  const vid = document.createElement("video");
  vid.autoplay    = true;
  vid.playsInline = true;
  vid.muted       = true;
  vid.id          = `conv-card-vid-${uid}`;
  vid.className   = "conv-card-vid";
  if (isMe) vid.style.transform = "scaleX(-1)"; // mirror selfie

  // Live caption overlay (interim/translated text for remote peers)
  const cap = document.createElement("div");
  cap.className = "conv-remote-caption";
  cap.id        = `conv-caption-${uid}`;

  // Name bar overlaid at bottom of box
  const nameBar = document.createElement("div");
  nameBar.className = "conv-card-name-bar";

  const micDot = document.createElement("div");
  micDot.className = "conv-participant-mic-dot" + (user.mic_on ? " on" : "");
  micDot.id = `conv-mic-dot-${uid}`;

  const nameTxt = document.createElement("span");
  nameTxt.className   = "conv-card-name-txt";
  nameTxt.textContent = user.name + (isMe ? " (You)" : "");

  const langBadge = document.createElement("span");
  langBadge.className   = "conv-lang-badge conv-card-lang-badge";
  langBadge.textContent = user.language.toUpperCase();
  langBadge.style.background = color;

  const camDot = document.createElement("div");
  camDot.className = "conv-participant-cam-dot" + (user.camera_on ? " on" : "");
  camDot.id = `conv-cam-dot-${uid}`;

  nameBar.appendChild(micDot);
  nameBar.appendChild(nameTxt);
  nameBar.appendChild(langBadge);
  nameBar.appendChild(camDot);

  if (user.is_host) {
    const hostBadge = document.createElement("span");
    hostBadge.className   = "conv-host-badge conv-card-host-badge";
    hostBadge.textContent = "Host";
    box.appendChild(hostBadge);
  }

  box.appendChild(ph);
  box.appendChild(vid);
  box.appendChild(cap);
  box.appendChild(nameBar);
  card.appendChild(box);
  return card;
}

function _carouselRenderPage() {
  const track = document.getElementById("convCarouselTrack");
  if (!track) return;

  const cols      = _carouselCols();
  const pageSize  = cols * _CARD_ROWS;
  const total     = _carouselCards.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  _carouselPage   = Math.min(_carouselPage, totalPages - 1);

  const start = _carouselPage * pageSize;
  const end   = start + pageSize;

  // Detach all, re-append only the current page's cards
  // (video elements keep playing when detached in modern browsers)
  while (track.firstChild) track.removeChild(track.firstChild);
  _carouselCards.slice(start, end).forEach(c => track.appendChild(c));
  track.style.gridTemplateColumns = `repeat(${cols}, 100px)`;

  const btnL = document.getElementById("convCarouselLeft");
  const btnR = document.getElementById("convCarouselRight");
  if (btnL) btnL.style.visibility = _carouselPage > 0            ? "visible" : "hidden";
  if (btnR) btnR.style.visibility = _carouselPage < totalPages-1 ? "visible" : "hidden";

  lucide.createIcons({ nodes: [
    document.getElementById("convCarouselLeft"),
    document.getElementById("convCarouselRight"),
  ].filter(Boolean) });
}

function convRenderParticipants() {
  // Add cards for new participants (preserves existing DOM nodes with live video)
  Object.entries(convUsers).forEach(([uid, user]) => {
    if (!_carouselCards.find(c => c.dataset.uid === uid)) {
      _carouselCards.push(_buildCard(uid, user));
    }
  });

  // Remove cards for departed participants
  for (let i = _carouselCards.length - 1; i >= 0; i--) {
    if (!convUsers[_carouselCards[i].dataset.uid]) {
      _carouselCards.splice(i, 1);
    }
  }

  _carouselRenderPage();
}

function convUpdateChipMic(userId, isOn) {
  const card = document.getElementById(`conv-card-${userId}`);
  if (card) card.classList.toggle("speaking", isOn);
  const dot = document.getElementById(`conv-mic-dot-${userId}`);
  if (dot) dot.className = "conv-participant-mic-dot" + (isOn ? " on" : "");
}

function convUpdateChipCam(userId, isOn) {
  const dot = document.getElementById(`conv-cam-dot-${userId}`);
  if (dot) dot.className = "conv-participant-cam-dot" + (isOn ? " on" : "");
}

// Re-paginate when the window resizes (column count may change)
window.addEventListener("resize", () => _carouselRenderPage());

// Arrow click handlers
document.getElementById("convCarouselLeft")?.addEventListener("click", () => {
  if (_carouselPage > 0) { _carouselPage--; _carouselRenderPage(); }
});
document.getElementById("convCarouselRight")?.addEventListener("click", () => {
  const cols      = _carouselCols();
  const pageSize  = cols * _CARD_ROWS;
  const totalPages = Math.ceil(_carouselCards.length / pageSize);
  if (_carouselPage < totalPages - 1) { _carouselPage++; _carouselRenderPage(); }
});

// ── Message rendering ──────────────────────────────────────────────────────
function convAddMessage(msg) {
  convClearInterim();

  const color = convColorFor(msg.from_id);

  const bubble = document.createElement("div");
  bubble.className = `conv-bubble ${msg.is_self ? "self" : "partner"}`;
  bubble.style.borderLeftColor = color;

  const nameEl = document.createElement("div");
  nameEl.className = "conv-bubble-name";
  nameEl.style.color = color;
  nameEl.textContent = msg.from;

  // Main content — show translated text to others, original to self
  const mainEl = document.createElement("div");
  mainEl.className = "conv-bubble-main";
  mainEl.textContent = msg.is_self ? msg.original : msg.translation;

  // "Show original" toggle (always available for non-self messages)
  const hasOriginal = !msg.is_self && msg.original && msg.original !== msg.translation;
  let showingOriginal = false;

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "conv-toggle-original";
  if (!hasOriginal) {
    toggleBtn.style.display = "none";
  } else {
    toggleBtn.textContent = "Show original";
    toggleBtn.addEventListener("click", () => {
      showingOriginal = !showingOriginal;
      mainEl.textContent = showingOriginal ? msg.original : msg.translation;
      toggleBtn.textContent = showingOriginal ? "Show translation" : "Show original";
    });
  }

  bubble.appendChild(nameEl);
  bubble.appendChild(mainEl);
  bubble.appendChild(toggleBtn);

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
  convUpdateCaption(fromId, text + "…", false);
}

function convClearInterim() {
  convMessages.querySelector(".conv-interim")?.remove();
  document.querySelectorAll(".conv-participant-mic-dot.pulsing")
    .forEach(d => d.classList.remove("pulsing"));
}

// Typing indicators — keyed by user_id so multiple typers stack correctly
const _typingUsers = {};   // user_id → {name, color, timerId}

function convShowTyping(userId, name) {
  // Each heartbeat resets the expiry timer — if no heartbeat arrives within
  // _TYPING_EXPIRE_MS the indicator self-clears (handles disconnects / lost stop signals)
  if (_typingUsers[userId]) clearTimeout(_typingUsers[userId].timerId);
  _typingUsers[userId] = {
    name,
    color: convColorFor(userId),
    timerId: setTimeout(() => convClearTyping(userId), _TYPING_EXPIRE_MS),
  };
  _convRenderTypingBar();
}

function convClearTyping(userId) {
  if (!_typingUsers[userId]) return;
  clearTimeout(_typingUsers[userId].timerId);
  delete _typingUsers[userId];
  _convRenderTypingBar();
}

function _convRenderTypingBar() {
  let bar = document.getElementById("conv-typing-bar");
  const entries = Object.values(_typingUsers);
  if (!entries.length) { bar?.remove(); return; }

  if (!bar) {
    bar = document.createElement("div");
    bar.id = "conv-typing-bar";
    bar.className = "conv-typing-bar";
    convMessages.appendChild(bar);
  }

  const names = entries.map(u =>
    `<span class="conv-typing-name" style="color:${u.color}">${u.name}</span>`
  ).join(", ");
  const verb = entries.length === 1 ? "is typing" : "are typing";
  bar.innerHTML =
    `${names} <span class="conv-typing-dots"><span></span><span></span><span></span></span> ${verb}…`;
  convMessages.scrollTop = convMessages.scrollHeight;
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
async function convConnect(roomId, isCreator = false) {
  convRoomId = roomId;
  _convWasCreator = !!isCreator;
  const name = convNameInput.value.trim();
  const lang = convLangSelect.value;

  const wsUrl = `${convGetWsBase()}/ws/conversation/${roomId}`;
  convWs = new WebSocket(wsUrl);

  convWs.onopen = () => {
    _convReconnectAttempts = 0;
    convWs.send(JSON.stringify({
      type: "join", name, language: lang, is_creator: _convWasCreator,
    }));
  };

  convWs.onmessage = e => {
    convHandleMessage(JSON.parse(e.data));
  };

  convWs.onclose = event => {
    if (event.code !== 1000 && convUserId) {
      if (_convReconnectAttempts < _CONV_MAX_RECONNECTS) {
        _convReconnectAttempts++;
        convAddSystemMsg(`Connection lost. Reconnecting…`);
        setTimeout(() => convConnect(roomId, _convWasCreator), _convReconnectAttempts * 2000);
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

    case "error":
      if (msg.code === "room_not_found") {
        if (convWs) { convWs.onclose = null; convWs.onerror = null; }
        alert(msg.message || `Room ${convRoomId} not found. Check the code with the host.`);
        convRoomId = "";
        convCreateBtn.disabled = false;
        convCreateBtn.querySelector("span").textContent = "Create Room";
      }
      break;

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
      convClearTyping(msg.user_id);
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
      if (!msg.is_self) {
        convUpdateCaption(msg.from_id, msg.translation, true);
        convSpeakOrAwaitClone(
          msg.translation,
          convUsers[convUserId]?.language || "en",
          msg.from_id,
        );
      }
      break;

    case "voice_audio":
      // Cloned-voice playback — replaces browser TTS for this utterance.
      convPlayClonedAudio(msg.audio_b64, msg.from_id);
      break;

    case "interim":
      convShowInterim(msg.from_id, msg.from, msg.text);
      break;

    case "typing":
      if (msg.is_typing) convShowTyping(msg.user_id, msg.name);
      else               convClearTyping(msg.user_id);
      break;

    case "user_mic_status":
      if (convUsers[msg.user_id]) convUsers[msg.user_id].mic_on = msg.is_on;
      convUpdateChipMic(msg.user_id, msg.is_on);
      break;

    case "user_camera_status":
      if (convUsers[msg.user_id]) convUsers[msg.user_id].camera_on = msg.is_on;
      convUpdateChipCam(msg.user_id, msg.is_on);
      // Zoom-style: explicit signal beats relying on track mute events,
      // which Safari does not reliably fire after replaceTrack(null).
      // Hide the video and show the initials placeholder.
      {
        const vid = document.getElementById(`conv-card-vid-${msg.user_id}`);
        const ph  = document.getElementById(`conv-card-ph-${msg.user_id}`);
        if (msg.is_on) {
          if (vid) vid.style.display = "block";
          if (ph)  ph.style.display = "none";
          vid?.play().catch(() => {});
        } else {
          if (vid) {
            try { vid.pause(); } catch {}
            vid.style.display = "none";
          }
          if (ph) ph.style.display = "";
        }
      }
      break;

    case "interrupted": {
      const interruptedName = msg.interrupted_name;
      const byName = msg.by_name || (convUsers[msg.interrupted_by_id]?.name ?? "Someone");
      const el = document.createElement("div");
      el.className = "conv-interrupted-banner";
      el.innerHTML = `<svg data-lucide="zap"></svg><span>${byName} interrupted ${interruptedName}</span>`;
      convMessages.querySelector(".conv-start-hint")?.remove();
      convMessages.appendChild(el);
      convMessages.scrollTop = convMessages.scrollHeight;
      lucide.createIcons({ nodes: [el] });
      // Auto-remove after 4 s so the feed stays clean
      setTimeout(() => el.remove(), 4000);
      break;
    }

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
  // myInfo may not have arrived yet if clicked immediately after joining —
  // fall back to "en-US" so the mic still starts rather than silently doing nothing
  const lang = LANG_LOCALES[myInfo?.language] || "en-US";

  convFinalText = "";
  _recognitionRestartCount = 0;
  convRecognition = new SpeechRecognition();
  convRecognition.continuous     = true;
  convRecognition.interimResults = true;
  convRecognition.lang           = lang;

  convRecognition.onresult = e => {
    _recognitionRestartCount = 0; // successful audio — reset the drop counter
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

  convRecognition.onend = () => {
    if (!convIsListening) return;
    // Guard against a tight spin-loop (e.g. iOS backgrounding the recognizer,
    // a persistent audio-capture failure, or network drops). If the recognizer
    // fires onend 5 times in a row without any successful onresult in between,
    // stop and surface a clear message rather than spinning silently forever.
    if (_recognitionRestartCount >= 5) {
      convStopListening();
      alert("Microphone dropped repeatedly — tap the mic button to try again.");
      return;
    }
    _recognitionRestartCount++;
    convRecognition.start();
  };

  convRecognition.onerror = e => {
    if (e.error === "not-allowed") {
      convStopListening();
      const safariNote = _isSafari
        ? "Safari limitation detected:\n" +
          "  Safari allows only ONE tab to use the mic at a time.\n" +
          "  If another tab in this Safari window is using the mic,\n" +
          "  that tab blocks all others.\n\n" +
          "  ► In production (different devices / phones), this is not an issue.\n\n"
        : "";
      alert(
        "Microphone blocked — browser cannot access the mic.\n\n" +
        safariNote +
        "macOS check:\n" +
        "  System Settings → Privacy & Security → Microphone\n" +
        "  → make sure your browser is toggled ON\n\n" +
        "Browser check:\n" +
        "  Click the lock icon in the address bar\n" +
        "  → Site Settings → Microphone → Allow → reload the page."
      );
    } else if (e.error === "service-not-allowed") {
      // On Safari/iOS, "service-not-allowed" has two causes:
      // 1. Page is served over plain HTTP (not HTTPS) — Safari blocks STT on HTTP
      // 2. iOS Dictation is disabled in Settings (Settings → General → Keyboard → Enable Dictation)
      convStopListening();
      const isHttp = window.location.protocol !== "https:";
      const iosNote = _isIOS && !isHttp
        ? "iPhone fix:\n" +
          "  Settings → General → Keyboard → Enable Dictation → ON\n\n"
        : "";
      alert(
        "Speech recognition service unavailable.\n\n" +
        iosNote +
        (_isSafari && isHttp
          ? "Safari requires HTTPS to use the microphone.\n\n" +
            "Fix: run  ./make-certs.sh  on the MacBook, then restart\n" +
            "both servers. Open the app at  https://<MacBook-IP>:3000\n" +
            "on your iPhone after trusting the certificate."
          : _isSafari
            ? "Safari routes speech recognition through Apple's servers.\n" +
              "Check your internet connection and try again."
            : "Check your internet connection and try again.")
      );
    }
    // All other errors (aborted, network, no-speech, audio-capture) are
    // transient. onend fires after onerror and will restart automatically.
  };

  try {
    convRecognition.start();
  } catch (err) {
    console.error("[mic] SpeechRecognition.start() failed:", err);
    convRecognition = null;
    return;
  }
  convIsListening = true;
  convWs?.readyState === WebSocket.OPEN &&
    convWs.send(JSON.stringify({ type: "mic_status", is_on: true }));
  convSetMicUI(true);
  // Safari: SpeechRecognition already holds the mic; a simultaneous getUserMedia
  // call for WebRTC audio would race for the same audio session and cause a
  // not-allowed error that erroneously shows the "mic blocked" dialog.
  if (!_isSafari) webrtcStartAudio();
}

function convStopListening() {
  convIsListening = false;
  if (convRecognition) { convRecognition.stop(); convRecognition = null; }
  convWs?.readyState === WebSocket.OPEN &&
    convWs.send(JSON.stringify({ type: "mic_status", is_on: false }));
  convSetMicUI(false);
  if (!_isSafari) webrtcStopAudio();
}

// ── iOS mic — AudioContext → ScriptProcessorNode → Google STT streaming ─────
// Raw LINEAR16 PCM is streamed continuously to /ws/stt/. Final transcripts
// from Google Cloud Speech are injected directly into the translation
// pipeline — no chunked HTTP calls needed.

let _iosMicStream          = null;
let _iosAudioCtx           = null;
let _iosProcessor          = null;
let _iosSttWs              = null;
let _iosMicActive          = false;
let _iosStarting           = false;  // guard against double-tap race
let _iosSttReconnectCount  = 0;
const _IOS_STT_MAX_RECONNECT = 6;

async function convStartIosMic() {
  if (_iosStarting || _iosMicActive) return;
  _iosStarting = true;
  try {
    await _convStartIosMicInner();
  } catch (err) {
    console.error("[iOS mic] unexpected error during startup:", err);
    _iosMicStream?.getTracks().forEach(t => t.stop()); _iosMicStream = null;
    _iosAudioCtx?.close(); _iosAudioCtx = null;
    if (_iosSttWs && _iosSttWs.readyState < WebSocket.CLOSING) _iosSttWs.close();
    _iosSttWs = null;
    _iosProcessor = null;
  } finally {
    _iosStarting = false;  // always reset — never leave the button locked
  }
}

function _micTrace(msg) {
  console.log(`[mic] ${msg}`);
  if (convMicLabel) convMicLabel.textContent = msg;
}

async function _convStartIosMicInner() {
  _micTrace("Requesting mic…");
  try {
    _iosMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    _micTrace("Tap to speak");
    alert("Microphone access denied.\n\nSettings → Safari → Microphone → Allow, then reload.");
    return;
  }
  _micTrace("Mic granted, building audio context…");

  _iosAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  await _iosAudioCtx.resume();
  const actualRate = Math.round(_iosAudioCtx.sampleRate);
  _micTrace(`AudioContext ready (${actualRate} Hz), connecting to STT…`);

  const lang  = convUsers[convUserId]?.language || "en";
  const wsUrl = _buildIosSttWsUrl();
  console.log("[mic] WS URL:", wsUrl);
  _iosSttWs = new WebSocket(wsUrl);
  _iosSttWs.binaryType = "arraybuffer";

  // Wait for WS to open (or fail)
  const opened = await new Promise(resolve => {
    _iosSttWs.onopen  = () => resolve(true);
    _iosSttWs.onerror = () => resolve(false);
    _iosSttWs.onclose = () => resolve(false);
  });

  if (!opened) {
    _micTrace("Tap to speak");
    console.error("[iOS mic] STT WS failed to open");
    alert("Could not connect to transcription service.\n\nCheck that API keys are set on Render.");
    _iosMicStream?.getTracks().forEach(t => t.stop()); _iosMicStream = null;
    _iosAudioCtx?.close(); _iosAudioCtx = null;
    _iosSttWs = null;
    _iosStarting = false;
    return;
  }

  // /ws/stt/ requires a JSON config message before any audio bytes.
  _iosSttWs.send(JSON.stringify({ sample_rate: actualRate, language: lang }));
  _micTrace("STT connected, checking stability…");

  // Yield one event-loop turn so any immediate server-close fires onclose first
  let _sttCloseReason = "";
  _iosSttWs.onclose = (e) => { _sttCloseReason = e.reason || ""; _iosSttWs = null; };
  _iosSttWs.onerror = ()  => { _iosSttWs = null; };
  await new Promise(r => setTimeout(r, 50));

  if (!_iosSttWs || _iosSttWs.readyState !== WebSocket.OPEN) {
    _micTrace("Tap to speak");
    console.error("[iOS mic] STT WS closed immediately:", _sttCloseReason);
    alert("Mic connection failed — server closed immediately.\n\n" +
          (_sttCloseReason ? `Reason: ${_sttCloseReason}` : "Check Render logs for details."));
    _iosMicStream?.getTracks().forEach(t => t.stop()); _iosMicStream = null;
    _iosAudioCtx?.close(); _iosAudioCtx = null;
    _iosStarting = false;
    return;
  }
  _micTrace("STT stable, starting audio stream…");

  // On unexpected drop, reconnect silently; only a user click stops the mic.
  _iosSttWs.onclose = _iosSttWs.onerror = _onIosSttDrop;

  const source = _iosAudioCtx.createMediaStreamSource(_iosMicStream);
  _iosProcessor = _iosAudioCtx.createScriptProcessor(4096, 1, 1);
  // RMS threshold below which the frame is sent as silence (zeros).
  // Prevents Google STT from hallucinating words from background noise.
  // iOS Safari's noiseSuppression and AGC heavily attenuate voice, so the
  // gate is set conservatively — only true room silence falls below it.
  const NOISE_GATE_RMS = 0.004;
  let _frameCount = 0;
  let _peakRms = 0;
  _iosProcessor.onaudioprocess = e => {
    if (_iosSttWs?.readyState !== WebSocket.OPEN) return;
    const f32 = e.inputBuffer.getChannelData(0);
    let sumSq = 0;
    for (let i = 0; i < f32.length; i++) sumSq += f32[i] * f32[i];
    const rms = Math.sqrt(sumSq / f32.length);
    if (rms > _peakRms) _peakRms = rms;
    _frameCount++;
    if (_frameCount % 25 === 0) {
      console.log(`[mic] frames=${_frameCount} peakRMS=${_peakRms.toFixed(4)} curRMS=${rms.toFixed(4)}`);
    }
    const i16 = new Int16Array(f32.length); // initialized to zeros
    if (rms >= NOISE_GATE_RMS) {
      for (let i = 0; i < f32.length; i++) {
        i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
      }
    }
    _iosSttWs.send(i16.buffer);
  };
  source.connect(_iosProcessor);
  _iosProcessor.connect(_iosAudioCtx.destination);

  _iosSttReconnectCount = 0;
  _iosMicActive = true;
  convSetMicUI(true);
  convMicLabel.textContent = "Listening…";
  convWs?.readyState === WebSocket.OPEN &&
    convWs.send(JSON.stringify({ type: "mic_status", is_on: true }));
  // Voice-clone enrollment from the live mic stream (best-effort, no-op if
  // already enrolled or the server doesn't support cloning).
  convVoiceCloneEnroll(_iosMicStream);
}

function convStopIosMic() {
  if (!_iosMicActive) return;
  _iosMicActive = false;
  _iosSttReconnectCount = 0;  // reset so next mic-on starts fresh
  if (_iosProcessor) { _iosProcessor.disconnect(); _iosProcessor = null; }
  if (_iosAudioCtx)  { _iosAudioCtx.close();       _iosAudioCtx  = null; }
  if (_iosSttWs && _iosSttWs.readyState < WebSocket.CLOSING) _iosSttWs.close();
  _iosSttWs = null;
  _iosMicStream?.getTracks().forEach(t => t.stop());
  _iosMicStream = null;
  convSetMicUI(false);
  convMicLabel.textContent = "Tap to speak";
  convWs?.readyState === WebSocket.OPEN &&
    convWs.send(JSON.stringify({ type: "mic_status", is_on: false }));
}

function _buildIosSttWsUrl() {
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsBase  = (API_BASE || location.origin).replace(/^https?:/, wsProto);
  return `${wsBase}/ws/stt/${convRoomId}/${convUserId}`;
}

function _onIosSttDrop() {
  _iosSttWs = null;
  if (_iosMicActive) _scheduleIosSttReconnect();
}

// Reconnect only the STT WebSocket — mic stays on, audio pipeline keeps running.
function _scheduleIosSttReconnect() {
  if (!_iosMicActive) return;
  if (_iosSttReconnectCount >= _IOS_STT_MAX_RECONNECT) {
    _micTrace("STT unavailable — tap mic to stop");
    return;
  }
  _iosSttReconnectCount++;
  const delay = Math.min(1000 * _iosSttReconnectCount, 8000);
  _micTrace(`Reconnecting STT (${_iosSttReconnectCount})…`);
  setTimeout(_reconnectIosSttWs, delay);
}

function _reconnectIosSttWs() {
  if (!_iosMicActive || !_iosAudioCtx) return;
  const lang       = convUsers[convUserId]?.language || "en";
  const sampleRate = Math.round(_iosAudioCtx.sampleRate);
  const ws         = new WebSocket(_buildIosSttWsUrl());
  ws.binaryType    = "arraybuffer";
  ws.onopen = () => {
    ws.send(JSON.stringify({ sample_rate: sampleRate, language: lang }));
    _iosSttWs = ws;
    _micTrace("Listening…");
    ws.onclose = ws.onerror = _onIosSttDrop;
    // Only reset backoff counter after connection stays alive for 5 s
    setTimeout(() => { if (_iosSttWs === ws) _iosSttReconnectCount = 0; }, 5000);
  };
  ws.onclose = ws.onerror = () => { if (_iosMicActive) _scheduleIosSttReconnect(); };
}

convMicBtn.addEventListener("click", () => {
  if (_isIOS) {
    if (_iosMicActive) {
      convStopIosMic();
    } else {
      _iosStarting = false; // clear any stale lock from a previous failed attempt
      convStartIosMic();
    }
  } else {
    convIsListening ? convStopListening() : convStartListening();
  }
});

// ── TTS toggle ─────────────────────────────────────────────────────────────
function convSetTtsUI(enabled) {
  if (!convTtsBtn || !convTtsLabel) return;
  convTtsBtn.classList.toggle("tts-off", !enabled);
  convTtsBtn.querySelector("i")?.setAttribute("data-lucide", enabled ? "volume-2" : "volume-x");
  convTtsLabel.textContent = enabled ? "Voice on" : "Voice off";
  lucide.createIcons({ nodes: [convTtsBtn] });
}

convTtsBtn?.addEventListener("click", () => {
  _unlockTts(); // also unlock from TTS toggle (user gesture)
  _ttsEnabled = !_ttsEnabled;
  if (!_ttsEnabled) convSpeakCancel();
  convSetTtsUI(_ttsEnabled);
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
  // Show local stream inside the participant's own carousel card
  const _myVid = document.getElementById(`conv-card-vid-${convUserId}`);
  const _myPh  = document.getElementById(`conv-card-ph-${convUserId}`);
  if (_myVid) { _myVid.srcObject = stream; _myVid.style.display = "block"; }
  if (_myPh)  _myPh.style.display = "none";
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
  // Clear local stream from carousel card
  const _myVid = document.getElementById(`conv-card-vid-${convUserId}`);
  const _myPh  = document.getElementById(`conv-card-ph-${convUserId}`);
  if (_myVid) { _myVid.srcObject = null; _myVid.style.display = ""; }
  if (_myPh)  _myPh.style.display = "";
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
  convStopIosMic();
  convStopCamera();
  convSpeakCancel();
  _ttsUnlocked = false;
  if (convWs) { convWs.close(); convWs = null; }
  convRoomId  = null;
  convUserId  = null;
  convIsHost  = false;
  convUsers   = {};
  // Reset carousel, colour and typing state for next session
  _carouselCards.length = 0;
  _carouselPage = 0;
  const _track = document.getElementById("convCarouselTrack");
  if (_track) _track.innerHTML = "";
  Object.keys(_participantColors).forEach(k => delete _participantColors[k]);
  _paletteIndex = 0;
  Object.keys(_typingUsers).forEach(k => { clearTimeout(_typingUsers[k].timerId); delete _typingUsers[k]; });
  clearTimeout(_typingTimer);
  clearInterval(_typingHeartbeat);
  _typingHeartbeat = null;
  _isTyping = false;
  convMessages.innerHTML = '<div class="conv-start-hint">Press your mic to start speaking</div>';
  convRoomCode.textContent = "------";
  convShowScreen(convSetup);
  convCreateBtn.disabled = false;
  convCreateBtn.querySelector("span").textContent = "Create Room";
}

// ── Create / Join buttons ──────────────────────────────────────────────────
convCreateBtn.addEventListener("click", async () => {
  _unlockTts(); // synchronous — before first await, still in user-gesture context
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
    await convConnect(data.room_id, true);
  } catch (e) {
    convCreateBtn.disabled = false;
    convCreateBtn.querySelector("span").textContent = "Create Room";
    alert(`Failed to create room: ${e.message}`);
  }
});

convJoinBtn.addEventListener("click", () => {
  _unlockTts(); // synchronous — user-gesture context
  const roomId = convRoomInput.value.trim().toUpperCase();
  if (!roomId) { convRoomInput.focus(); return; }
  const name   = convNameInput.value.trim();
  if (!name)   { convNameInput.focus(); return; }
  convConnect(roomId, false);
});

convRoomInput.addEventListener("keydown", e => { if (e.key === "Enter") convJoinBtn.click(); });
convNameInput.addEventListener("keydown", e => { if (e.key === "Enter") convCreateBtn.click(); });

convLeaveBtn.addEventListener("click", () => {
  // Explicit leave: tell the server so the room can be torn down (if host)
  // or the user can be removed (if participant). Without this message a
  // close is treated as a transient WS drop and the room stays alive.
  if (convWs && convWs.readyState === WebSocket.OPEN) {
    try { convWs.send(JSON.stringify({ type: "leave" })); } catch {}
  }
  convReset();
});

convCopyCodeBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(convRoomCode.textContent).then(() => {
    convCopyCodeBtn.title = "Copied!";
    setTimeout(() => { convCopyCodeBtn.title = "Copy room code"; }, 1500);
  });
});

// ── Invite Modal ───────────────────────────────────────────────────────────
const convInviteBtn   = document.getElementById("convInviteBtn");
const convInviteModal = document.getElementById("convInviteModal");
const convInviteMsg   = document.getElementById("convInviteMsg");
const convInviteClose = document.getElementById("convInviteClose");

const INVITE_PLATFORMS = [
  { id: "copy",      label: "Copy",      bg: "#6366f1", emoji: "📋" },
  { id: "sms",       label: "SMS",       bg: "#10b981", emoji: "💬" },
  { id: "email",     label: "Email",     bg: "#f59e0b", emoji: "✉️"  },
  { id: "whatsapp",  label: "WhatsApp",  bg: "#25d366", emoji: "📱" },
  { id: "teams",     label: "Teams",     bg: "#5059c9", emoji: "🏢" },
  { id: "messenger", label: "Messenger", bg: "#0084ff", emoji: "💙" },
  { id: "telegram",  label: "Telegram",  bg: "#2ca5e0", emoji: "✈️"  },
  { id: "slack",     label: "Slack",     bg: "#4a154b", emoji: "💼" },
  { id: "discord",   label: "Discord",   bg: "#5865f2", emoji: "🎮" },
];

function inviteText() {
  const code = convRoomCode.textContent.trim();
  const url  = window.location.origin + window.location.pathname;
  return `You're invited to a live AI Translate conversation!\n\nRoom Code: ${code}\nOpen the app: ${url}\n\nEnter the room code to join.`;
}
function inviteShort() {
  const code = convRoomCode.textContent.trim();
  const url  = window.location.origin + window.location.pathname;
  return `Join my AI Translate room! Code: ${code} | ${url}`;
}

function inviteCopyAndLabel(platformId, label) {
  navigator.clipboard.writeText(inviteText()).then(() => {
    const el = document.querySelector(`[data-platform="${platformId}"] .conv-invite-platform-name`);
    if (!el) return;
    const orig = el.textContent;
    el.textContent = label;
    setTimeout(() => { el.textContent = orig; }, 2200);
  });
}

function inviteShare(platformId) {
  const enc  = encodeURIComponent(inviteText());
  const encs = encodeURIComponent(inviteShort());
  const url  = encodeURIComponent(window.location.origin + window.location.pathname);
  const subj = encodeURIComponent("Join my AI Translate room");
  ({
    copy:      () => inviteCopyAndLabel("copy", "Copied!"),
    sms:       () => window.open(`sms:?&body=${enc}`),
    email:     () => window.open(`mailto:?subject=${subj}&body=${enc}`),
    whatsapp:  () => window.open(`https://api.whatsapp.com/send?text=${enc}`),
    teams:     () => window.open(`https://teams.microsoft.com/l/chat/0/0?users=&message=${encs}`),
    messenger: () => inviteCopyAndLabel("messenger", "Copied!"),
    telegram:  () => window.open(`https://t.me/share/url?url=${url}&text=${encs}`),
    slack:     () => inviteCopyAndLabel("slack",   "Copied — paste in Slack"),
    discord:   () => inviteCopyAndLabel("discord", "Copied — paste in Discord"),
  })[platformId]?.();
}

(function buildInviteGrid() {
  const grid = document.getElementById("convInvitePlatforms");
  INVITE_PLATFORMS.forEach(p => {
    const btn = document.createElement("button");
    btn.className = "conv-invite-platform";
    btn.dataset.platform = p.id;
    btn.innerHTML = `<div class="conv-invite-platform-icon" style="background:${p.bg}">${p.emoji}</div>
      <span class="conv-invite-platform-name">${p.label}</span>`;
    btn.addEventListener("click", () => inviteShare(p.id));
    grid.appendChild(btn);
  });
})();

convInviteBtn.addEventListener("click", () => {
  convInviteMsg.value = inviteText();
  convInviteModal.style.display = "flex";
  lucide.createIcons({ nodes: [convInviteClose] });
});
convInviteClose.addEventListener("click", () => { convInviteModal.style.display = "none"; });
convInviteModal.addEventListener("click", e => {
  if (e.target === convInviteModal) convInviteModal.style.display = "none";
});

// ── Keyboard Input Module ──────────────────────────────────────────────────
const convKeyboardInput = document.getElementById("convKeyboardInput");
const convKeyboardSend  = document.getElementById("convKeyboardSend");

// Typing heartbeat — best practice used by Slack / WhatsApp / iMessage:
//   • Send typing=true ONCE on first keystroke (not on every keystroke)
//   • Resend typing=true every HEARTBEAT_MS while the user is still composing
//   • Send typing=false immediately on send, clear, or blur
//   • Receiver auto-expires the indicator after EXPIRE_MS — handles
//     disconnects / lost stop signals with no zombie "X is typing…"
const _TYPING_HEARTBEAT_MS = 3000;
const _TYPING_EXPIRE_MS    = 5000;  // slightly longer than heartbeat for network slack

let _typingTimer     = null;
let _typingHeartbeat = null;
let _isTyping        = false;

function _typingSend(on) {
  if (_isTyping === on || convWs?.readyState !== WebSocket.OPEN) return;
  _isTyping = on;
  convWs.send(JSON.stringify({ type: "typing", is_typing: on }));
}

function _typingStart() {
  if (!_isTyping) {
    _typingSend(true);
    _typingHeartbeat = setInterval(() => {
      if (convWs?.readyState === WebSocket.OPEN)
        convWs.send(JSON.stringify({ type: "typing", is_typing: true }));
    }, _TYPING_HEARTBEAT_MS);
  }
}

function _typingStop() {
  clearInterval(_typingHeartbeat);
  _typingHeartbeat = null;
  _typingSend(false);
}

function convSendKeyboard() {
  const text = convKeyboardInput.value.trim();
  if (!text || convWs?.readyState !== WebSocket.OPEN) return;
  _typingStop();
  convWs.send(JSON.stringify({ type: "keyboard", text }));
  convKeyboardInput.value = "";
  convKeyboardSend.disabled = false;
}

convKeyboardSend.addEventListener("click", convSendKeyboard);

convKeyboardInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); convSendKeyboard(); }
});

convKeyboardInput.addEventListener("input", () => {
  if (convKeyboardInput.value.trim().length > 0) {
    _typingStart();
  } else {
    _typingStop();
  }
});

// Stop typing indicator when user clicks/tabs away from the field
convKeyboardInput.addEventListener("blur", () => _typingStop());

// ── WebRTC Module ─────────────────────────────────────────────────────────
const WEBRTC_ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// convVideoGrid removed — remote video shown inside carousel cards

let rtcPeers         = {};  // userId → RTCPeerConnection
let rtcAudioTrack    = null; // local mic audio track (for WebRTC)
let rtcVideoTrack    = null; // local camera video track (for WebRTC)
let rtcAudioContext  = null; // created on user click so it's always activated
let rtcAudioSources  = {};  // userId → AudioContext source node
let rtcVideoSenders  = {};  // userId → RTCRtpSender (kept across pause/resume so
                            // re-opening the camera reuses the same sender)
let rtcAudioSenders  = {};  // userId → RTCRtpSender (same idea for audio)

function rtcLocalTracks() {
  return [rtcAudioTrack, rtcVideoTrack].filter(Boolean);
}

// Perfect Negotiation (W3C standard)
// ─────────────────────────────────────────────────────────────────────────────
// When both peers add tracks simultaneously both fire onnegotiationneeded and
// send offers at the same moment ("glare"). Without handling this one side's
// setRemoteDescription throws InvalidStateError (have-local-offer), the track
// is silently dropped, and one direction of audio/video never connects.
//
// Fix: designate host as "impolite" (its offer wins) and joiner as "polite"
// (it rolls back its own pending offer and accepts the remote one).
// The browser re-fires onnegotiationneeded after rollback so the polite peer's
// own tracks get negotiated in the next round-trip.

function rtcCreatePeer(userId) {
  if (rtcPeers[userId]) return rtcPeers[userId];

  const pc = new RTCPeerConnection({ iceServers: WEBRTC_ICE });
  rtcPeers[userId] = pc;
  pc._makingOffer = false;

  rtcLocalTracks().forEach(t => {
    const sender = pc.addTrack(t);
    if (t.kind === "video") rtcVideoSenders[userId] = sender;
    else if (t.kind === "audio") rtcAudioSenders[userId] = sender;
  });

  // onnegotiationneeded fires automatically when tracks are added/removed —
  // no need to call rtcNegotiate manually anywhere.
  pc.onnegotiationneeded = async () => {
    if (pc.signalingState !== "stable") return;
    try {
      pc._makingOffer = true;
      const offer = await pc.createOffer();
      if (pc.signalingState !== "stable") return; // re-check after async gap
      await pc.setLocalDescription(offer);
      convWs?.readyState === WebSocket.OPEN && convWs.send(JSON.stringify({
        type: "webrtc_offer", target_id: userId,
        sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
      }));
    } catch (e) { console.error("[WebRTC] negotiate:", e); }
    finally { pc._makingOffer = false; }
  };

  pc.ontrack = ({ track }) => {
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

  return pc;
}

async function rtcHandleOffer(fromId, sdp) {
  let pc = rtcPeers[fromId];
  if (!pc) pc = rtcCreatePeer(fromId);

  // Polite = joiner (!convIsHost); impolite = host.
  // Collision: we already sent an offer that hasn't been answered yet.
  const polite    = !convIsHost;
  const collision = pc._makingOffer || pc.signalingState !== "stable";

  if (!polite && collision) return; // impolite peer drops the colliding offer

  try {
    // Polite peer: setRemoteDescription auto-rolls back the pending local offer
    // (implicit rollback — Chrome 80+, Firefox 75+, Safari 14.1+).
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
  // Remote video goes directly into the participant's carousel card video box
  const vid = document.getElementById(`conv-card-vid-${userId}`);
  const ph  = document.getElementById(`conv-card-ph-${userId}`);
  if (!vid) return;

  const _bind = () => {
    // Always re-create the MediaStream so the video element gets a fresh
    // decode pipeline. Safari/iOS otherwise leaves the element in a paused
    // state after the sender pauses (replaceTrack(null)) and resumes.
    vid.srcObject = new MediaStream([track]);
    vid.style.display = "block";
    if (ph) ph.style.display = "none";
    vid.play().catch(() => {});
  };

  _bind();

  // Zoom-style: when the broadcaster turns camera OFF (replaceTrack(null)
  // mutes the track), participants see the initials placeholder. When the
  // broadcaster turns camera ON again (replaceTrack(newTrack) unmutes),
  // the live video replaces the placeholder.
  track.onunmute = _bind;
  track.onmute = () => {
    vid.style.display = "none";
    if (ph) ph.style.display = "";
  };
}

function convUpdateCaption(userId, text, isFinal) {
  const el = document.getElementById(`conv-caption-${userId}`);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("final", isFinal);
  if (isFinal) {
    clearTimeout(el._clearTimer);
    el._clearTimer = setTimeout(() => { el.textContent = ""; }, 4000);
  }
}

function rtcPlayRemoteAudio(userId, track) {
  // Raw WebRTC audio is intentionally suppressed.
  // Each listener hears a TTS voice in their own language instead, driven by
  // the translated text that arrives via the anti-hallucination pipeline.
  // We accept the track so the peer connection stays healthy, but never route
  // it to a speaker.
  rtcAudioSources[userId]?.disconnect();
  delete rtcAudioSources[userId];
}

function rtcRemoveRemote(userId) {
  const vid = document.getElementById(`conv-card-vid-${userId}`);
  const ph  = document.getElementById(`conv-card-ph-${userId}`);
  if (vid) { vid.srcObject = null; vid.style.display = ""; }
  if (ph)  ph.style.display = "";
  rtcAudioSources[userId]?.disconnect();
  delete rtcAudioSources[userId];
}

async function webrtcStartAudio() {
  if (rtcAudioTrack) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    rtcAudioTrack = s.getAudioTracks()[0];
    // Voice-clone enrollment from the live audio stream — best-effort, no-op
    // if already enrolled or the server doesn't support cloning.
    convVoiceCloneEnroll(s);
    for (const [uid, pc] of Object.entries(rtcPeers)) {
      let sender = rtcAudioSenders[uid];
      if (sender) {
        sender.replaceTrack(rtcAudioTrack);
      } else {
        sender = pc.addTrack(rtcAudioTrack);
        rtcAudioSenders[uid] = sender;
      }
    }
    Object.keys(convUsers).filter(uid => uid !== convUserId && !rtcPeers[uid])
      .forEach(uid => rtcCreatePeer(uid)); // onnegotiationneeded fires when track added
  } catch (e) {
    console.error("[WebRTC] audio start:", e);
    if (e.name === "NotAllowedError" && _isSafari) {
      convStopListening();
      alert(
        "Safari mic conflict:\n\n" +
        "Safari allows only ONE tab to use the mic at a time.\n" +
        "Another tab in this Safari window already holds the mic.\n\n" +
        "► Use Chrome or Firefox to test multiple participants in separate tabs.\n" +
        "► On real devices (separate phones/computers) this is not a problem."
      );
    }
  }
}

function webrtcStopAudio() {
  if (!rtcAudioTrack) return;
  rtcAudioTrack.stop();
  rtcAudioTrack = null;
  // Same pause-by-replaceTrack pattern as video so re-enabling the mic
  // doesn't accumulate duplicate senders.
  for (const sender of Object.values(rtcAudioSenders)) {
    try { sender.replaceTrack(null); } catch {}
  }
}

function webrtcStartVideo(stream) {
  const vt = stream.getVideoTracks()[0];
  if (!vt) return;
  rtcVideoTrack = vt;
  for (const [uid, pc] of Object.entries(rtcPeers)) {
    let sender = rtcVideoSenders[uid];
    if (sender) {
      sender.replaceTrack(vt); // resume: no renegotiation needed
    } else {
      sender = pc.addTrack(vt); // first time for this peer — triggers onnegotiationneeded
      rtcVideoSenders[uid] = sender;
    }
  }
  Object.keys(convUsers).filter(uid => uid !== convUserId && !rtcPeers[uid])
    .forEach(uid => rtcCreatePeer(uid));
}

function webrtcStopVideo() {
  rtcVideoTrack = null;
  // Pause by clearing the track but keep the sender so re-opening the camera
  // reuses the same m-line and doesn't add a duplicate sender. Without this,
  // the second open created a phantom sender and remote peers saw blank video.
  for (const sender of Object.values(rtcVideoSenders)) {
    try { sender.replaceTrack(null); } catch {}
  }
}

function webrtcOnUserJoined(userId) {
  if (rtcAudioTrack || rtcVideoTrack) rtcCreatePeer(userId);
}

function webrtcOnUserLeft(userId) {
  rtcPeers[userId]?.close();
  delete rtcPeers[userId];
  delete rtcVideoSenders[userId];
  delete rtcAudioSenders[userId];
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
  rtcVideoSenders = {};
  rtcAudioSenders = {};
}

// ── Enterprise Vocabulary Manager ─────────────────────────────────────────────
// Provides CRUD on /api/v1/vocabulary and renders a management modal inside
// the conversation view.  The backend applies vocabulary entries automatically
// to every translation; this panel lets the host add/edit/remove terms live.

let _vocabEditId = null;  // non-null when the form is in edit mode

const vocabModal       = document.getElementById("vocabModal");
const vocabClose       = document.getElementById("vocabClose");
const vocabTerm        = document.getElementById("vocabTerm");
const vocabLang        = document.getElementById("vocabLang");
const vocabDef         = document.getElementById("vocabDef");
const vocabVariants    = document.getElementById("vocabVariants");
const vocabDomain      = document.getElementById("vocabDomain");
const vocabSaveBtn     = document.getElementById("vocabSaveBtn");
const vocabSaveBtnLabel = document.getElementById("vocabSaveBtnLabel");
const vocabCancelEditBtn = document.getElementById("vocabCancelEditBtn");
const vocabBulkBtn     = document.getElementById("vocabBulkBtn");
const vocabBulkArea    = document.getElementById("vocabBulkArea");
const vocabBulkJson    = document.getElementById("vocabBulkJson");
const vocabBulkImportBtn = document.getElementById("vocabBulkImportBtn");
const vocabBulkCancelBtn = document.getElementById("vocabBulkCancelBtn");
const vocabList        = document.getElementById("vocabList");
const vocabEmpty       = document.getElementById("vocabEmpty");
const vocabCountBadge  = document.getElementById("vocabCountBadge");
const convVocabBtn     = document.getElementById("convVocabBtn");
const convVocabBadge   = document.getElementById("convVocabBadge");

async function vocabFetchAll() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/vocabulary`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.entries || [];
  } catch { return []; }
}

function vocabUpdateBadge(count) {
  if (vocabCountBadge) vocabCountBadge.textContent = count;
  if (convVocabBadge) {
    convVocabBadge.textContent = count;
    convVocabBadge.style.display = count > 0 ? "flex" : "none";
  }
}

function vocabRenderList(entries) {
  if (!vocabList) return;
  while (vocabList.firstChild) vocabList.removeChild(vocabList.firstChild);
  if (!entries.length) {
    const emp = document.createElement("div");
    emp.className = "vocab-empty";
    emp.textContent = "No terms yet. Add your first enterprise term above.";
    vocabList.appendChild(emp);
    vocabUpdateBadge(0);
    return;
  }
  vocabUpdateBadge(entries.length);
  entries.forEach(entry => {
    const row = document.createElement("div");
    row.className = "vocab-entry";
    row.dataset.id = entry.id;

    const body = document.createElement("div");
    body.className = "vocab-entry-body";

    const termLine = document.createElement("div");
    termLine.className = "vocab-entry-term";
    termLine.textContent = entry.term;

    const langBadge = document.createElement("span");
    langBadge.className = "vocab-entry-lang";
    langBadge.textContent = entry.language.toUpperCase();
    termLine.appendChild(langBadge);

    if (entry.domain) {
      const domBadge = document.createElement("span");
      domBadge.className = "vocab-entry-domain";
      domBadge.textContent = entry.domain;
      termLine.appendChild(domBadge);
    }

    const def = document.createElement("div");
    def.className = "vocab-entry-def";
    def.textContent = entry.definition;

    body.appendChild(termLine);
    body.appendChild(def);

    if (entry.variants?.length) {
      const v = document.createElement("div");
      v.className = "vocab-entry-variants";
      v.textContent = "Also: " + entry.variants.join(", ");
      body.appendChild(v);
    }

    const actions = document.createElement("div");
    actions.className = "vocab-entry-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "vocab-action-btn";
    editBtn.title = "Edit";
    editBtn.innerHTML = '<svg data-lucide="pencil"></svg>';
    editBtn.addEventListener("click", () => vocabStartEdit(entry));

    const delBtn = document.createElement("button");
    delBtn.className = "vocab-action-btn delete";
    delBtn.title = "Delete";
    delBtn.innerHTML = '<svg data-lucide="trash-2"></svg>';
    delBtn.addEventListener("click", () => vocabDelete(entry.id));

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    row.appendChild(body);
    row.appendChild(actions);
    vocabList.appendChild(row);
  });
  lucide.createIcons({ nodes: Array.from(vocabList.querySelectorAll("[data-lucide]")) });
}

function vocabClearForm() {
  _vocabEditId = null;
  if (vocabTerm) vocabTerm.value = "";
  if (vocabLang) vocabLang.value = "en";
  if (vocabDef) vocabDef.value = "";
  if (vocabVariants) vocabVariants.value = "";
  if (vocabDomain) vocabDomain.value = "";
  if (vocabSaveBtnLabel) vocabSaveBtnLabel.textContent = "Add Term";
  if (vocabCancelEditBtn) vocabCancelEditBtn.style.display = "none";
}

function vocabStartEdit(entry) {
  _vocabEditId = entry.id;
  if (vocabTerm) vocabTerm.value = entry.term;
  if (vocabLang) vocabLang.value = entry.language || "en";
  if (vocabDef) vocabDef.value = entry.definition;
  if (vocabVariants) vocabVariants.value = (entry.variants || []).join(", ");
  if (vocabDomain) vocabDomain.value = entry.domain || "";
  if (vocabSaveBtnLabel) vocabSaveBtnLabel.textContent = "Save Changes";
  if (vocabCancelEditBtn) vocabCancelEditBtn.style.display = "inline-flex";
  vocabTerm?.focus();
}

async function vocabSave() {
  const term = vocabTerm?.value.trim();
  const def  = vocabDef?.value.trim();
  if (!term || !def) { alert("Term and definition are required."); return; }

  const variants = (vocabVariants?.value || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const payload = {
    term,
    definition: def,
    language: vocabLang?.value || "en",
    variants,
    domain: vocabDomain?.value.trim() || "",
    translations: {},
  };

  try {
    let res;
    if (_vocabEditId) {
      res = await fetch(`${API_BASE}/api/v1/vocabulary/${_vocabEditId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      res = await fetch(`${API_BASE}/api/v1/vocabulary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    vocabClearForm();
    await vocabRefresh();
  } catch (e) {
    alert("Save failed: " + e.message);
  }
}

async function vocabDelete(id) {
  if (!confirm("Delete this vocabulary entry?")) return;
  try {
    const res = await fetch(`${API_BASE}/api/v1/vocabulary/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await vocabRefresh();
  } catch (e) {
    alert("Delete failed: " + e.message);
  }
}

async function vocabRefresh() {
  const entries = await vocabFetchAll();
  vocabRenderList(entries);
}

async function vocabBulkImport() {
  const raw = vocabBulkJson?.value.trim();
  if (!raw) return;
  let rows;
  try { rows = JSON.parse(raw); }
  catch { alert("Invalid JSON. Expected an array of objects."); return; }
  if (!Array.isArray(rows)) { alert("JSON must be an array."); return; }
  try {
    const res = await fetch(`${API_BASE}/api/v1/vocabulary/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (vocabBulkArea) vocabBulkArea.style.display = "none";
    if (vocabBulkJson) vocabBulkJson.value = "";
    await vocabRefresh();
    alert(`Imported ${data.added} entries.`);
  } catch (e) {
    alert("Bulk import failed: " + e.message);
  }
}

async function vocabOpen() {
  if (!vocabModal) return;
  vocabClearForm();
  if (vocabBulkArea) vocabBulkArea.style.display = "none";
  vocabModal.style.display = "flex";
  await vocabRefresh();
}

// Wiring
vocabClose?.addEventListener("click", () => {
  if (vocabModal) vocabModal.style.display = "none";
  vocabClearForm();
});
vocabModal?.addEventListener("click", e => {
  if (e.target === vocabModal) {
    vocabModal.style.display = "none";
    vocabClearForm();
  }
});
vocabSaveBtn?.addEventListener("click", vocabSave);
vocabCancelEditBtn?.addEventListener("click", vocabClearForm);
vocabBulkBtn?.addEventListener("click", () => {
  if (vocabBulkArea) vocabBulkArea.style.display = vocabBulkArea.style.display === "none" ? "flex" : "none";
});
vocabBulkImportBtn?.addEventListener("click", vocabBulkImport);
vocabBulkCancelBtn?.addEventListener("click", () => {
  if (vocabBulkArea) vocabBulkArea.style.display = "none";
  if (vocabBulkJson) vocabBulkJson.value = "";
});
convVocabBtn?.addEventListener("click", vocabOpen);

// Allow Enter in term/def fields to submit
vocabTerm?.addEventListener("keydown", e => { if (e.key === "Enter") vocabSave(); });
vocabDef?.addEventListener("keydown",  e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); vocabSave(); } });
