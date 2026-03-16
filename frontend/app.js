const API_BASE = "http://127.0.0.1:8000";

// Text tab elements
const textSourceLang = document.getElementById("textSourceLang");
const textTargetLang = document.getElementById("textTargetLang");
const inputText      = document.getElementById("inputText");
const outputBox      = document.getElementById("outputText");
const charCount      = document.getElementById("charCount");
const translateBtn   = document.getElementById("translateBtn");
const copyBtn        = document.getElementById("copyBtn");
const textSwapBtn    = document.getElementById("textSwapBtn");

// Audio tab elements
const audioSourceLang   = document.getElementById("audioSourceLang");
const audioTargetLang   = document.getElementById("audioTargetLang");
const audioFile         = document.getElementById("audioFile");
const dropZone          = document.getElementById("dropZone");
const dropFileName      = document.getElementById("dropFileName");
const translateAudioBtn = document.getElementById("translateAudioBtn");
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

audioFile.addEventListener("change", () => showFileName(audioFile.files[0]));

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
    const name = LANG_NAMES[data.detected_language] ?? data.detected_language;
    const detectOpt = textSourceLang.querySelector('option[value="auto"]');
    if (detectOpt) detectOpt.textContent = `Detected: ${name}`;
  } catch (_) {}
}

function resetTextDetectOption() {
  const detectOpt = textSourceLang.querySelector('option[value="auto"]');
  if (detectOpt) detectOpt.textContent = "Detect Language";
}

// ── Character counter + live detection ─────────────────────────────────────
inputText.addEventListener("input", () => {
  const len = inputText.value.length;
  charCount.textContent = `${len} character${len !== 1 ? "s" : ""}`;
  clearTimeout(detectTimer);
  if (len > 1 && textSourceLang.value === "auto") {
    detectTimer = setTimeout(() => detectAndShowLanguage(inputText.value), 50);
  } else if (len <= 1) {
    resetTextDetectOption();
  }
});

textSourceLang.addEventListener("change", () => {
  if (textSourceLang.value !== "auto") resetTextDetectOption();
});

// ── Swap languages (Text tab) ───────────────────────────────────────────────
textSwapBtn.addEventListener("click", () => {
  if (textSourceLang.value === "auto") return; // can't swap detect
  const tmp = textSourceLang.value;
  textSourceLang.value = textTargetLang.value;
  textTargetLang.value = tmp;
  const outContent = outputBox.querySelector(".placeholder") ? "" : outputBox.textContent.trim();
  if (outContent) {
    inputText.value = outContent;
    inputText.dispatchEvent(new Event("input"));
    setOutput("");
  }
});

// ── Text translation ───────────────────────────────────────────────────────
translateBtn.addEventListener("click", async () => {
  const text = inputText.value.trim();
  if (!text) return;

  showSpinner(true);
  translateBtn.disabled = true;

  try {
    const params = new URLSearchParams({
      source: textSourceLang.value === "auto" ? "en" : textSourceLang.value,
      target: textTargetLang.value,
      text
    });

    const res = await fetch(`${API_BASE}/translate_text?${params.toString()}`, { method: "POST" });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "Unknown error" }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const data = await res.json();
    const langName = LANG_NAMES[data.detected_language] ?? data.detected_language;

    if (textSourceLang.value === "auto") {
      const detectOpt = textSourceLang.querySelector('option[value="auto"]');
      if (detectOpt) detectOpt.textContent = `Detected: ${langName}`;
    }

    setOutput(data.translation);
  } catch (err) {
    setOutput(`Error: ${err.message}`);
  } finally {
    showSpinner(false);
    translateBtn.disabled = false;
  }
});

// ── Audio translation ──────────────────────────────────────────────────────
translateAudioBtn.addEventListener("click", async () => {
  const file = audioFile.files[0];
  if (!file) {
    alert("Please select an audio file first.");
    return;
  }

  showSpinner(true);
  translateAudioBtn.disabled = true;

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
    const langName = LANG_NAMES[data.detected_language] ?? data.detected_language;

    // Update audio source dropdown only
    if (audioSourceLang.value === "auto") {
      const detectOpt = audioSourceLang.querySelector('option[value="auto"]');
      if (detectOpt) detectOpt.textContent = `Detected: ${langName}`;
    }

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
    translateAudioBtn.disabled = false;
  }
});

// ── Copy buttons ───────────────────────────────────────────────────────────
copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(outputBox.textContent.trim()).then(() => {
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
  });
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
