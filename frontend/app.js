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
const audioSourceLang   = document.getElementById("audioSourceLang");
const audioTargetLang   = document.getElementById("audioTargetLang");
const audioFile         = document.getElementById("audioFile");
const dropZone          = document.getElementById("dropZone");
const dropFileName      = document.getElementById("dropFileName");
const audioPlayer       = document.getElementById("audioPlayer");
const audioTranscript   = document.getElementById("audioTranscript");
const audioOutputBox    = document.getElementById("audioOutputText");
// audioDetectedLang element removed from HTML — not used
const audioCopyBtn      = document.getElementById("audioCopyBtn");

// Tab elements
const tabText  = document.getElementById("tabText");
const tabAudio = document.getElementById("tabAudio");
const tabLive  = document.getElementById("tabLive");
const textTab  = document.getElementById("textTab");
const audioTab = document.getElementById("audioTab");
const liveTab  = document.getElementById("liveTab");

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
  [tabText, tabAudio, tabLive].forEach(t => t.classList.remove("active"));
  [textTab, audioTab, liveTab].forEach(t => { t.style.display = "none"; });
  active.btn.classList.add("active");
  active.panel.style.display = "block";
  // Stop mic if leaving live tab
  if (active.btn !== tabLive && isListening) stopListening();
}

tabText.addEventListener("click",  () => showTab({ btn: tabText,  panel: textTab }));
tabAudio.addEventListener("click", () => showTab({ btn: tabAudio, panel: audioTab }));
tabLive.addEventListener("click",  () => showTab({ btn: tabLive,  panel: liveTab }));

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
  } catch (err) {
    setAudioOutput(`Error: ${err.message}`);
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

let recognition   = null;
let isListening   = false;
let finalText     = "";
let liveXlateTimer = null;

function startListening() {
  if (!SpeechRecognition) {
    liveStatus.textContent = "Speech recognition not supported — use Chrome or Edge";
    return;
  }

  finalText = "";
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
    liveTranscript.innerHTML =
      (finalText || "") +
      (interim ? `<span class="interim">${interim}</span>` : "");
    liveCopyBtn.style.display = finalText.trim() ? "inline-block" : "none";
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
}

micBtn.addEventListener("click", () => {
  isListening ? stopListening() : startListening();
});

liveResetBtn.addEventListener("click", () => {
  stopListening();
  finalText = "";
  clearTimeout(liveXlateTimer);
  liveTranscript.innerHTML = '<span class="placeholder">Your speech will appear here…</span>';
  liveOutputText.innerHTML = '<span class="placeholder">Translation will appear here…</span>';
  liveCopyBtn.style.display = "none";
  liveTranslationCopyBtn.style.display = "none";
  liveStatus.textContent = "Click the mic to start listening";
});

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
