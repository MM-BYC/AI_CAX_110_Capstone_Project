const API_BASE = "http://127.0.0.1:8000";

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
const audioDetectedLang = document.getElementById("audioDetectedLang");
const audioCopyBtn      = document.getElementById("audioCopyBtn");

// Tab elements
const tabText  = document.getElementById("tabText");
const tabAudio = document.getElementById("tabAudio");
const textTab  = document.getElementById("textTab");
const audioTab = document.getElementById("audioTab");

const spinner = document.getElementById("spinner");

// Language code → display name map
const LANG_NAMES = {
  en: "English", es: "Spanish", fr: "French", de: "German",
  it: "Italian", pt: "Portuguese", zh: "Chinese", ja: "Japanese",
  ko: "Korean", ar: "Arabic", ru: "Russian", hi: "Hindi",
  nl: "Dutch", pl: "Polish", tr: "Turkish", tl: "Tagalog"
};

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
tabText.addEventListener("click", () => {
  tabText.classList.add("active");
  tabAudio.classList.remove("active");
  textTab.style.display = "block";
  audioTab.style.display = "none";
});

tabAudio.addEventListener("click", () => {
  tabAudio.classList.add("active");
  tabText.classList.remove("active");
  audioTab.style.display = "block";
  textTab.style.display = "none";
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

  const sav_enter_text_to_translate = inputText.value;
  const sav_target_language         = textTargetLang.value;
  const sav_translation             = outputBox.querySelector(".placeholder") ? "" : outputBox.textContent.trim();

  // Apply swap: each field receives its counterpart's saved value
  textSourceLang.value = sav_target_language;
  resetTextDetectOption();
  inputText.value      = sav_translation;
  updateCharCount(sav_translation.length);
  textTargetLang.value = sav_detect_language;
  clearTimeout(translateTimer);
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

  showSpinner(true);

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
      const heard = words.filter(w => w.start <= t).map(w => w.word).join("");
      audioTranscript.value = heard;
      audioTranscript.scrollTop = audioTranscript.scrollHeight;
    };

    audioPlayer.play();

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
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
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
    audioCopyBtn.textContent = "Copied!";
    setTimeout(() => { audioCopyBtn.textContent = "Copy"; }, 1500);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────
function setOutput(translation) {
  if (translation) {
    outputBox.textContent = translation;
    copyBtn.style.display = "inline-block";
  } else {
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

function showSpinner(visible) {
  spinner.style.display = visible ? "flex" : "none";
}
