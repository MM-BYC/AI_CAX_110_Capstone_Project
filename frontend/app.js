const API_BASE = "http://127.0.0.1:8000";

const sourceLang    = document.getElementById("sourceLanguage");
const targetLang    = document.getElementById("targetLanguage");
const inputText     = document.getElementById("inputText");
const outputBox     = document.getElementById("outputText");
const charCount     = document.getElementById("charCount");
const detectedLang  = document.getElementById("detectedLang");
const translateBtn  = document.getElementById("translateBtn");
const copyBtn       = document.getElementById("copyBtn");
const swapBtn       = document.getElementById("swapBtn");
const spinner       = document.getElementById("spinner");

// Audio elements
const audioFile          = document.getElementById("audioFile");
const translateAudioBtn  = document.getElementById("translateAudioBtn");
const audioResult        = document.getElementById("audioResult");
const transcribedText    = document.getElementById("transcribedText");
const audioDetected      = document.getElementById("audioDetected");
const audioTranslation   = document.getElementById("audioTranslation");

// Language code → display name map
const LANG_NAMES = {
  en: "English", es: "Spanish", fr: "French", de: "German",
  it: "Italian", pt: "Portuguese", zh: "Chinese", ja: "Japanese",
  ko: "Korean", ar: "Arabic", ru: "Russian", hi: "Hindi",
  nl: "Dutch", pl: "Polish", tr: "Turkish"
};

// ── Character counter ──────────────────────────────────────────────────────
inputText.addEventListener("input", () => {
  const len = inputText.value.length;
  charCount.textContent = `${len} character${len !== 1 ? "s" : ""}`;
});

// ── Swap languages ─────────────────────────────────────────────────────────
swapBtn.addEventListener("click", () => {
  const tmp = sourceLang.value;
  sourceLang.value = targetLang.value;
  targetLang.value = tmp;
  // Also swap text if a translation is already shown
  const outContent = outputBox.querySelector(".placeholder")
    ? ""
    : outputBox.textContent.trim();
  if (outContent) {
    inputText.value = outContent;
    inputText.dispatchEvent(new Event("input"));
    setOutput("", "");
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
      source: sourceLang.value,
      target: targetLang.value,
      text
    });

    const res = await fetch(`${API_BASE}/translate_text`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });

    // FastAPI reads query params from the URL for POST with query string
    const res2 = await fetch(`${API_BASE}/translate_text?${params.toString()}`, {
      method: "POST"
    });

    if (!res2.ok) {
      const err = await res2.json().catch(() => ({ detail: "Unknown error" }));
      throw new Error(err.detail || `HTTP ${res2.status}`);
    }

    const data = await res2.json();
    const langName = LANG_NAMES[data.detected_language] ?? data.detected_language;
    setOutput(data.translation, `Detected: ${langName}`);
  } catch (err) {
    setOutput(`Error: ${err.message}`, "");
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
      source: sourceLang.value,
      target: targetLang.value
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

    transcribedText.textContent  = data.original_text;
    audioDetected.textContent    = langName;
    audioTranslation.textContent = data.translation;
    audioResult.style.display    = "flex";
  } catch (err) {
    transcribedText.textContent  = `Error: ${err.message}`;
    audioDetected.textContent    = "";
    audioTranslation.textContent = "";
    audioResult.style.display    = "flex";
  } finally {
    showSpinner(false);
    translateAudioBtn.disabled = false;
  }
});

// ── Copy button ────────────────────────────────────────────────────────────
copyBtn.addEventListener("click", () => {
  const text = outputBox.textContent.trim();
  navigator.clipboard.writeText(text).then(() => {
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────
function setOutput(translation, detected) {
  if (translation) {
    outputBox.textContent = translation;
    copyBtn.style.display = "inline-block";
  } else {
    outputBox.innerHTML = '<span class="placeholder">Translation will appear here...</span>';
    copyBtn.style.display = "none";
  }
  detectedLang.textContent = detected;
}

function showSpinner(visible) {
  spinner.style.display = visible ? "flex" : "none";
}
