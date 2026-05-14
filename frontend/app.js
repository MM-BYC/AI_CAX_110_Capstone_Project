// In production the frontend is served by FastAPI itself, so use a same-origin
// (relative) base. In local dev the static server runs on :3000 and needs to
// hit the backend on :8000 explicitly.
const API_BASE =
  window.location.port === "3000" || window.location.protocol === "file:"
    ? `http://${window.location.hostname}:8000`
    : "";

// Safari only allows one tab at a time to hold the microphone.
const _isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
// iOS Safari does not support webkitSpeechRecognition reliably — use MediaRecorder instead.
const _isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

function updateCopyrightYear() {
  const text = `© ${new Date().getFullYear()} AI Translate. All rights reserved.`;
  document.querySelectorAll("#copyright, #landingCopyright").forEach((el) => {
    el.textContent = text;
  });
}

updateCopyrightYear();

const defaultPricing = {
  currency: "USD",
  monthly_price: 7.99,
  yearly_price: 79,
  trial_days: 3,
};
let currentPricing = { ...defaultPricing };

function formatPrice(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "$0";
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function updatePricingDisplay() {
  const trialEl = document.getElementById("trialPrice");
  const monthlyEl = document.getElementById("monthlyPrice");
  const annualEl = document.getElementById("annualPrice");
  if (trialEl) trialEl.textContent = `${currentPricing.trial_days || 3} Days`;
  if (monthlyEl) {
    monthlyEl.innerHTML = `${formatPrice(currentPricing.monthly_price)}<span>/mo</span>`;
  }
  if (annualEl) {
    annualEl.innerHTML = `${formatPrice(currentPricing.yearly_price)}<span>/yr</span>`;
  }
}

async function loadPricing() {
  try {
    const res = await fetch(`${API_BASE}/api/pricing`, { cache: "no-store" });
    if (!res.ok) throw new Error("Pricing unavailable");
    currentPricing = { ...defaultPricing, ...(await res.json()) };
    updatePricingDisplay();
  } catch (e) {
    console.warn("Using default pricing", e);
  }
}

// Text tab elements
const textSourceLang = document.getElementById("textSourceLang");
const textTargetLang = document.getElementById("textTargetLang");
const inputText = document.getElementById("inputText");
const outputBox = document.getElementById("outputText");
const charCount = document.getElementById("charCount");
const copyBtn = document.getElementById("copyBtn");
const textSwapBtn = document.getElementById("textSwapBtn");

// Audio tab elements
const audioSourceLang = document.getElementById("audioSourceLang");
const audioTargetLang = document.getElementById("audioTargetLang");
const audioFile = document.getElementById("audioFile");
const dropZone = document.getElementById("dropZone");
const dropFileName = document.getElementById("dropFileName");
const audioPlayer = document.getElementById("audioPlayer");
const audioTranscript = document.getElementById("audioTranscript");
const audioOutputBox = document.getElementById("audioOutputText");
const audioQualityBadge = document.getElementById("audioQualityBadge");
const audioQualityCritique = document.getElementById("audioQualityCritique");
// audioDetectedLang element removed from HTML — not used
const audioCopyBtn = document.getElementById("audioCopyBtn");

// Tab elements
const tabText = document.getElementById("tabText");
const tabAudio = document.getElementById("tabAudio");
const tabLive = document.getElementById("tabLive");
const tabConv = document.getElementById("tabConv");
const convAdminBtn = document.getElementById("convAdminBtn");
const textTab = document.getElementById("textTab");
const audioTab = document.getElementById("audioTab");
const liveTab = document.getElementById("liveTab");
const convTab = document.getElementById("convTab");
const adminTab = document.getElementById("adminTab");

// Live tab elements
const liveSourceLang = document.getElementById("liveSourceLang");
const liveTargetLang = document.getElementById("liveTargetLang");
const micBtn = document.getElementById("micBtn");
const liveStatus = document.getElementById("liveStatus");
const liveTranscript = document.getElementById("liveTranscript");
const liveOutputText = document.getElementById("liveOutputText");
const liveCopyBtn = document.getElementById("liveCopyBtn");
const liveTranslationCopyBtn = document.getElementById(
  "liveTranslationCopyBtn",
);
const liveResetBtn = document.getElementById("liveResetBtn");

const spinner = document.getElementById("spinner");

// Language code → display name map
const LANG_NAMES = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ar: "Arabic",
  ru: "Russian",
  hi: "Hindi",
  nl: "Dutch",
  pl: "Polish",
  tr: "Turkish",
  tl: "Tagalog",
};

// ── Block file drops everywhere except the audio drop zone ─────────────────
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
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

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () =>
  dropZone.classList.remove("drag-over"),
);

dropZone.addEventListener("drop", (e) => {
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
  [tabText, tabAudio, tabLive, tabConv, convAdminBtn].forEach((t) =>
    t?.classList.remove("active"),
  );
  [textTab, audioTab, liveTab, convTab, adminTab].forEach((t) => {
    if (t) t.style.display = "none";
  });
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
const tabMenuWrap = document.getElementById("tabMenuWrap");

function setMenuOpen(open) {
  if (!hamburgerBtn || !tabMenuWrap) return;
  tabMenuWrap.classList.toggle("open", open);
  hamburgerBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

hamburgerBtn?.addEventListener("click", () => {
  const isOpen = tabMenuWrap.classList.contains("open");
  setMenuOpen(!isOpen);
});

const _selectTab = (active) => {
  showTab(active);
};
tabText.addEventListener("click", () =>
  _selectTab({ btn: tabText, panel: textTab }),
);
tabAudio.addEventListener("click", () =>
  _selectTab({ btn: tabAudio, panel: audioTab }),
);
tabLive.addEventListener("click", () =>
  _selectTab({ btn: tabLive, panel: liveTab }),
);
tabConv.addEventListener("click", () =>
  _selectTab({ btn: tabConv, panel: convTab }),
);


// ── Authentication Management ──────────────────────────────────────────────
const AUTH_STORAGE_KEYS = [
  "auth_email",
  "auth_token",
  "auth_first_name",
  "auth_last_name",
  "auth_trial_ends_at",
  "auth_is_subscriber",
];

// Clear old persistent auth from earlier builds. Auth is now tab-session scoped.
AUTH_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));

let currentUserEmail = sessionStorage.getItem("auth_email") || null;
let currentUserToken = sessionStorage.getItem("auth_token") || null;
let currentUserFirstName = sessionStorage.getItem("auth_first_name") || "";
let currentUserLastName = sessionStorage.getItem("auth_last_name") || "";
let currentUserTrialEndsAt = Number(sessionStorage.getItem("auth_trial_ends_at")) || null;
let currentUserIsSubscriber = sessionStorage.getItem("auth_is_subscriber") === "true";
let trialTimerIntervalId = null;
let _browserSessionEnding = false;

function persistAuthSession(data) {
  _browserSessionEnding = false;
  currentUserEmail = data.email;
  currentUserToken = data.access_token;
  currentUserFirstName = data.first_name || "";
  currentUserLastName = data.last_name || "";
  currentUserTrialEndsAt = Number(data.trial_ends_at) || null;
  currentUserIsSubscriber = Boolean(data.is_subscriber);
  sessionStorage.setItem("auth_email", currentUserEmail);
  sessionStorage.setItem("auth_token", currentUserToken);
  sessionStorage.setItem("auth_first_name", currentUserFirstName);
  sessionStorage.setItem("auth_last_name", currentUserLastName);
  if (currentUserTrialEndsAt) {
    sessionStorage.setItem("auth_trial_ends_at", String(currentUserTrialEndsAt));
  } else {
    sessionStorage.removeItem("auth_trial_ends_at");
  }
  sessionStorage.setItem("auth_is_subscriber", String(currentUserIsSubscriber));
}

function clearAuthSession() {
  sessionStorage.clear();
  AUTH_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
  currentUserEmail = null;
  currentUserToken = null;
  currentUserFirstName = "";
  currentUserLastName = "";
  currentUserTrialEndsAt = null;
  currentUserIsSubscriber = false;
  stopTrialTimer();
}

function sendConversationLeave() {
  if (convWs && convWs.readyState === WebSocket.OPEN) {
    try {
      convWs.send(JSON.stringify({ type: "leave" }));
    } catch {}
  }
}

function endBrowserSession({ showLogin = false, notifyRoom = false, reload = false } = {}) {
  if (_browserSessionEnding) return;
  _browserSessionEnding = true;
  try {
    if (notifyRoom) sendConversationLeave();
    clearAuthSession();
    if (typeof convReset === "function") convReset();
  } catch (err) {
    console.warn("Session cleanup failed during logout", err);
    clearAuthSession();
  } finally {
    updateAuthHeader();
    if (reload) {
      window.location.reload();
      return;
    }
    if (showLogin) showAuthModal("login");
  }
}

function logout() {
  endBrowserSession({ showLogin: true, notifyRoom: true, reload: true });
}

function prepareConversationPageExit() {
  // A refresh, tab close, or dropped mobile browser session is not a logout.
  // Do local media cleanup only; the server will mark this participant idle
  // from the WebSocket close while everyone else stays in the room.
  try {
    convStopListening();
    convStopIosMic();
    convStopCamera();
    livekitDisconnectVideo();
  } catch {}
}

function updateAuthHeader() {
  document.querySelectorAll(".app-logout-btn").forEach((btn) => {
    btn.style.display = currentUserToken ? "inline-flex" : "none";
    btn.onclick = logout;
  });
  updateTrialTimer();
  syncConversationNameField();
}

function stopTrialTimer() {
  if (trialTimerIntervalId) {
    clearInterval(trialTimerIntervalId);
    trialTimerIntervalId = null;
  }
}

function formatTrialTimeRemaining(msRemaining) {
  if (msRemaining <= 0) return "Trial ended";
  const totalMinutes = Math.ceil(msRemaining / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `Trial: ${days}d ${hours}h left`;
  if (hours > 0) return `Trial: ${hours}h ${minutes}m left`;
  return `Trial: ${minutes}m left`;
}

function updateTrialTimer() {
  const timer = document.getElementById("trialTimer");
  const text = document.getElementById("trialTimerText");
  if (!timer || !text) return;

  if (!currentUserToken || currentUserIsSubscriber || !currentUserTrialEndsAt) {
    timer.style.display = "none";
    stopTrialTimer();
    return;
  }

  const expiresAtMs = currentUserTrialEndsAt * 1000;
  const msRemaining = expiresAtMs - Date.now();
  text.textContent = formatTrialTimeRemaining(msRemaining);
  timer.classList.toggle("expired", msRemaining <= 0);
  timer.style.display = "inline-flex";

  if (!trialTimerIntervalId) {
    trialTimerIntervalId = setInterval(updateTrialTimer, 60000);
  }
}

function formatRoomCodeForDisplay(code) {
  const clean = String(code || "").replace(/\s+/g, "");
  if (/^\d{6}$/.test(clean)) return `${clean.slice(0, 3)} ${clean.slice(3)}`;
  return clean || "------";
}

function setConversationRoomCode(code) {
  if (!convRoomCode) return;
  const clean = String(code || "").replace(/\s+/g, "");
  convRoomCode.dataset.roomCode = clean;
  convRoomCode.textContent = formatRoomCodeForDisplay(clean);
}

function getConversationRoomCode() {
  const stored = convRoomCode?.dataset?.roomCode;
  return (stored || convRoomCode?.textContent || "").replace(/\s+/g, "").trim();
}

function routeToConversation() {
  if (typeof convReset === "function") convReset();
  if (convRoomInput) convRoomInput.value = "";
  setConversationRoomCode("");
  showTab({ btn: tabConv, panel: convTab });
  setMenuOpen(false);
  showWelcomeMessage();
}

function showWelcomeMessage() {
  const displayName = getAuthenticatedDisplayName();
  if (!displayName) return;
  const host = document.querySelector(".conv-setup-header");
  if (!host) return;
  let welcome = document.getElementById("accountWelcome");
  if (!welcome) {
    welcome = document.createElement("div");
    welcome.id = "accountWelcome";
    welcome.className = "account-welcome";
    host.appendChild(welcome);
  }
  welcome.textContent = `Welcome, ${displayName}`;
}

function getAuthenticatedDisplayName() {
  const fullName = [currentUserFirstName, currentUserLastName]
    .map((part) => (part || "").trim())
    .filter(Boolean)
    .join(" ");
  return (fullName || currentUserEmail || "").trim();
}

window.selectPlan = (card) => {
  document
    .querySelectorAll(".plan-card")
    .forEach((c) => c.classList.remove("selected"));
  card.classList.add("selected");

  const submitBtn = document.getElementById("authSubmit");
  if (submitBtn) {
    // Remove previous plan classes and apply the new one
    submitBtn.classList.remove("plan-trial", "plan-monthly", "plan-annual");
    if (card.classList.contains("trial")) submitBtn.classList.add("plan-trial");
    else if (card.classList.contains("monthly"))
      submitBtn.classList.add("plan-monthly");
    else if (card.classList.contains("annual"))
      submitBtn.classList.add("plan-annual");
  }
};

function getSelectedPlan() {
  const selected = document.querySelector(".plan-card.selected");
  if (!selected) return "trial";
  if (selected.classList.contains("annual")) return "annual";
  if (selected.classList.contains("monthly")) return "monthly";
  return "trial";
}

function getPlanLabel(plan) {
  if (plan === "annual") return "Annual";
  if (plan === "monthly") return "Monthly";
  return "Free Trial";
}

function showSignupModal(plan = "trial") {
  const overlay = document.getElementById("authOverlay");
  if (!overlay) return;

  overlay.innerHTML = `
    <div class="billing-shell signup-shell">
      <section class="auth-card billing-card" aria-label="Billing information">
        <div class="auth-header">
          <button type="button" class="billing-back-btn" id="billingBackBtn">
            <i data-lucide="arrow-left"></i>
            <span>Back</span>
          </button>
          <h2>Create your account</h2>
          <p>${getPlanLabel(plan)} plan selected. Your trial starts today. Payment information is skipped for testing.</p>
        </div>

        <div class="signup-panel">
          <h3>Account</h3>
          <div class="billing-grid">
            <div class="billing-row">
              <div class="auth-input-group">
                <label>First Name</label>
                <input type="text" id="signupFirstName" class="auth-input" placeholder="First name" autocomplete="given-name">
              </div>
              <div class="auth-input-group">
                <label>Last Name</label>
                <input type="text" id="signupLastName" class="auth-input" placeholder="Last name" autocomplete="family-name">
              </div>
            </div>
            <div class="auth-input-group">
              <label>Email Address</label>
              <input type="email" id="signupEmail" class="auth-input" placeholder="name@company.com" autocomplete="email">
            </div>
            <div class="auth-input-group">
              <label>Phone Number</label>
              <input type="tel" id="signupPhone" class="auth-input" placeholder="Optional: +1 (555) 000-0000" autocomplete="tel">
            </div>
            <div class="auth-input-group">
              <label>Password</label>
              <input type="password" id="signupPass" class="auth-input" placeholder="Password" autocomplete="new-password">
            </div>
            <div class="auth-input-group">
              <label>Confirm Password</label>
              <input type="password" id="signupPassConfirm" class="auth-input" placeholder="Confirm password" autocomplete="new-password">
            </div>
          </div>
        </div>

        <div class="signup-panel">
          <h3>Payment</h3>
          <div class="billing-grid">
            <div class="auth-input-group">
              <label>Cardholder Name</label>
              <input type="text" id="signupCardName" class="auth-input" placeholder="Name on card" autocomplete="cc-name">
            </div>
            <div class="auth-input-group">
              <label>Card Number</label>
              <input type="text" id="signupCardNumber" class="auth-input" placeholder="1234 5678 9012 3456" maxlength="19" inputmode="numeric" autocomplete="cc-number">
            </div>
            <div class="billing-row">
              <div class="auth-input-group">
                <label>Expiry</label>
                <input type="text" id="signupCardExpiry" class="auth-input" placeholder="MM / YY" maxlength="7" inputmode="numeric" autocomplete="cc-exp">
              </div>
              <div class="auth-input-group">
                <label>CVV</label>
                <input type="text" id="signupCardCvv" class="auth-input" placeholder="123" maxlength="4" inputmode="numeric" autocomplete="cc-csc">
              </div>
            </div>
          </div>
          <p style="font-size:0.72rem;color:#9ca3af;margin-top:0.5rem">This is a test flow. No charges will be made.</p>
        </div>

        <label class="billing-terms">
          <input type="checkbox" id="billingTerms">
          <span>I acknowledge this is a test trial signup. No real payment is processed in this testing flow.</span>
        </label>

        <button id="billingSubmit" class="btn btn-primary auth-submit">Create Account and Start Trial</button>
      </section>
    </div>
  `;

  lucide.createIcons({ nodes: [overlay] });

  document.getElementById("signupCardNumber").addEventListener("input", (e) => {
    const digits = e.target.value.replace(/\D/g, "").slice(0, 16);
    e.target.value = digits.replace(/(.{4})/g, "$1 ").trim();
  });
  document.getElementById("signupCardExpiry").addEventListener("input", (e) => {
    const digits = e.target.value.replace(/\D/g, "").slice(0, 4);
    e.target.value = digits.length > 2 ? digits.slice(0, 2) + " / " + digits.slice(2) : digits;
  });

  document.getElementById("billingBackBtn").onclick = () => showAuthModal("pricing");
  document.getElementById("billingSubmit").onclick = async () => {
    const firstName = document.getElementById("signupFirstName").value.trim();
    const lastName = document.getElementById("signupLastName").value.trim();
    const email = document.getElementById("signupEmail").value.trim();
    const phone = document.getElementById("signupPhone").value.trim();
    const password = document.getElementById("signupPass").value.trim();
    const passwordConfirm = document.getElementById("signupPassConfirm").value.trim();
    if (!firstName || !lastName || !email || !password) {
      alert("Please enter your first name, last name, email, and password");
      return;
    }
    if (password !== passwordConfirm) {
      alert("Passwords do not match");
      return;
    }
    if (!document.getElementById("billingTerms").checked) {
      alert("Please acknowledge the test trial terms");
      return;
    }

    const body = {
      first_name: firstName,
      last_name: lastName,
      email,
      password,
      phone,
      plan,
      accepted_terms: true,
      billing_address: {},
      payment_method: {
        type: "test_card",
        card_name: document.getElementById("signupCardName").value.trim(),
        card_number: document.getElementById("signupCardNumber").value.replace(/\s/g, ""),
        card_expiry: document.getElementById("signupCardExpiry").value.trim(),
        card_cvv: document.getElementById("signupCardCvv").value.trim(),
      },
    };

    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).detail || "Signup failed");

      const data = await res.json();
      persistAuthSession(data);
      updateAuthHeader();
      overlay.remove();
      routeToConversation();
    } catch (e) {
      alert(e.message);
    }
  };
}

function showAuthModal(mode = "login") {
  let overlay = document.getElementById("authOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "authOverlay";
    overlay.className = "auth-overlay";
    document.body.appendChild(overlay);
  }

  const normalizedMode = mode === "signup" ? "pricing" : mode;
  const isLogin = normalizedMode === "login";
  const isPricing = normalizedMode === "pricing";
  const isForgot = mode === "forgot";
  const isCancel = normalizedMode === "cancel";

  // ── Landing page (Zoom-style full-screen marketing page) ─────────────────
  if (normalizedMode === "landing") {
    overlay.innerHTML = `
      <div class="lp-wrap">
        <nav class="lp-topbar">
          <div class="lp-topbar-brand">
            <span class="landing-brand-mark"><i data-lucide="languages"></i></span>
            <span>AI Translate</span>
          </div>
          <div class="lp-topbar-actions">
            <button type="button" class="lp-signin-btn" onclick="showAuthModal('login')">Sign In</button>
            <button type="button" class="lp-cta-btn" onclick="showAuthModal('pricing')">Get Started Free</button>
          </div>
        </nav>

        <section class="lp-hero">
          <h1>Speak Live. One Room.<br>Real-Time Meetings,<br>Locally Translated.</h1>
          <p class="lp-hero-sub">AI-powered real-time translation across <strong>16 languages</strong>. Create secure rooms, invite anyone, and let everyone speak freely in their own language.</p>
          <div class="lp-hero-actions">
            <button type="button" class="lp-primary-btn" onclick="showAuthModal('pricing')">
              <i data-lucide="zap"></i>
              Get Started Free
            </button>
            <button type="button" class="lp-ghost-btn" onclick="showAuthModal('login')">
              Sign In
            </button>
          </div>
          <div class="lp-hero-badges">
            <span><i data-lucide="globe"></i> 16 Languages</span>
            <span><i data-lucide="clock"></i> Real-Time AI</span>
            <span><i data-lucide="shield"></i> Secure Rooms</span>
            <span><i data-lucide="smartphone"></i> No Downloads</span>
          </div>
        </section>

        <section class="lp-features">
          <h2 class="lp-section-title">Everything you need for multilingual meetings</h2>
          <div class="lp-feature-grid">
            <div class="lp-feat-card">
              <div class="lp-feat-icon"><i data-lucide="users"></i></div>
              <h3>Conversation Rooms</h3>
              <p>Create secure meeting rooms and invite participants. Everyone hears the conversation in their own language, in real time.</p>
            </div>
            <div class="lp-feat-card">
              <div class="lp-feat-icon"><i data-lucide="mic"></i></div>
              <h3>Live Speech Translation</h3>
              <p>Speak and see your words translated instantly. Google Cloud Speech captures voice, Groq AI translates at speed.</p>
            </div>
            <div class="lp-feat-card">
              <div class="lp-feat-icon"><i data-lucide="file-text"></i></div>
              <h3>Text Translation</h3>
              <p>Paste or type any text and get AI-quality translation with hallucination review across 16 language pairs.</p>
            </div>
            <div class="lp-feat-card">
              <div class="lp-feat-icon"><i data-lucide="upload-cloud"></i></div>
              <h3>Audio &amp; Video Media</h3>
              <p>Upload audio or video files. Groq Whisper transcribes and translates the full content within seconds.</p>
            </div>
            <div class="lp-feat-card">
              <div class="lp-feat-icon"><i data-lucide="sparkles"></i></div>
              <h3>AI Quality Review</h3>
              <p>Every translation is reviewed by a second AI agent for accuracy, catching hallucinations before they reach your team.</p>
            </div>
            <div class="lp-feat-card">
              <div class="lp-feat-icon"><i data-lucide="book-open"></i></div>
              <h3>Enterprise Vocabulary</h3>
              <p>Define your organisation's terminology once. Every translation respects your brand language and domain terms.</p>
            </div>
            <div class="lp-feat-card">
              <div class="lp-feat-icon"><i data-lucide="clipboard-list"></i></div>
              <h3>AI Meeting Recap</h3>
              <p>One click generates a full AI summary of your multilingual conversation — main goals, key decisions, action items with assignees, follow-ups, and next-meeting recommendations, delivered in your language.</p>
            </div>
            <div class="lp-feat-card">
              <div class="lp-feat-icon"><i data-lucide="send"></i></div>
              <h3>Post-Meeting Record Delivery</h3>
              <p>Admins can search saved conversations by date, room, or participant, then email the full transcript or AI summary to themselves with all attendees CC'd — the complete record, delivered automatically.</p>
            </div>
          </div>
        </section>

        <div class="lp-stats-strip">
          <div class="lp-stat-item"><strong>16</strong><span>Languages</span></div>
          <div class="lp-stat-item"><strong>Real-Time</strong><span>AI Translation</span></div>
          <div class="lp-stat-item"><strong>Multi-User</strong><span>Secure Rooms</span></div>
          <div class="lp-stat-item"><strong>Enterprise</strong><span>Vocabulary</span></div>
        </div>

        <section class="lp-bottom-cta">
          <h2>Start speaking across languages today</h2>
          <p>Free trial included.</p>
          <button type="button" class="lp-primary-btn" onclick="showAuthModal('pricing')">
            <i data-lucide="zap"></i>
            Try AI Translate Free
          </button>
        </section>

        <p class="landing-copyright" id="landingCopyright"></p>
      </div>
    `;
    updateCopyrightYear();
    lucide.createIcons({ nodes: [overlay] });
    return;
  }

  const checkmarkSvg = `<div class="checkmark-overlay"><svg class="checkmark-svg" viewBox="0 0 52 52"><circle class="checkmark-circle" cx="26" cy="26" r="25" fill="none"/><path class="checkmark-check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/></svg></div>`;

  const pricingHtml = `
    <div class="pricing-plans">
      <div class="plan-card trial selected" onclick="selectPlan(this)">
        ${checkmarkSvg}
        <div class="plan-badge">Most Popular</div>
        <h3>Free Trial</h3>
        <div class="price" id="trialPrice">${currentPricing.trial_days || 3} Days</div>
        <p class="plan-desc">Full access — no commitment needed</p>
        <ul>
          <li><i data-lucide="check"></i> All 16 languages</li>
          <li><i data-lucide="check"></i> Live speech translation</li>
          <li><i data-lucide="check"></i> Real-time conversation rooms</li>
          <li><i data-lucide="check"></i> AI quality review on every translation</li>
          <li><i data-lucide="check"></i> AI meeting recap &amp; summaries</li>
          <li><i data-lucide="check"></i> Text &amp; media file translation</li>
        </ul>
      </div>
      <div class="plan-card monthly" onclick="selectPlan(this)">
        ${checkmarkSvg}
        <h3>Monthly</h3>
        <div class="price" id="monthlyPrice">${formatPrice(currentPricing.monthly_price)}<span>/mo</span></div>
        <p class="plan-desc">Flexible — cancel any time</p>
        <ul>
          <li><i data-lucide="check"></i> Everything in Free Trial</li>
          <li><i data-lucide="check"></i> Unlimited conversation history</li>
          <li><i data-lucide="check"></i> Admin post-meeting email delivery</li>
          <li><i data-lucide="check"></i> Enterprise vocabulary manager</li>
          <li><i data-lucide="check"></i> Search records by date, room &amp; participant</li>
          <li><i data-lucide="check"></i> Priority support</li>
        </ul>
      </div>
      <div class="plan-card annual" onclick="selectPlan(this)">
        ${checkmarkSvg}
        <div class="plan-badge plan-badge--savings">Save 20%</div>
        <h3>Annual</h3>
        <div class="price" id="annualPrice">${formatPrice(currentPricing.yearly_price)}<span>/yr</span></div>
        <p class="plan-desc">Best value — lowest cost per month</p>
        <ul>
          <li><i data-lucide="check"></i> Everything in Monthly</li>
          <li><i data-lucide="check"></i> 20% saving vs monthly billing</li>
          <li><i data-lucide="check"></i> Dedicated account support</li>
          <li><i data-lucide="check"></i> Early access to new features</li>
          <li><i data-lucide="check"></i> Bulk participant room management</li>
          <li><i data-lucide="check"></i> Custom enterprise vocabulary sets</li>
        </ul>
      </div>
      <div class="pricing-footer">
        <button type="button" class="btn btn-primary pricing-continue" id="pricingContinueBtn">
          <i data-lucide="arrow-right"></i>
          <span>Continue with selected plan</span>
        </button>
        <div class="pricing-login-prompt">
          Already have an account? <span class="auth-link" onclick="showAuthModal('login')">Sign in</span>
        </div>
      </div>
    </div>
  `;

  overlay.innerHTML = `
    <header class="auth-page-header">
      <div class="auth-page-brand" onclick="showAuthModal('landing')" role="button" tabindex="0" aria-label="Back to home">
        <span class="auth-page-brand-icon"><i data-lucide="languages"></i></span>
        <span class="auth-page-brand-name">AI Translate</span>
      </div>
      <div class="auth-page-header-right">
        <div class="auth-page-header-prompt">
          ${isLogin
            ? `<span>New to AI Translate?</span>
               <button type="button" onclick="showAuthModal('pricing')">Create account free</button>`
            : `<span>Already have an account?</span>
               <button type="button" onclick="showAuthModal('login')">Sign in</button>`
          }
        </div>
        <button type="button" class="auth-page-header-link">Support</button>
        <div class="auth-page-lang-wrap">
          <i data-lucide="globe"></i>
          <select class="auth-page-lang-select" aria-label="Display language">
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
            <option value="de">Deutsch</option>
            <option value="it">Italiano</option>
            <option value="pt">Português</option>
            <option value="zh">中文</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
            <option value="ar">العربية</option>
            <option value="ru">Русский</option>
            <option value="hi">हिन्दी</option>
            <option value="nl">Nederlands</option>
            <option value="pl">Polski</option>
            <option value="tr">Türkçe</option>
            <option value="tl">Filipino</option>
          </select>
          <i data-lucide="chevron-down" class="auth-page-lang-chevron"></i>
        </div>
      </div>
    </header>
    <div class="auth-page-body">
      <section class="auth-card${isPricing ? " auth-card--wide" : ""}" aria-label="${isLogin ? "Login" : isPricing ? "Plans and account creation" : "Reset password"}">
        <div class="auth-header">
          <div class="auth-mode-switch">
            <button type="button" class="${isPricing ? "active" : ""}" onclick="showAuthModal('pricing')">Plans</button>
            <button type="button" class="${isCancel ? "active" : ""}" onclick="showAuthModal('cancel')">Cancel Plan</button>
            <button type="button" class="${isLogin ? "active" : ""}" onclick="showAuthModal('login')">Login</button>
          </div>
          <h2>${isLogin ? "Welcome back" : isPricing ? "Choose a plan" : isCancel ? "Cancel subscription" : "Reset password"}</h2>
          <p>${isLogin ? "Sign in to open your conversation workspace." : isPricing ? "Select a plan, create your account, and start your trial." : isCancel ? "Refunds are available within 10 days after your first paid charge." : "Enter your email to receive a reset link."}</p>
        </div>
        <div class="auth-tab-body">
          ${isPricing ? pricingHtml : ""}
          <div class="auth-form" ${isPricing ? 'style="display:none"' : ""}>
            <div class="auth-input-group">
              <label>Email Address</label>
              <input type="email" id="authEmail" class="auth-input" placeholder="name@company.com" autocomplete="email">
            </div>
            ${
              isPricing
                ? `
            <div class="auth-input-group">
              <label>Phone Number</label>
              <input type="tel" id="authPhone" class="auth-input" placeholder="Optional: +1 (555) 000-0000" autocomplete="tel">
            </div>`
                : ""
            }
            ${
              !isForgot && !isCancel
                ? `
            <div class="auth-input-group">
              <label>Password</label>
              <input type="password" id="authPass" class="auth-input" placeholder="Password" autocomplete="${isLogin ? "current-password" : "new-password"}">
            </div>`
                : ""
            }
            ${
              isCancel
                ? `
            <div class="auth-input-group">
              <label>Reason</label>
              <textarea id="cancelReason" class="auth-textarea" placeholder="Tell us why you are cancelling" rows="3"></textarea>
            </div>
            <label class="billing-terms compact">
              <input type="checkbox" id="cancelTerms">
              <span>I understand that refunds are only available within 10 days after the first paid charge. Beyond that period, no refund will be made.</span>
            </label>`
                : ""
            }
            <button id="authSubmit" class="btn btn-primary auth-submit ${isPricing ? "plan-trial" : ""}">
              ${isLogin ? "Sign In" : isPricing ? "Create Account" : isCancel ? "Submit Cancellation" : "Send Reset Link"}
            </button>
          </div>
          <div class="auth-footer" ${isPricing ? 'style="display:none"' : ""}>
            ${
              isLogin
                ? `
              <span class="auth-link" onclick="showAuthModal('forgot')">Forgot password?</span>
            `
                : isCancel
                  ? `
              Need access? <span class="auth-link" onclick="showAuthModal('login')">Sign in</span>
            `
                  : `
              Already have an account? <span class="auth-link" onclick="showAuthModal('login')">Sign in</span>
            `
            }
          </div>
        </div>
      </section>
    </div>
  `;

  updateCopyrightYear();
  // Re-initialize icons for the new HTML
  lucide.createIcons({ nodes: [overlay] });
  if (isPricing) loadPricing();

  if (isPricing) {
    document.getElementById("pricingContinueBtn").onclick = () => {
      showSignupModal(getSelectedPlan());
    };
    return;
  }

  document.getElementById("authSubmit").onclick = async () => {
    const email = document.getElementById("authEmail").value.trim();
    if (!email) {
      alert("Please enter an email");
      return;
    }
    const pass = !isForgot && !isCancel
      ? document.getElementById("authPass").value.trim()
      : "";
    if (isCancel) {
      if (!document.getElementById("cancelTerms").checked) {
        alert("Please acknowledge the refund policy");
        return;
      }
      try {
        const res = await fetch(`${API_BASE}/api/v1/billing/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            reason: document.getElementById("cancelReason").value.trim(),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Cancellation failed");
        alert(data.message);
        showAuthModal("login");
      } catch (e) {
        alert(e.message);
      }
      return;
    }

    try {
      let endpoint = isLogin
        ? "/api/v1/auth/login"
        : "/api/v1/auth/forgot-password";
      let body = isForgot ? { email } : { email, password: pass };

      const res = await fetch(
        `${API_BASE}${endpoint}${isForgot ? "?email=" + email : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: isForgot ? null : JSON.stringify(body),
        },
      );

      if (!res.ok) {
        const err = await res.json();
        if (isLogin && res.status === 401) {
          throw new Error("Email or password not recognized. Try again or create a trial account from Plans.");
        }
        throw new Error(err.detail || "Auth failed");
      }

      if (isForgot) {
        alert("If this email exists, a reset link has been sent.");
        showAuthModal("login");
        return;
      }

      const data = await res.json();
      persistAuthSession(data);
      updateAuthHeader();
      overlay.remove();
      routeToConversation();

      if (data.access && !data.access.allowed) {
        showPricingModal(data.access.reason);
      }
    } catch (e) {
      alert(e.message);
    }
  };
}

function showPricingModal(reason) {
  const overlay = document.createElement("div");
  overlay.className = "auth-overlay";
  overlay.innerHTML = `
    <div class="auth-card" style="text-align:center">
      <div class="auth-header">
        <h2 style="color:#ef4444">Access Limited</h2>
        <p>${reason}</p>
      </div>
      <div style="background:#f9fafb; padding:1.5rem; border-radius:12px; border:1px solid #e5e7eb">
        <h3 style="margin-bottom:1rem">Choose a Plan</h3>
        <button class="btn btn-primary" style="width:100%; margin-bottom:0.5rem">Monthly - $7.99</button>
        <button class="btn btn-secondary" style="width:100%">Yearly - $79.00 (Save 20%)</button>
      </div>
      <span class="auth-link" onclick="location.reload()">Back to login</span>
    </div>
  `;
  document.body.appendChild(overlay);
}

// ── Language detection helper (Text tab only) ──────────────────────────────
let detectTimer = null;

async function detectAndShowLanguage(text) {
  if (!text.trim() || textSourceLang.value !== "auto") return;
  try {
    const res = await fetch(
      `${API_BASE}/detect_language?text=${encodeURIComponent(text)}`,
      { method: "POST" },
    );
    if (!res.ok) return;
    const data = await res.json();
    updateDetectOption(textSourceLang, data.detected_language);
  } catch (_) {}
}

function updateDetectOption(selectEl, langCode) {
  const opt = selectEl.querySelector('option[value="auto"]');
  if (!opt) return;
  opt.textContent = langCode
    ? `Detected: ${LANG_NAMES[langCode] ?? langCode}`
    : "Detect Language";
}

function resetTextDetectOption() {
  updateDetectOption(textSourceLang, null);
}

function updateCharCount(len) {
  charCount.textContent = `${len} character${len !== 1 ? "s" : ""}`;
}

// ── Live translate ──────────────────────────────────────────────────────────
let translateTimer = null;
let liveController = null;
let typewriterTimer = null;
let detectedLangCode = null;
let lastTranslation = "";

async function liveTranslate(sourceOverride) {
  const text = inputText.value.trim();
  if (!text) {
    setOutput("");
    return;
  }

  if (liveController) liveController.abort();
  liveController = new AbortController();

  showTypingIndicator();

  const sourceCode =
    sourceOverride ??
    (textSourceLang.value === "auto" ? "en" : textSourceLang.value);

  try {
    const params = new URLSearchParams({
      source: sourceCode,
      target: textTargetLang.value,
      text,
    });

    if (!currentUserToken) {
      showAuthModal();
      return;
    }

    const res = await fetch(
      `${API_BASE}/api/v1/translate/text?${params.toString()}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${currentUserToken}` },
        signal: liveController.signal,
      },
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "Unknown error" }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const data = await res.json();
    detectedLangCode = data.detected_language;
    if (textSourceLang.value === "auto")
      updateDetectOption(textSourceLang, detectedLangCode);

    lastTranslation = data.translation;
    typewriterOutput(data.translation);
  } catch (err) {
    if (err.name === "AbortError") return;
    setOutput(`Error: ${err.message}`);
  }
}

function showTypingIndicator() {
  clearInterval(typewriterTimer);
  outputBox.innerHTML =
    '<span class="typing-indicator"><span></span><span></span><span></span></span>';
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
  const sav_detect_language =
    textSourceLang.value === "auto" ? detectedLangCode : textSourceLang.value;
  if (!sav_detect_language) return;

  // Abort any in-flight request and stop the typewriter before reading state
  if (liveController) {
    liveController.abort();
    liveController = null;
  }
  clearInterval(typewriterTimer);
  clearTimeout(translateTimer);

  const sav_enter_text_to_translate = inputText.value;
  const sav_target_language = textTargetLang.value;
  const sav_translation = lastTranslation;

  // Apply swap: each field receives its counterpart's saved value
  textSourceLang.value = sav_target_language;
  resetTextDetectOption();
  lastTranslation = sav_enter_text_to_translate;
  inputText.value = sav_translation;
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

  showSpinner(
    true,
    "Transcribing audio with Whisper… this may take up to 60 seconds",
  );

  try {
    const formData = new FormData();
    formData.append("file", file);

    const params = new URLSearchParams({
      source: audioSourceLang.value === "auto" ? "en" : audioSourceLang.value,
      target: audioTargetLang.value,
    });

    if (!currentUserToken) {
      showAuthModal();
      return;
    }

    const res = await fetch(
      `${API_BASE}/api/v1/translate/audio?${params.toString()}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${currentUserToken}` },
        body: formData,
      },
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "Unknown error" }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    if (res.status === 402) {
      const err = await res.json();
      showPricingModal(err.detail.message);
      return;
    }

    const data = await res.json();
    if (audioSourceLang.value === "auto")
      updateDetectOption(audioSourceLang, data.detected_language);

    audioTranscript.value = "";

    const objectURL = URL.createObjectURL(file);
    audioPlayer.src = objectURL;
    audioPlayer.style.display = "block";

    const words = data.words || [];

    audioPlayer.ontimeupdate = () => {
      const t = audioPlayer.currentTime;
      const heard = words
        .filter((w) => w.start <= t)
        .map((w) => w.word.trim())
        .join(" ");
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
    setTimeout(() => {
      copyBtn.querySelector("span").textContent = "Copy";
    }, 1500);
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
      text,
    });

    if (!currentUserToken) {
      showAuthModal();
      return;
    }

    const res = await fetch(
      `${API_BASE}/api/v1/translate/text?${params.toString()}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${currentUserToken}` },
      },
    );
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
    setTimeout(() => {
      audioCopyBtn.querySelector("span").textContent = "Copy";
    }, 1500);
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
    outputBox.innerHTML =
      '<span class="placeholder">Translation will appear here...</span>';
    copyBtn.style.display = "none";
  }
}

function setAudioOutput(translation) {
  if (translation) {
    audioOutputBox.textContent = translation;
    audioCopyBtn.style.display = "inline-block";
  } else {
    audioOutputBox.innerHTML =
      '<span class="placeholder">Translation will appear here...</span>';
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
  audioQualityBadge.className = quality.passed
    ? "quality-badge passed"
    : "quality-badge flagged";
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
const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

const LANG_LOCALES = {
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-BR",
  zh: "zh-CN",
  ja: "ja-JP",
  ko: "ko-KR",
  ar: "ar-SA",
  ru: "ru-RU",
  hi: "hi-IN",
  nl: "nl-NL",
  pl: "pl-PL",
  tr: "tr-TR",
  tl: "fil-PH",
};

let recognition = null;
let isListening = false;
let finalText = "";
let liveXlateTimer = null;
let liveDetectTimer = null;
let liveDetectedLang = null;

function startListening() {
  if (!SpeechRecognition) {
    liveStatus.textContent =
      "Speech recognition not supported — use Chrome or Edge";
    return;
  }

  finalText = "";
  liveDetectedLang = null;
  liveTranscript.innerHTML = '<span class="placeholder">Listening…</span>';
  liveOutputText.innerHTML =
    '<span class="placeholder">Translation will appear here…</span>';
  liveCopyBtn.style.display = "none";
  liveTranslationCopyBtn.style.display = "none";

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = LANG_LOCALES[liveSourceLang.value] || "en-US";

  recognition.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalText += e.results[i][0].transcript + " ";
        clearTimeout(liveXlateTimer);
        liveXlateTimer = setTimeout(
          () => translateLiveText(finalText.trim()),
          400,
        );
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
  recognition.onend = () => {
    if (isListening) recognition.start();
  };

  recognition.onerror = (e) => {
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
              "If on macOS, also check System Settings → Privacy & Security → Microphone.",
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
  if (recognition) {
    recognition.stop();
    recognition = null;
  }
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
  liveTranscript.innerHTML =
    '<span class="placeholder">Your speech will appear here…</span>';
  liveOutputText.innerHTML =
    '<span class="placeholder">Translation will appear here…</span>';
  liveCopyBtn.style.display = "none";
  liveTranslationCopyBtn.style.display = "none";
  liveStatus.textContent = "Click the mic to start listening";
});

async function detectLiveLanguage(text) {
  if (!text.trim() || text.length < 3) return;
  try {
    const res = await fetch(
      `${API_BASE}/detect_language?text=${encodeURIComponent(text)}`,
      { method: "POST" },
    );
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

    if (!currentUserToken) return;

    const res = await fetch(`${API_BASE}/api/v1/translate/text?${params}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${currentUserToken}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    liveOutputText.textContent = data.translation;
    liveTranslationCopyBtn.style.display = "inline-block";
  } catch (_) {}
}

// Restart recognition with new language if changed mid-session
liveSourceLang.addEventListener("change", () => {
  if (isListening) {
    stopListening();
    startListening();
  }
});

// Re-translate existing transcript when target language changes
liveTargetLang.addEventListener("change", () => {
  if (finalText.trim()) translateLiveText(finalText.trim());
});

liveCopyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(liveTranscript.textContent.trim()).then(() => {
    liveCopyBtn.querySelector("span").textContent = "Copied!";
    setTimeout(() => {
      liveCopyBtn.querySelector("span").textContent = "Copy";
    }, 1500);
  });
});

liveTranslationCopyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(liveOutputText.textContent.trim()).then(() => {
    liveTranslationCopyBtn.querySelector("span").textContent = "Copied!";
    setTimeout(() => {
      liveTranslationCopyBtn.querySelector("span").textContent = "Copy";
    }, 1500);
  });
});

// ── Live Conversation (multi-user) ────────────────────────────────────────
let convWs = null;
let convRoomId = null;
let convUserId = null; // this session's user_id assigned by server
let convIsHost = false;
let convUsers = {}; // user_id → {name, language, is_host, mic_on, camera_on, idle, idle_since}
let convTranscript = [];
let convIsListening = false;
let convRecognition = null;
let convXlateTimer = null;
let convFinalText = "";
let convInterimTimer = null;
let _recognitionRestartCount = 0;
let convCamStream = null;
let convCamOn = false;
let _convReconnectAttempts = 0;
let _convWasCreator = false;
const _CONV_MAX_RECONNECTS = 3;

// Persistent colour palette — one colour per participant (8 distinct)
const _PARTICIPANT_PALETTE = [
  "#4f8ef7",
  "#e84393",
  "#22b573",
  "#f7a540",
  "#a259f7",
  "#e85c3a",
  "#2ec4b6",
  "#b59b00",
];
const _participantColors = {}; // user_id → hex colour
let _paletteIndex = 0;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showToast(message, type = "info") {
  let tray = document.getElementById("toastTray");
  if (!tray) {
    tray = document.createElement("div");
    tray.id = "toastTray";
    tray.className = "toast-tray";
    document.body.appendChild(tray);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  tray.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function convColorFor(userId) {
  if (!_participantColors[userId]) {
    _participantColors[userId] =
      _PARTICIPANT_PALETTE[_paletteIndex % _PARTICIPANT_PALETTE.length];
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

let _ttsEnabled = true;
let _ttsSpeakerMode = true;
let _ttsVoices = [];
let _ttsUnlocked = false;

if (window.speechSynthesis) {
  const _loadVoices = () => {
    _ttsVoices = window.speechSynthesis.getVoices();
  };
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
    primer.rate = 16; // completes in milliseconds
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
  try {
    ss.resume();
  } catch (_) {}
  // Cancel any queued-but-not-yet-spoken utterances so the listener always
  // hears the *latest* translation rather than a stale backlog.
  if (ss.pending) ss.cancel();
  const locale = LANG_LOCALES[langCode] || langCode;
  const utt = new SpeechSynthesisUtterance(text.trim());
  utt.lang = locale;
  utt.rate = 1.0;
  utt.pitch = 1.0;
  utt.volume = _ttsSpeakerMode ? 1.0 : 0.18;
  const voices = _ttsVoices.length ? _ttsVoices : ss.getVoices();
  const prefix = langCode.split("-")[0];
  utt.voice =
    voices.find((v) => v.lang === locale) ||
    voices.find((v) => v.lang.startsWith(langCode)) ||
    voices.find((v) => v.lang.startsWith(prefix)) ||
    null;
  try {
    ss.speak(utt);
  } catch (e) {
    console.warn("[TTS] speak failed:", e);
  }
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

let _voiceCloneEnrolled = false;
let _voiceCloneCapturing = false;
let _voiceCloneAvailable = null; // null = unprobed, true/false after probe
const _VOICE_REF_SEC = 5;
const _VOICE_FALLBACK_MS = 8000;
const _voiceAwaiting = new Map(); // from_id → setTimeout id

async function _voiceCloneProbe() {
  if (_voiceCloneAvailable !== null) return _voiceCloneAvailable;
  try {
    const r = await fetch("/api/v1/voices/status");
    _voiceCloneAvailable = r.ok ? !!(await r.json()).available : false;
  } catch {
    _voiceCloneAvailable = false;
  }
  if (_voiceCloneAvailable)
    console.log("[VoiceClone] available on this server");
  return _voiceCloneAvailable;
}

function _voiceCloneBadge(state) {
  const badge = document.getElementById("voiceCloneBadge");
  const text = document.getElementById("voiceCloneBadgeText");
  if (!badge || !text) return;
  if (state === "building") {
    text.textContent = "Building voice profile...";
    text.style.cssText =
      "background:rgba(99,102,241,0.1);color:#6366f1;border:1px solid rgba(99,102,241,0.3)";
    badge.style.display = "block";
  } else if (state === "ready") {
    text.textContent = "Voice cloning active";
    text.style.cssText =
      "background:rgba(34,197,94,0.1);color:#16a34a;border:1px solid rgba(34,197,94,0.3)";
    badge.style.display = "block";
  } else {
    badge.style.display = "none";
  }
}

async function convVoiceCloneEnroll(stream) {
  if (_voiceCloneEnrolled || _voiceCloneCapturing || !convUserId || !stream)
    return;
  if (!(await _voiceCloneProbe())) return;
  _voiceCloneCapturing = true;
  _voiceCloneBadge("building");
  try {
    const rec = new MediaRecorder(stream, {
      mimeType: "audio/webm;codecs=opus",
    });
    const chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = async () => {
      _voiceCloneCapturing = false;
      try {
        const wav = await _webmBlobToWav(
          new Blob(chunks, { type: "audio/webm" }),
        );
        if (!wav) return;
        const fd = new FormData();
        fd.append("file", wav, "reference.wav");
        const r = await fetch(
          `/api/v1/voices/enroll?user_id=${encodeURIComponent(convUserId)}`,
          { method: "POST", body: fd },
        );
        if (r.ok) {
          _voiceCloneEnrolled = true;
          _voiceCloneBadge("ready");
          console.log(
            "[VoiceClone] enrolled — translations will use cloned voice",
          );
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
    setTimeout(() => {
      try {
        rec.stop();
      } catch {}
    }, _VOICE_REF_SEC * 1000);
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
  _voiceAwaiting.set(
    fromId,
    setTimeout(() => {
      _voiceAwaiting.delete(fromId);
      convSpeak(text, langCode);
    }, _VOICE_FALLBACK_MS),
  );
}

// Play a base64-encoded WAV from a "voice_audio" message and cancel any
// pending browser-TTS fallback for the same speaker.
function convPlayClonedAudio(audioB64, fromId) {
  const tid = _voiceAwaiting.get(fromId);
  if (tid) {
    clearTimeout(tid);
    _voiceAwaiting.delete(fromId);
  }
  try {
    convSpeakCancel();
    const a = new Audio(`data:audio/wav;base64,${audioB64}`);
    a.volume = _ttsSpeakerMode ? 1.0 : 0.18;
    a.play().catch((e) => console.warn("[VoiceClone] play failed:", e));
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
    const off = new OfflineAudioContext(
      1,
      Math.ceil(decoded.duration * sr),
      sr,
    );
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
  const sr = buf.sampleRate,
    samples = buf.getChannelData(0),
    n = samples.length;
  const ab = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(ab);
  let p = 0;
  const ws = (s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(p++, s.charCodeAt(i));
  };
  const w32 = (v) => {
    dv.setUint32(p, v, true);
    p += 4;
  };
  const w16 = (v) => {
    dv.setUint16(p, v, true);
    p += 2;
  };
  ws("RIFF");
  w32(36 + n * 2);
  ws("WAVE");
  ws("fmt ");
  w32(16);
  w16(1);
  w16(1);
  w32(sr);
  w32(sr * 2);
  w16(2);
  w16(16);
  ws("data");
  w32(n * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(p, s * 0x7fff, true);
    p += 2;
  }
  return new Blob([ab], { type: "audio/wav" });
}

const convSetup = document.getElementById("convSetup");
const convActive = document.getElementById("convActive");
const convNameInput = document.getElementById("convName");
const convLangSelect = document.getElementById("convLang");
const convCreateBtn = document.getElementById("convCreateBtn");
const convJoinBtn = document.getElementById("convJoinBtn");
const convRoomInput = document.getElementById("convRoomInput");
const convRoomCode = document.getElementById("convRoomCode");
const convCopyCodeBtn = document.getElementById("convCopyCodeBtn");
// convParticipantsBar removed — replaced by carousel
const convMessages = document.getElementById("convMessages");
const convMicBtn = document.getElementById("convMicBtn");
const convMicLabel = document.getElementById("convMicLabel");
const convCamBtn = document.getElementById("convCamBtn");
const convCamLabel = document.getElementById("convCamLabel");
const convSummaryBtn = document.getElementById("convSummaryBtn");
const convSummaryLabel = document.getElementById("convSummaryLabel");
const convTtsBtn = document.getElementById("convTtsBtn");
const convTtsLabel = document.getElementById("convTtsLabel");
const convParticipantsBtn = document.getElementById("convParticipantsBtn");
const convParticipantsLabel = document.getElementById("convParticipantsLabel");
const convParticipantsPopover = document.getElementById("convParticipantsPopover");
const convParticipantsList = document.getElementById("convParticipantsList");
const convChatBtn = document.getElementById("convChatBtn");
const convMoreBtn = document.getElementById("convMoreBtn");
const convMorePopover = document.getElementById("convMorePopover");
const convEndBtn = document.getElementById("convEndBtn");
const convKeyboardBar = document.getElementById("convKeyboardBar");
const convToolbarVocabBtn = document.getElementById("convToolbarVocabBtn");
const convSummaryModal = document.getElementById("convSummaryModal");
const convSummaryTitle = document.getElementById("convSummaryTitle");
const convSummaryClose = document.getElementById("convSummaryClose");
const convSummaryBody = document.getElementById("convSummaryBody");
const convSummarySaveBtn = document.getElementById("convSummarySaveBtn");
const convHistoryBtn = document.getElementById("convHistoryBtn");
let convAdminToken = sessionStorage.getItem("history_admin_token") || "";
let convAdminEmail = sessionStorage.getItem("history_admin_email") || "";
let convLastSummaryPayload = null;
// convCamPreview / convCamVideo removed — local camera shown in own carousel card

function syncConversationNameField() {
  if (!convNameInput) return;
  const displayName = getAuthenticatedDisplayName();
  if (currentUserToken && displayName) {
    convNameInput.value = displayName;
    convNameInput.readOnly = true;
    convNameInput.classList.add("locked");
    convNameInput.title = "Name comes from your logged-in account";
    return;
  }
  convNameInput.readOnly = false;
  convNameInput.classList.remove("locked");
  convNameInput.title = "";
}

function convShowScreen(screen) {
  convSetup.style.display = "none";
  convActive.style.display = "none";
  screen.style.display = screen === convActive ? "flex" : "block";
}

function convGetWsBase() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host =
    window.location.port === "3000" || window.location.protocol === "file:"
      ? "127.0.0.1:8000"
      : window.location.host;
  return `${proto}//${host}`;
}

// ── Participant carousel ───────────────────────────────────────────────────
// Each participant gets a square card (name overlay + camera video inside).
// Cards fill a 3-row grid; left/right arrows paginate when count exceeds one page.

const _CARD_ROWS = 20; // effectively unlimited — all tiles show in one page

let _carouselPage = 0;
const _carouselCards = []; // ordered DOM elements; order = join order

function _carouselCols() {
  const n = _carouselCards.length || 1;
  if (n === 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

function _buildCard(uid, user) {
  const isMe = uid === convUserId;
  const color = convColorFor(uid);

  const card = document.createElement("div");
  card.className =
    "conv-participant-card" + (isMe ? " me" : "") + (user.idle ? " idle" : "") + (user.mic_on ? " mic-on" : "");
  card.id = `conv-card-${uid}`;
  card.dataset.uid = uid;

  // ── Square video box ──────────────────────────────────────────
  const box = document.createElement("div");
  box.className = "conv-card-box";

  // Initials placeholder (shown when camera is off). Uniform Space Gray
  // background for all participants — the per-participant palette color is
  // still used elsewhere (card border, name chip) for identification.
  const ph = document.createElement("div");
  ph.className = "conv-card-placeholder";
  ph.id = `conv-card-ph-${uid}`;
  const _nameParts = user.name.trim().split(/\s+/);
  ph.textContent =
    _nameParts.length >= 2
      ? (_nameParts[0][0] + _nameParts[_nameParts.length - 1][0]).toUpperCase()
      : _nameParts[0][0].toUpperCase();
  ph.style.background = "#4A4D52"; // Space Gray

  // Video element (hidden until camera opens)
  const vid = document.createElement("video");
  vid.autoplay = true;
  vid.playsInline = true;
  vid.muted = true;
  vid.id = `conv-card-vid-${uid}`;
  vid.className = "conv-card-vid";
  if (isMe) vid.style.transform = "scaleX(-1)"; // mirror selfie

  // Live caption overlay (interim/translated text for remote peers)
  const cap = document.createElement("div");
  cap.className = "conv-remote-caption";
  cap.id = `conv-caption-${uid}`;

  // Name bar overlaid at bottom of box
  const nameBar = document.createElement("div");
  nameBar.className = "conv-card-name-bar";

  const micDot = document.createElement("div");
  micDot.className = "conv-participant-mic-dot" + (user.mic_on ? " on" : "");
  micDot.id = `conv-mic-dot-${uid}`;

  const nameTxt = document.createElement("span");
  nameTxt.className = "conv-card-name-txt";
  nameTxt.textContent = user.name + (isMe ? " (You)" : "");

  const idleTimer = document.createElement("span");
  idleTimer.className = "conv-card-idle-timer";
  idleTimer.id = `conv-idle-timer-${uid}`;
  idleTimer.textContent = user.idle ? "idle" : "";

  const langBadge = document.createElement("span");
  langBadge.className = "conv-lang-badge conv-card-lang-badge";
  langBadge.textContent = LANG_NAMES[user.language] || user.language.toUpperCase();

  const camDot = document.createElement("div");
  camDot.className = "conv-participant-cam-dot" + (user.camera_on ? " on" : "");
  camDot.id = `conv-cam-dot-${uid}`;

  nameBar.appendChild(micDot);
  nameBar.appendChild(nameTxt);
  nameBar.appendChild(idleTimer);
  nameBar.appendChild(langBadge);
  nameBar.appendChild(camDot);

  if (user.is_host) {
    const hostBadge = document.createElement("span");
    hostBadge.className = "conv-host-badge conv-card-host-badge";
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

  const cols = _carouselCols();
  const pageSize = cols * _CARD_ROWS;
  const total = _carouselCards.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  _carouselPage = Math.min(_carouselPage, totalPages - 1);

  const start = _carouselPage * pageSize;
  const end = start + pageSize;

  // Detach all, re-append only the current page's cards
  // (video elements keep playing when detached in modern browsers)
  while (track.firstChild) track.removeChild(track.firstChild);
  _carouselCards.slice(start, end).forEach((c) => track.appendChild(c));
  track.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  const btnL = document.getElementById("convCarouselLeft");
  const btnR = document.getElementById("convCarouselRight");
  if (btnL) btnL.style.visibility = _carouselPage > 0 ? "visible" : "hidden";
  if (btnR)
    btnR.style.visibility =
      _carouselPage < totalPages - 1 ? "visible" : "hidden";

  lucide.createIcons({
    nodes: [
      document.getElementById("convCarouselLeft"),
      document.getElementById("convCarouselRight"),
    ].filter(Boolean),
  });
}

function convRenderParticipants() {
  convMergeDuplicateParticipants();

  // Add cards for new participants (preserves existing DOM nodes with live video)
  Object.entries(convUsers).forEach(([uid, user]) => {
    if (!_carouselCards.find((c) => c.dataset.uid === uid)) {
      _carouselCards.push(_buildCard(uid, user));
    }
    document.getElementById(`conv-card-${uid}`)?.classList.toggle("idle", !!user.idle);
    if (user.idle) convStartIdleTimer(uid);
    else convStopIdleTimer(uid);
  });

  // Remove cards for departed participants
  for (let i = _carouselCards.length - 1; i >= 0; i--) {
    if (!convUsers[_carouselCards[i].dataset.uid]) {
      convStopIdleTimer(_carouselCards[i].dataset.uid);
      _carouselCards.splice(i, 1);
    }
  }

  _carouselRenderPage();
  convRenderParticipantsPopover();
}

function convRenderParticipantsPopover() {
  if (!convParticipantsList) return;
  const users = Object.entries(convUsers);
  if (convParticipantsLabel) {
    convParticipantsLabel.textContent = `Participants${users.length ? ` (${users.length})` : ""}`;
  }
  if (!users.length) {
    convParticipantsList.innerHTML = '<div class="conv-participant-row empty">No participants yet</div>';
    return;
  }
  convParticipantsList.innerHTML = users
    .map(([uid, user]) => {
      const name = escapeHtml(user.name || "Guest");
      const lang = escapeHtml((user.language || "").toUpperCase());
      const self = uid === convUserId ? "You" : "";
      const host = user.is_host ? "Host" : "";
      const badges = [self, host].filter(Boolean).join(" · ");
      const micIcon = user.mic_on ? "mic" : "mic-off";
      const videoIcon = user.camera_on ? "video" : "video-off";
      return `
        <div class="conv-participant-row">
          <span class="conv-participant-avatar">${name.charAt(0).toUpperCase()}</span>
          <span class="conv-participant-meta">
            <strong>${name}</strong>
            <small>${badges || lang || "Participant"}</small>
          </span>
          <span class="conv-participant-status">
            <i data-lucide="${micIcon}"></i>
            <i data-lucide="${videoIcon}"></i>
          </span>
        </div>
      `;
    })
    .join("");
  lucide.createIcons({ nodes: [convParticipantsList] });
}

function convUpdateChipMic(userId, isOn) {
  const card = document.getElementById(`conv-card-${userId}`);
  if (card) {
    card.classList.toggle("mic-on", isOn);
    if (!isOn) {
      card.classList.remove("speaking");
      card.style.removeProperty("--conv-speaking-intensity");
    }
  }
  const dot = document.getElementById(`conv-mic-dot-${userId}`);
  if (dot) dot.className = "conv-participant-mic-dot" + (isOn ? " on" : "");
  convRenderParticipantsPopover();
}

function convUpdateChipCam(userId, isOn) {
  const dot = document.getElementById(`conv-cam-dot-${userId}`);
  if (dot) dot.className = "conv-participant-cam-dot" + (isOn ? " on" : "");
  convRenderParticipantsPopover();
}


function convStartIdleTimer(userId) {
  if (!convUsers[userId]) return;
  const timer = document.getElementById(`conv-idle-timer-${userId}`);
  if (timer) timer.textContent = "idle";
}

function convStopIdleTimer(userId) {
  const timer = document.getElementById(`conv-idle-timer-${userId}`);
  if (timer) timer.textContent = "";
}

function convParticipantsMatch(a, b) {
  return (
    a &&
    b &&
    a.name === b.name &&
    a.language === b.language &&
    (!a.email || !b.email || a.email === b.email)
  );
}

function convRemoveParticipantCard(userId) {
  convStopIdleTimer(userId);
  webrtcOnUserLeft(userId);
  livekitDetachRemoteVideo(userId);
  convClearTyping(userId);
  const index = _carouselCards.findIndex((c) => c.dataset.uid === userId);
  if (index >= 0) _carouselCards.splice(index, 1);
  document.getElementById(`conv-card-${userId}`)?.remove();
}

function convMergeDuplicateParticipants() {
  const entries = Object.entries(convUsers);
  entries.forEach(([uid, user]) => {
    if (!user || user.idle) return;
    entries.forEach(([otherUid, other]) => {
      if (otherUid === uid || !other?.idle) return;
      if (convParticipantsMatch(user, other)) {
        convRemoveParticipantCard(otherUid);
        delete convUsers[otherUid];
      }
    });
  });
}

function convSetUserIdle(userId, isIdle, idleSince = null) {
  const wasIdle = !!convUsers[userId]?.idle;
  if (convUsers[userId]) {
    convUsers[userId].idle = isIdle;
    convUsers[userId].idle_since = isIdle
      ? convNormalizeIdleSince(idleSince || convUsers[userId].idle_since || Date.now())
      : null;
    if (isIdle) {
      convUsers[userId].mic_on = false;
      convUsers[userId].camera_on = false;
      convClearTyping(userId);
    }
  }
  const card = document.getElementById(`conv-card-${userId}`);
  card?.classList.toggle("idle", isIdle);
  if (isIdle) {
    convUpdateChipMic(userId, false);
    convUpdateChipCam(userId, false);
    convStartIdleTimer(userId);
  } else {
    convStopIdleTimer(userId);
  }
  if (wasIdle && !isIdle && userId !== convUserId) {
    showToast(`${convUsers[userId]?.name || "Participant"} is back online.`, "success");
  }
}

function convApplyRoomSnapshot(users) {
  const nextUsers = {};
  (users || []).forEach((u) => {
    nextUsers[u.user_id] = {
      name: u.name,
      language: u.language,
      is_host: u.is_host,
      mic_on: u.mic_on || false,
      camera_on: u.camera_on || false,
      idle: !!u.idle,
      idle_since: u.idle_since || null,
    };
  });

  Object.keys(convUsers).forEach((uid) => {
    if (!nextUsers[uid]) {
      if (convUsers[uid]?.idle) {
        // Idle participants persist — carry them into the new state
        nextUsers[uid] = convUsers[uid];
      } else {
        convRemoveParticipantCard(uid);
      }
    }
  });
  convUsers = nextUsers;
  convRenderParticipants();
  livekitAttachExistingRemoteVideos();
}

function convRequestRoomSnapshot() {
  if (convWs?.readyState === WebSocket.OPEN) {
    convWs.send(JSON.stringify({ type: "sync_users" }));
  }
}

// Re-paginate when the window resizes (column count may change)
window.addEventListener("resize", () => _carouselRenderPage());

// Arrow click handlers
document.getElementById("convCarouselLeft")?.addEventListener("click", () => {
  if (_carouselPage > 0) {
    _carouselPage--;
    _carouselRenderPage();
  }
});
document.getElementById("convCarouselRight")?.addEventListener("click", () => {
  const cols = _carouselCols();
  const pageSize = cols * _CARD_ROWS;
  const totalPages = Math.ceil(_carouselCards.length / pageSize);
  if (_carouselPage < totalPages - 1) {
    _carouselPage++;
    _carouselRenderPage();
  }
});

// ── Message rendering ──────────────────────────────────────────────────────
function convAddMessage(msg) {
  convClearInterim();
  convTranscript.push({
    speaker: msg.from || "Unknown",
    original: msg.original || "",
    translation: msg.translation || "",
    shown_text: msg.is_self ? msg.original || "" : msg.translation || "",
    is_self: !!msg.is_self,
    timestamp: new Date().toISOString(),
  });
  if (convTranscript.length > 200) convTranscript = convTranscript.slice(-200);

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

  const actionsEl = document.createElement("div");
  actionsEl.className = "conv-bubble-actions";

  // "Show original" toggle (always available for non-self messages)
  const hasOriginal =
    !msg.is_self && msg.original && msg.original !== msg.translation;
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
      toggleBtn.textContent = showingOriginal
        ? "Show translation"
        : "Show original";
    });
  }

  // "Correct" button for translations
  const correctBtn = document.createElement("button");
  correctBtn.className = "conv-correct-btn";
  if (msg.is_self) {
    correctBtn.style.display = "none";
  } else {
    correctBtn.textContent = "Correct";
    correctBtn.addEventListener("click", () => {
      const fixed = prompt(
        `Correct this translation:\n"${msg.translation}"`,
        msg.translation,
      );
      if (fixed && fixed !== msg.translation) convSubmitCorrection(msg, fixed);
    });
  }

  actionsEl.appendChild(toggleBtn);
  actionsEl.appendChild(correctBtn);

  bubble.appendChild(nameEl);
  bubble.appendChild(mainEl);
  bubble.appendChild(actionsEl);

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
  document
    .querySelectorAll(".conv-participant-mic-dot.pulsing")
    .forEach((d) => d.classList.remove("pulsing"));
}

// Typing indicators — keyed by user_id so multiple typers stack correctly
const _typingUsers = {}; // user_id → {name, color, timerId}

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
  if (!entries.length) {
    bar?.remove();
    return;
  }

  if (!bar) {
    bar = document.createElement("div");
    bar.id = "conv-typing-bar";
    bar.className = "conv-typing-bar";
    convMessages.appendChild(bar);
  }

  const names = entries
    .map(
      (u) =>
        `<span class="conv-typing-name" style="color:${u.color}">${u.name}</span>`,
    )
    .join(", ");
  const verb = entries.length === 1 ? "is typing" : "are typing";
  bar.innerHTML = `${names} <span class="conv-typing-dots"><span></span><span></span><span></span></span> ${verb}…`;
  convMessages.scrollTop = convMessages.scrollHeight;
}

function convAddSystemMsg(text) {
  const el = document.createElement("div");
  el.className = "conv-system-msg";
  el.textContent = text;
  convMessages.appendChild(el);
  convMessages.scrollTop = convMessages.scrollHeight;
}

async function convSubmitCorrection(msg, newTranslation) {
  if (!newTranslation || !newTranslation.trim()) return;

  const myLang = convUsers[convUserId]?.language || "en";
  const speakerLang = convUsers[msg.from_id]?.language || "en";

  try {
    const res = await fetch(`${API_BASE}/api/v1/translation/correction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_text: msg.original,
        source_lang: speakerLang,
        target_lang: myLang,
        correct_translation: newTranslation.trim(),
        bad_translation: msg.translation,
      }),
    });

    if (res.ok) {
      alert(
        "Correction saved! The system will use this for future translations.",
      );
      vocabRefresh(); // Refresh the vocab badge if visible
    }
  } catch (e) {
    console.error("Failed to submit correction:", e);
  }
}

// ── Mic UI ─────────────────────────────────────────────────────────────────
function convSetMicUI(isOn) {
  convMicBtn.classList.toggle("active", isOn);
  convMicBtn.innerHTML = isOn
    ? '<i data-lucide="mic"></i><span id="convMicLabel">Mute</span>'
    : '<i data-lucide="mic-off"></i><span id="convMicLabel">Join Audio</span>';
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
  syncConversationNameField();
  const name = getAuthenticatedDisplayName() || convNameInput.value.trim();
  const lang = convLangSelect.value;

  const wsUrl = `${convGetWsBase()}/ws/conversation/${roomId}`;
  convWs = new WebSocket(wsUrl);

  convWs.onopen = () => {
    _convReconnectAttempts = 0;
    convWs.send(
      JSON.stringify({
        type: "join",
        name,
        email: currentUserEmail || "",
        language: lang,
        is_creator: _convWasCreator,
        previous_user_id: convUserId || "",
      }),
    );
  };

  convWs.onmessage = (e) => {
    convHandleMessage(JSON.parse(e.data));
  };

  convWs.onclose = (event) => {
    if (event.code !== 1000 && convUserId) {
      if (_convReconnectAttempts < _CONV_MAX_RECONNECTS) {
        _convReconnectAttempts++;
        convAddSystemMsg(`Connection lost. Reconnecting…`);
        setTimeout(
          () => convConnect(roomId, _convWasCreator),
          _convReconnectAttempts * 2000,
        );
      } else {
        convHandleDisconnect("Connection lost. Please rejoin.");
      }
    } else if (convUserId) {
      convHandleDisconnect();
    } else {
      convCreateBtn.disabled = false;
      convCreateBtn.querySelector("span").textContent = "Create New Room";
      if (event.code !== 1000)
        alert("Could not connect to server. Please try again.");
    }
  };

  convWs.onerror = (err) => console.error("[Conv] WS error:", err);
}

function convHandleMessage(msg) {
  switch (msg.type) {
    case "error":
      if (msg.code === "room_not_found") {
        if (convWs) {
          convWs.onclose = null;
          convWs.onerror = null;
        }
        alert(
          msg.message ||
            `Room ${convRoomId} not found. Check the code with the host.`,
        );
        convRoomId = "";
        convCreateBtn.disabled = false;
        convCreateBtn.querySelector("span").textContent = "Create New Room";
      }
      break;

    case "joined":
      convUserId = msg.user_id;
      convIsHost = msg.is_host;
      setConversationRoomCode(msg.room);
      convUsers = {};
      msg.users.forEach((u) => {
        convUsers[u.user_id] = {
          name: u.name,
          language: u.language,
          is_host: u.is_host,
          mic_on: u.mic_on || false,
          camera_on: u.camera_on || false,
          idle: !!u.idle,
          idle_since: u.idle_since || null,
        };
      });
      convRenderParticipants();
      convShowScreen(convActive);
      livekitConnectVideo();
      convRequestRoomSnapshot();
      break;

    case "room_snapshot":
      convApplyRoomSnapshot(msg.users || []);
      break;

    case "user_joined":
      Object.entries(convUsers).forEach(([existingId, existingUser]) => {
        if (
          existingId !== msg.user.user_id &&
          existingUser?.idle &&
          convParticipantsMatch(existingUser, msg.user)
        ) {
          convRemoveParticipantCard(existingId);
          delete convUsers[existingId];
        }
      });
      convUsers[msg.user.user_id] = {
        name: msg.user.name,
        language: msg.user.language,
        is_host: msg.user.is_host,
        mic_on: false,
        camera_on: msg.user.camera_on || false,
        idle: !!msg.user.idle,
        idle_since: msg.user.idle_since || null,
      };
      convRenderParticipants();
      if (!msg.user.idle) {
        convAddSystemMsg(`${msg.user.name} joined the room.`);
      }
      break;

    case "user_left":
      livekitDetachRemoteVideo(msg.user_id);
      convClearTyping(msg.user_id);
      if (convUsers[msg.user_id]?.idle) {
        // Keep the card visible — idle participants stay on screen
      } else {
        convStopIdleTimer(msg.user_id);
        delete convUsers[msg.user_id];
        convRenderParticipants();
        convAddSystemMsg(`${msg.name} left the room.`);
      }
      break;

    case "webrtc_offer":
      rtcHandleOffer(msg.from_id, msg.sdp);
      break;
    case "webrtc_answer":
      rtcHandleAnswer(msg.from_id, msg.sdp);
      break;
    case "webrtc_ice":
      rtcHandleIce(msg.from_id, msg.candidate);
      break;

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
      else convClearTyping(msg.user_id);
      break;

    case "user_mic_status":
      if (convUsers[msg.user_id]) convUsers[msg.user_id].mic_on = msg.is_on;
      convUpdateChipMic(msg.user_id, msg.is_on);
      break;

    case "user_idle_status":
      convSetUserIdle(msg.user_id, !!msg.is_idle, msg.idle_since || null);
      break;

    case "user_camera_status":
      if (convUsers[msg.user_id]) convUsers[msg.user_id].camera_on = msg.is_on;
      convUpdateChipCam(msg.user_id, msg.is_on);
      // Zoom-style: explicit signal beats relying on track mute events,
      // which Safari does not reliably fire after replaceTrack(null).
      // Hide the video and show the initials placeholder.
      {
        const vid = document.getElementById(`conv-card-vid-${msg.user_id}`);
        const ph = document.getElementById(`conv-card-ph-${msg.user_id}`);
        if (msg.is_on) {
          if (vid) vid.style.display = "block";
          if (ph) ph.style.display = "none";
          vid?.play().catch(() => {});
        } else {
          if (vid) {
            try {
              vid.pause();
            } catch {}
            vid.style.display = "none";
          }
          if (ph) ph.style.display = "";
        }
      }
      break;

    case "interrupted": {
      const interruptedName = msg.interrupted_name;
      const byName =
        msg.by_name || (convUsers[msg.interrupted_by_id]?.name ?? "Someone");
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

async function convMicPermissionState() {
  if (!navigator.permissions?.query) return "unknown";
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    return status.state || "unknown";
  } catch {
    return "unknown";
  }
}

function convBlockedMicMessage() {
  return (
    "Microphone permission is blocked for this site.\n\n" +
    "Browser check:\n" +
    "  Click the lock icon in the address bar\n" +
    "  → Site Settings → Microphone → Allow → reload the page.\n\n" +
    "macOS check:\n" +
    "  System Settings → Privacy & Security → Microphone\n" +
    "  → make sure your browser is toggled ON."
  );
}

function convMicUnavailableMessage(permissionState = "unknown") {
  if (permissionState === "denied") return convBlockedMicMessage();
  if (_isSafari) {
    return (
      "Microphone could not start.\n\n" +
      "Safari can block the mic when another tab, window, or app is already using it. " +
      "Close other mic sessions, reload this page, then tap the mic again.\n\n" +
      "If Safari asks for microphone permission, choose Allow."
    );
  }
  return (
    "Microphone could not start.\n\n" +
    "If the browser asks for permission, choose Allow. If it does not ask, reload the page " +
    "and check the lock icon in the address bar for microphone settings."
  );
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
        "Open this app via HTTPS or http://localhost instead of a plain HTTP address.",
    );
    return;
  }

  const permissionState = await convMicPermissionState();
  if (permissionState === "denied") {
    alert(convBlockedMicMessage());
    return;
  }

  const selectedLang = convUsers[convUserId]?.language || convLangSelect.value || "en";
  const lang = LANG_LOCALES[selectedLang] || "en-US";

  convFinalText = "";
  _recognitionRestartCount = 0;
  convRecognition = new SpeechRecognition();
  convRecognition.continuous = true;
  convRecognition.interimResults = true;
  convRecognition.lang = lang;

  convRecognition.onresult = (e) => {
    _recognitionRestartCount = 0; // successful audio — reset the drop counter
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        convFinalText += e.results[i][0].transcript + " ";
        clearTimeout(convXlateTimer);
        convXlateTimer = setTimeout(() => {
          const text = convFinalText.trim();
          if (text && convWs?.readyState === WebSocket.OPEN) {
            convWs.send(
              JSON.stringify({ type: "speech", text, is_final: true }),
            );
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

  convRecognition.onerror = async (e) => {
    if (e.error === "not-allowed") {
      convStopListening();
      alert(convMicUnavailableMessage(await convMicPermissionState()));
    } else if (e.error === "service-not-allowed") {
      // On Safari/iOS, "service-not-allowed" has two causes:
      // 1. Page is served over plain HTTP (not HTTPS) — Safari blocks STT on HTTP
      // 2. iOS Dictation is disabled in Settings (Settings → General → Keyboard → Enable Dictation)
      convStopListening();
      const isHttp = window.location.protocol !== "https:";
      const iosNote =
        _isIOS && !isHttp
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
              : "Check your internet connection and try again."),
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
  if (convRecognition) {
    convRecognition.stop();
    convRecognition = null;
  }
  convWs?.readyState === WebSocket.OPEN &&
    convWs.send(JSON.stringify({ type: "mic_status", is_on: false }));
  convSetMicUI(false);
  if (!_isSafari) webrtcStopAudio();
}

// ── Conversation mic — AudioContext → ScriptProcessorNode → Google STT ─────
// Raw LINEAR16 PCM is streamed continuously to /ws/stt/. Final transcripts
// from Google Cloud Speech are injected directly into the translation pipeline.
// This is the primary path for conversation mode across Android Chrome,
// iPhone Safari, iPhone Chrome, and desktop browsers so language handling is
// consistent for Tagalog and every supported participant language.

let _iosMicStream = null;
let _iosAudioCtx = null;
let _iosProcessor = null;
let _iosSttWs = null;
let _iosMicActive = false;
let _iosStarting = false; // guard against double-tap race
let _iosSttReconnectCount = 0;
const _IOS_STT_MAX_RECONNECT = 6;

function convCanUseBackendStt() {
  return !!(
    navigator.mediaDevices?.getUserMedia &&
    (window.AudioContext || window.webkitAudioContext) &&
    window.WebSocket
  );
}

async function convStartIosMic() {
  if (_iosStarting || _iosMicActive) return;
  _iosStarting = true;
  try {
    await _convStartIosMicInner();
  } catch (err) {
    console.error("[conversation mic] unexpected error during startup:", err);
    _iosMicStream?.getTracks().forEach((t) => t.stop());
    _iosMicStream = null;
    _iosAudioCtx?.close();
    _iosAudioCtx = null;
    if (_iosSttWs && _iosSttWs.readyState < WebSocket.CLOSING)
      _iosSttWs.close();
    _iosSttWs = null;
    _iosProcessor = null;
  } finally {
    _iosStarting = false; // always reset — never leave the button locked
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
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  } catch {
    _micTrace("Tap to speak");
    alert(convMicUnavailableMessage(await convMicPermissionState()));
    return;
  }
  _micTrace("Mic granted, building audio context…");

  _iosAudioCtx = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: 16000,
  });
  await _iosAudioCtx.resume();
  const actualRate = Math.round(_iosAudioCtx.sampleRate);
  _micTrace(`AudioContext ready (${actualRate} Hz), connecting to STT…`);

  if (_iosSttWs && _iosSttWs.readyState < WebSocket.CLOSING) _iosSttWs.close();
  _iosSttWs = null;

  const lang = convUsers[convUserId]?.language || convLangSelect.value || "en";
  const wsUrl = _buildIosSttWsUrl();
  console.log(`[mic] STT language=${lang} WS URL:`, wsUrl);
  _iosSttWs = new WebSocket(wsUrl);
  _iosSttWs.binaryType = "arraybuffer";

  // Wait for WS to open (or fail)
  const opened = await new Promise((resolve) => {
    _iosSttWs.onopen = () => resolve(true);
    _iosSttWs.onerror = () => resolve(false);
    _iosSttWs.onclose = () => resolve(false);
  });

  if (!opened) {
    _micTrace("Tap to speak");
    console.error("[conversation mic] STT WS failed to open");
    alert(
      "Could not connect to transcription service.\n\nCheck that API keys are set on Render.",
    );
    _iosMicStream?.getTracks().forEach((t) => t.stop());
    _iosMicStream = null;
    _iosAudioCtx?.close();
    _iosAudioCtx = null;
    _iosSttWs = null;
    _iosStarting = false;
    return;
  }

  // /ws/stt/ requires a JSON config message before any audio bytes.
  _iosSttWs.send(JSON.stringify({ sample_rate: actualRate, language: lang }));
  _micTrace("STT connected, checking stability…");

  // Yield one event-loop turn so any immediate server-close fires onclose first
  let _sttCloseReason = "";
  _iosSttWs.onclose = (e) => {
    _sttCloseReason = e.reason || "";
    _iosSttWs = null;
  };
  _iosSttWs.onerror = () => {
    _iosSttWs = null;
  };
  await new Promise((r) => setTimeout(r, 50));

  if (!_iosSttWs || _iosSttWs.readyState !== WebSocket.OPEN) {
    _micTrace("Tap to speak");
    console.error("[conversation mic] STT WS closed immediately:", _sttCloseReason);
    alert(
      "Mic connection failed — server closed immediately.\n\n" +
        (_sttCloseReason
          ? `Reason: ${_sttCloseReason}`
          : "Check Render logs for details."),
    );
    _iosMicStream?.getTracks().forEach((t) => t.stop());
    _iosMicStream = null;
    _iosAudioCtx?.close();
    _iosAudioCtx = null;
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
  _iosProcessor.onaudioprocess = (e) => {
    if (_iosSttWs?.readyState !== WebSocket.OPEN) return;
    const f32 = e.inputBuffer.getChannelData(0);
    let sumSq = 0;
    for (let i = 0; i < f32.length; i++) sumSq += f32[i] * f32[i];
    const rms = Math.sqrt(sumSq / f32.length);
    if (rms > _peakRms) _peakRms = rms;
    _frameCount++;
    if (_frameCount % 25 === 0) {
      console.log(
        `[mic] frames=${_frameCount} peakRMS=${_peakRms.toFixed(4)} curRMS=${rms.toFixed(4)}`,
      );
    }
    const intensity = Math.min(1, Math.max(0, (rms - NOISE_GATE_RMS) / 0.08));
    const localCard = document.getElementById(`conv-card-${convUserId}`);
    if (localCard && localCard.classList.contains("mic-on")) {
      const isTalking = rms >= NOISE_GATE_RMS;
      localCard.classList.toggle("speaking", isTalking);
      if (isTalking) {
        localCard.style.setProperty("--conv-speaking-intensity", intensity.toFixed(3));
      } else {
        localCard.style.removeProperty("--conv-speaking-intensity");
      }
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
  _iosSttReconnectCount = 0; // reset so next mic-on starts fresh
  if (_iosProcessor) {
    _iosProcessor.disconnect();
    _iosProcessor = null;
  }
  if (_iosAudioCtx) {
    _iosAudioCtx.close();
    _iosAudioCtx = null;
  }
  if (_iosSttWs && _iosSttWs.readyState < WebSocket.CLOSING) _iosSttWs.close();
  _iosSttWs = null;
  _iosMicStream?.getTracks().forEach((t) => t.stop());
  _iosMicStream = null;
  convSetMicUI(false);
  convMicLabel.textContent = "Tap to speak";
  convWs?.readyState === WebSocket.OPEN &&
    convWs.send(JSON.stringify({ type: "mic_status", is_on: false }));
}

function _buildIosSttWsUrl() {
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsBase = (API_BASE || location.origin).replace(/^https?:/, wsProto);
  return `${wsBase}/ws/stt/${convRoomId}/${convUserId}`;
}

function _onIosSttDrop() {
  if (!_iosSttWs) return; // onerror + onclose both call this; only handle once
  _iosSttWs = null;
  if (_iosMicActive) _scheduleIosSttReconnect();
}

function convSendPresence(isIdle) {
  if (!convUserId) return;
  const idleSince = isIdle
    ? convUsers[convUserId]?.idle_since || Date.now()
    : null;
  convSetUserIdle(convUserId, isIdle, idleSince);
  if (isIdle) {
    if (convIsListening) convStopListening();
    if (_iosMicActive) convStopIosMic();
  }
  if (convWs?.readyState === WebSocket.OPEN) {
    convWs.send(JSON.stringify({ type: "presence", is_idle: isIdle, idle_since: idleSince }));
  }
}

document.addEventListener("visibilitychange", () => {
  if (!convUserId) return;
  convSendPresence(document.hidden);
  if (!document.hidden) convRequestRoomSnapshot();
});

window.addEventListener("focus", () => {
  if (convUserId) convRequestRoomSnapshot();
});

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
  const lang = convUsers[convUserId]?.language || convLangSelect.value || "en";
  const sampleRate = Math.round(_iosAudioCtx.sampleRate);
  const ws = new WebSocket(_buildIosSttWsUrl());
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    ws.send(JSON.stringify({ sample_rate: sampleRate, language: lang }));
    _iosSttWs = ws;
    _micTrace("Listening…");
    ws.onclose = ws.onerror = _onIosSttDrop;
    // Only reset backoff counter after connection stays alive for 5 s
    setTimeout(() => {
      if (_iosSttWs === ws) _iosSttReconnectCount = 0;
    }, 5000);
  };
  ws.onclose = ws.onerror = () => {
    if (_iosMicActive) _scheduleIosSttReconnect();
  };
}

convMicBtn.addEventListener("click", () => {
  _unlockTts();
  if (convCanUseBackendStt()) {
    if (_iosMicActive) {
      convStopIosMic();
    } else {
      convStartIosMic();
    }
  } else {
    convIsListening ? convStopListening() : convStartListening();
  }
});

function convSetTtsUI() {
  if (!convTtsBtn || !convTtsLabel) return;
  convTtsBtn.classList.toggle("tts-off", !_ttsSpeakerMode);
  convTtsBtn
    .querySelector("i")
    ?.setAttribute("data-lucide", _ttsSpeakerMode ? "volume-2" : "volume-1");
  convTtsLabel.textContent = _ttsSpeakerMode ? "Speaker" : "Ear mode";
  lucide.createIcons({ nodes: [convTtsBtn] });
}

convTtsBtn?.addEventListener("click", () => {
  _unlockTts();
  _ttsEnabled = true;
  _ttsSpeakerMode = !_ttsSpeakerMode;
  convSetTtsUI();
});
convSetTtsUI();

// ── Conversation summary ───────────────────────────────────────────────────
const SUMMARY_UI_COPY = {
  en: {
    title: "Conversation Summary",
    button: "Summarize",
    loadingButton: "Summarizing...",
    preparing: "Preparing summary...",
    empty: "No finalized conversation messages yet.",
    failed: "Could not summarize conversation.",
    requestFailed: "Summary failed",
  },
  es: {
    title: "Resumen de la conversación",
    button: "Resumir",
    loadingButton: "Resumiendo...",
    preparing: "Preparando el resumen...",
    empty: "Todavía no hay mensajes finales de la conversación.",
    failed: "No se pudo resumir la conversación.",
    requestFailed: "No se pudo generar el resumen",
  },
  fr: {
    title: "Résumé de la conversation",
    button: "Résumer",
    loadingButton: "Résumé en cours...",
    preparing: "Préparation du résumé...",
    empty: "Aucun message finalisé de la conversation pour le moment.",
    failed: "Impossible de résumer la conversation.",
    requestFailed: "Échec du résumé",
  },
  de: {
    title: "Gesprächszusammenfassung",
    button: "Zusammenfassen",
    loadingButton: "Wird zusammengefasst...",
    preparing: "Zusammenfassung wird vorbereitet...",
    empty: "Noch keine finalisierten Gesprächsnachrichten vorhanden.",
    failed: "Das Gespräch konnte nicht zusammengefasst werden.",
    requestFailed: "Zusammenfassung fehlgeschlagen",
  },
  it: {
    title: "Riepilogo della conversazione",
    button: "Riassumi",
    loadingButton: "Riassunto in corso...",
    preparing: "Preparazione del riepilogo...",
    empty: "Non ci sono ancora messaggi finali della conversazione.",
    failed: "Impossibile riassumere la conversazione.",
    requestFailed: "Riepilogo non riuscito",
  },
  pt: {
    title: "Resumo da conversa",
    button: "Resumir",
    loadingButton: "Resumindo...",
    preparing: "Preparando resumo...",
    empty: "Ainda não há mensagens finalizadas da conversa.",
    failed: "Não foi possível resumir a conversa.",
    requestFailed: "Falha ao resumir",
  },
  zh: {
    title: "对话摘要",
    button: "总结",
    loadingButton: "正在总结...",
    preparing: "正在准备摘要...",
    empty: "还没有已完成的对话消息。",
    failed: "无法总结对话。",
    requestFailed: "摘要失败",
  },
  ja: {
    title: "会話の要約",
    button: "要約",
    loadingButton: "要約中...",
    preparing: "要約を準備しています...",
    empty: "確定した会話メッセージはまだありません。",
    failed: "会話を要約できませんでした。",
    requestFailed: "要約に失敗しました",
  },
  ko: {
    title: "대화 요약",
    button: "요약",
    loadingButton: "요약 중...",
    preparing: "요약을 준비 중...",
    empty: "아직 확정된 대화 메시지가 없습니다.",
    failed: "대화를 요약할 수 없습니다.",
    requestFailed: "요약 실패",
  },
  ar: {
    title: "ملخص المحادثة",
    button: "تلخيص",
    loadingButton: "جارٍ التلخيص...",
    preparing: "جارٍ إعداد الملخص...",
    empty: "لا توجد رسائل محادثة نهائية بعد.",
    failed: "تعذر تلخيص المحادثة.",
    requestFailed: "فشل التلخيص",
  },
  ru: {
    title: "Сводка разговора",
    button: "Сводка",
    loadingButton: "Создание сводки...",
    preparing: "Подготовка сводки...",
    empty: "Пока нет завершенных сообщений разговора.",
    failed: "Не удалось создать сводку разговора.",
    requestFailed: "Не удалось создать сводку",
  },
  hi: {
    title: "बातचीत का सारांश",
    button: "सारांश",
    loadingButton: "सारांश बनाया जा रहा है...",
    preparing: "सारांश तैयार किया जा रहा है...",
    empty: "अभी तक कोई अंतिम बातचीत संदेश नहीं है।",
    failed: "बातचीत का सारांश नहीं बनाया जा सका।",
    requestFailed: "सारांश विफल रहा",
  },
  nl: {
    title: "Gesprekssamenvatting",
    button: "Samenvatten",
    loadingButton: "Samenvatten...",
    preparing: "Samenvatting voorbereiden...",
    empty: "Er zijn nog geen definitieve gespreksberichten.",
    failed: "Kan het gesprek niet samenvatten.",
    requestFailed: "Samenvatting mislukt",
  },
  pl: {
    title: "Podsumowanie rozmowy",
    button: "Podsumuj",
    loadingButton: "Podsumowywanie...",
    preparing: "Przygotowywanie podsumowania...",
    empty: "Nie ma jeszcze zakończonych wiadomości z rozmowy.",
    failed: "Nie udało się podsumować rozmowy.",
    requestFailed: "Podsumowanie nie powiodło się",
  },
  tr: {
    title: "Görüşme özeti",
    button: "Özetle",
    loadingButton: "Özetleniyor...",
    preparing: "Özet hazırlanıyor...",
    empty: "Henüz kesinleşmiş konuşma mesajı yok.",
    failed: "Görüşme özetlenemedi.",
    requestFailed: "Özet başarısız oldu",
  },
  tl: {
    title: "Buod ng pag-uusap",
    button: "Ibuod",
    loadingButton: "Binubuod...",
    preparing: "Inihahanda ang buod...",
    empty: "Wala pang pinal na mensahe sa pag-uusap.",
    failed: "Hindi maibuod ang pag-uusap.",
    requestFailed: "Nabigo ang pagbubuod",
  },
};

const SUMMARY_SECTION_COPY = {
  en: {
    mainGoal: "Main Goal",
    importantDiscussions: "Important Discussions",
    takeaways: "Takeaways",
    actionItems: "Who Needs To Work On What",
    followUps: "Who Needs To Get Back To Whom",
    secondMeeting: "Second Meeting",
    reconveneNotes: "Reconvene Notes",
    notIdentified: "Not identified",
    deliverable: "Deliverable",
    due: "Due",
    timing: "Timing",
  },
  es: {
    mainGoal: "Objetivo principal",
    importantDiscussions: "Discusiones importantes",
    takeaways: "Conclusiones",
    actionItems: "Quién debe trabajar en qué",
    followUps: "Quién debe responder a quién",
    secondMeeting: "Segunda reunión",
    reconveneNotes: "Notas para retomar",
    notIdentified: "No identificado",
    deliverable: "Entregable",
    due: "Fecha límite",
    timing: "Momento",
  },
  fr: {
    mainGoal: "Objectif principal",
    importantDiscussions: "Discussions importantes",
    takeaways: "Points à retenir",
    actionItems: "Qui doit travailler sur quoi",
    followUps: "Qui doit revenir vers qui",
    secondMeeting: "Deuxième réunion",
    reconveneNotes: "Notes de reprise",
    notIdentified: "Non identifié",
    deliverable: "Livrable",
    due: "Échéance",
    timing: "Calendrier",
  },
  de: {
    mainGoal: "Hauptziel",
    importantDiscussions: "Wichtige Diskussionen",
    takeaways: "Erkenntnisse",
    actionItems: "Wer woran arbeiten muss",
    followUps: "Wer sich bei wem melden muss",
    secondMeeting: "Zweites Treffen",
    reconveneNotes: "Notizen zum Wiederaufnehmen",
    notIdentified: "Nicht identifiziert",
    deliverable: "Ergebnis",
    due: "Fällig",
    timing: "Zeitpunkt",
  },
  it: {
    mainGoal: "Obiettivo principale",
    importantDiscussions: "Discussioni importanti",
    takeaways: "Conclusioni",
    actionItems: "Chi deve lavorare su cosa",
    followUps: "Chi deve ricontattare chi",
    secondMeeting: "Seconda riunione",
    reconveneNotes: "Note per riconvocarsi",
    notIdentified: "Non identificato",
    deliverable: "Consegna",
    due: "Scadenza",
    timing: "Tempistica",
  },
  pt: {
    mainGoal: "Objetivo principal",
    importantDiscussions: "Discussões importantes",
    takeaways: "Conclusões",
    actionItems: "Quem precisa trabalhar em quê",
    followUps: "Quem precisa retornar para quem",
    secondMeeting: "Segunda reunião",
    reconveneNotes: "Notas para retomada",
    notIdentified: "Não identificado",
    deliverable: "Entregável",
    due: "Prazo",
    timing: "Momento",
  },
  zh: {
    mainGoal: "主要目标",
    importantDiscussions: "重要讨论",
    takeaways: "要点",
    actionItems: "谁需要负责什么",
    followUps: "谁需要回复谁",
    secondMeeting: "第二次会议",
    reconveneNotes: "重新开会说明",
    notIdentified: "未确定",
    deliverable: "交付物",
    due: "截止日期",
    timing: "时间安排",
  },
  ja: {
    mainGoal: "主な目的",
    importantDiscussions: "重要な議論",
    takeaways: "要点",
    actionItems: "誰が何に取り組むべきか",
    followUps: "誰が誰に連絡するべきか",
    secondMeeting: "2回目の会議",
    reconveneNotes: "再集合メモ",
    notIdentified: "特定されていません",
    deliverable: "成果物",
    due: "期限",
    timing: "時期",
  },
  ko: {
    mainGoal: "주요 목표",
    importantDiscussions: "중요한 논의",
    takeaways: "핵심 내용",
    actionItems: "누가 무엇을 해야 하는지",
    followUps: "누가 누구에게 회신해야 하는지",
    secondMeeting: "두 번째 회의",
    reconveneNotes: "재소집 메모",
    notIdentified: "확인되지 않음",
    deliverable: "산출물",
    due: "기한",
    timing: "시점",
  },
  ar: {
    mainGoal: "الهدف الرئيسي",
    importantDiscussions: "النقاشات المهمة",
    takeaways: "الخلاصات",
    actionItems: "من يحتاج إلى العمل على ماذا",
    followUps: "من يحتاج إلى الرجوع إلى من",
    secondMeeting: "الاجتماع الثاني",
    reconveneNotes: "ملاحظات إعادة الاجتماع",
    notIdentified: "غير محدد",
    deliverable: "المخرج",
    due: "الموعد النهائي",
    timing: "التوقيت",
  },
  ru: {
    mainGoal: "Главная цель",
    importantDiscussions: "Важные обсуждения",
    takeaways: "Выводы",
    actionItems: "Кто над чем должен работать",
    followUps: "Кто с кем должен связаться",
    secondMeeting: "Вторая встреча",
    reconveneNotes: "Заметки для повторной встречи",
    notIdentified: "Не определено",
    deliverable: "Результат",
    due: "Срок",
    timing: "Время",
  },
  hi: {
    mainGoal: "मुख्य लक्ष्य",
    importantDiscussions: "महत्वपूर्ण चर्चाएँ",
    takeaways: "मुख्य निष्कर्ष",
    actionItems: "किसे किस पर काम करना है",
    followUps: "किसे किससे संपर्क करना है",
    secondMeeting: "दूसरी बैठक",
    reconveneNotes: "फिर से मिलने के नोट्स",
    notIdentified: "पहचाना नहीं गया",
    deliverable: "डिलिवरेबल",
    due: "समय सीमा",
    timing: "समय",
  },
  nl: {
    mainGoal: "Hoofddoel",
    importantDiscussions: "Belangrijke besprekingen",
    takeaways: "Belangrijkste punten",
    actionItems: "Wie waaraan moet werken",
    followUps: "Wie bij wie moet terugkomen",
    secondMeeting: "Tweede vergadering",
    reconveneNotes: "Notities voor opnieuw samenkomen",
    notIdentified: "Niet geïdentificeerd",
    deliverable: "Op te leveren resultaat",
    due: "Deadline",
    timing: "Timing",
  },
  pl: {
    mainGoal: "Główny cel",
    importantDiscussions: "Ważne dyskusje",
    takeaways: "Wnioski",
    actionItems: "Kto nad czym ma pracować",
    followUps: "Kto ma wrócić do kogo",
    secondMeeting: "Drugie spotkanie",
    reconveneNotes: "Notatki do ponownego spotkania",
    notIdentified: "Nie określono",
    deliverable: "Rezultat",
    due: "Termin",
    timing: "Czas",
  },
  tr: {
    mainGoal: "Ana hedef",
    importantDiscussions: "Önemli görüşmeler",
    takeaways: "Çıkarımlar",
    actionItems: "Kim ne üzerinde çalışmalı",
    followUps: "Kim kime geri dönmeli",
    secondMeeting: "İkinci toplantı",
    reconveneNotes: "Yeniden toplanma notları",
    notIdentified: "Belirlenmedi",
    deliverable: "Teslimat",
    due: "Son tarih",
    timing: "Zamanlama",
  },
  tl: {
    mainGoal: "Pangunahing layunin",
    importantDiscussions: "Mahahalagang napag-usapan",
    takeaways: "Mahahalagang punto",
    actionItems: "Sino ang kailangang gumawa ng ano",
    followUps: "Sino ang kailangang bumalik kanino",
    secondMeeting: "Ikalawang pagpupulong",
    reconveneNotes: "Mga tala sa muling pagpupulong",
    notIdentified: "Hindi natukoy",
    deliverable: "Ihahatid",
    due: "Takdang petsa",
    timing: "Oras",
  },
};

function convSummaryLanguage() {
  return convUsers[convUserId]?.language || convLangSelect.value || "en";
}

function convSummaryCopy() {
  return SUMMARY_UI_COPY[convSummaryLanguage()] || SUMMARY_UI_COPY.en;
}

function convSummarySectionCopy() {
  return SUMMARY_SECTION_COPY[convSummaryLanguage()] || SUMMARY_SECTION_COPY.en;
}

function convSetSummaryLoading(isLoading) {
  if (!convSummaryBtn || !convSummaryLabel) return;
  const copy = convSummaryCopy();
  convSummaryBtn.disabled = isLoading;
  convSummaryLabel.textContent = isLoading ? copy.loadingButton : copy.button;
}

function convSummaryList(items) {
  const sectionCopy = convSummarySectionCopy();
  const rows = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!rows.length) return `<p>${escapeHtml(sectionCopy.notIdentified)}</p>`;
  return `<ul>${rows.map((item) => `<li>${escapeHtml(String(item))}</li>`).join("")}</ul>`;
}

function convSummaryActions(items) {
  const sectionCopy = convSummarySectionCopy();
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return `<p>${escapeHtml(sectionCopy.notIdentified)}</p>`;
  return `<div class="conv-summary-actions">${rows.map((item) => `
    <div class="conv-summary-action">
      <strong>${escapeHtml(item.owner || sectionCopy.notIdentified)}</strong>
      <span>${escapeHtml(item.task || sectionCopy.notIdentified)}</span>
      <small>${escapeHtml(sectionCopy.deliverable)}: ${escapeHtml(item.deliverable || sectionCopy.notIdentified)} · ${escapeHtml(sectionCopy.due)}: ${escapeHtml(item.due_date || sectionCopy.notIdentified)}</small>
    </div>
  `).join("")}</div>`;
}

function convSummaryFollowUps(items) {
  const sectionCopy = convSummarySectionCopy();
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return `<p>${escapeHtml(sectionCopy.notIdentified)}</p>`;
  return `<div class="conv-summary-actions">${rows.map((item) => `
    <div class="conv-summary-action">
      <strong>${escapeHtml(item.owner || sectionCopy.notIdentified)} → ${escapeHtml(item.with_whom || sectionCopy.notIdentified)}</strong>
      <span>${escapeHtml(item.reason || sectionCopy.notIdentified)}</span>
      <small>${escapeHtml(sectionCopy.timing)}: ${escapeHtml(item.timing || sectionCopy.notIdentified)}</small>
    </div>
  `).join("")}</div>`;
}

function convNormalizeSummaryText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function convReadBoardMessagesForSummary() {
  if (!convMessages) return [];

  return Array.from(convMessages.querySelectorAll(".conv-bubble"))
    .map((bubble) => {
      const speaker = convNormalizeSummaryText(
        bubble.querySelector(".conv-bubble-name")?.textContent,
      );
      const shownText = convNormalizeSummaryText(
        bubble.querySelector(".conv-bubble-main")?.textContent,
      );
      if (!speaker || !shownText) return null;

      const isSelf = bubble.classList.contains("self");
      return {
        speaker,
        original: shownText,
        translation: "",
        shown_text: shownText,
        is_self: isSelf,
        source: "discussion_board",
        timestamp: "",
      };
    })
    .filter(Boolean);
}

function convMessagesForSummary() {
  const rows = [];
  const seen = new Set();
  const addRow = (message) => {
    const speaker = convNormalizeSummaryText(message.speaker);
    const shownText = convNormalizeSummaryText(
      message.shown_text || message.original || message.translation,
    );
    const original = convNormalizeSummaryText(message.original);
    const translation = convNormalizeSummaryText(message.translation);
    if (!speaker || !shownText) return;

    const key = `${speaker}\u0000${shownText}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      speaker,
      original: original || shownText,
      translation,
      shown_text: shownText,
      is_self: !!message.is_self,
      source: message.source || "transcript",
      timestamp: message.timestamp || "",
    });
  };

  convTranscript.forEach(addRow);
  convReadBoardMessagesForSummary().forEach(addRow);
  return rows;
}

function convSummaryHtml(summary) {
  const sectionCopy = convSummarySectionCopy();
  return `
    <section><h3>${escapeHtml(sectionCopy.mainGoal)}</h3><p>${escapeHtml(summary.main_goal || sectionCopy.notIdentified)}</p></section>
    <section><h3>${escapeHtml(sectionCopy.importantDiscussions)}</h3>${convSummaryList(summary.important_discussions)}</section>
    <section><h3>${escapeHtml(sectionCopy.takeaways)}</h3>${convSummaryList(summary.takeaways)}</section>
    <section><h3>${escapeHtml(sectionCopy.actionItems)}</h3>${convSummaryActions(summary.action_items)}</section>
    <section><h3>${escapeHtml(sectionCopy.followUps)}</h3>${convSummaryFollowUps(summary.follow_ups)}</section>
    <section><h3>${escapeHtml(sectionCopy.secondMeeting)}</h3><p>${escapeHtml(summary.second_meeting || sectionCopy.notIdentified)}</p></section>
    <section><h3>${escapeHtml(sectionCopy.reconveneNotes)}</h3>${convSummaryList(summary.reconvene_notes)}</section>
  `;
}

function convRenderSummary(summary) {
  convSummaryBody.innerHTML = convSummaryHtml(summary);
}

function convBuildSummaryPayload(messages, summary = null) {
  const participants = Object.values(convUsers).map((u) => u.name).filter(Boolean);
  return {
    messages,
    participants,
    participant_emails: currentUserEmail ? [currentUserEmail] : [],
    target_language: convSummaryLanguage(),
    room_id: convRoomId || getConversationRoomCode() || "",
    ...(summary ? { summary } : {}),
  };
}

async function convOpenSummary() {
  if (!convSummaryModal || !convSummaryBody) return;
  if (!convRequireLogin()) return;
  const copy = convSummaryCopy();
  convSummaryModal.style.display = "flex";
  if (convSummaryTitle) convSummaryTitle.textContent = copy.title;
  if (convSummarySaveBtn) convSummarySaveBtn.style.display = "none";
  convLastSummaryPayload = null;
  convSummaryBody.innerHTML = `<p>${escapeHtml(copy.preparing)}</p>`;
  lucide.createIcons({ nodes: [convSummaryModal] });

  const messages = convMessagesForSummary();
  if (!messages.length) {
    convSummaryBody.innerHTML = `<p>${escapeHtml(copy.empty)}</p>`;
    return;
  }

  convSetSummaryLoading(true);
  try {
    const res = await fetch(`${API_BASE}/api/v1/conversation/summary`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${currentUserToken || ""}`,
      },
      body: JSON.stringify(convBuildSummaryPayload(messages)),
    });
    if (!res.ok) throw new Error((await res.json()).detail || copy.requestFailed);
    const summary = await res.json();
    convLastSummaryPayload = convBuildSummaryPayload(messages, summary);
    convRenderSummary(summary);
    if (convSummarySaveBtn) convSummarySaveBtn.style.display = "inline-flex";
  } catch (e) {
    convSummaryBody.innerHTML = `<p>${escapeHtml(e.message || copy.failed)}</p>`;
  } finally {
    convSetSummaryLoading(false);
  }
}

async function convSaveCurrentSummary() {
  if (!convRequireLogin() || !convLastSummaryPayload) return;
  if (!convSummarySaveBtn) return;
  convSummarySaveBtn.disabled = true;
  const label = convSummarySaveBtn.querySelector("span");
  const previous = label?.textContent || "Save";
  if (label) label.textContent = "Saving...";
  try {
    const res = await fetch(`${API_BASE}/api/v1/conversation/history/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${currentUserToken || ""}`,
      },
      body: JSON.stringify(convLastSummaryPayload),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Save failed");
    const saved = await res.json();
    if (label) label.textContent = "Saved";
    convSummarySaveBtn.title = `Saved ${saved.local_date}`;
    const timestamp = saved.updated_at || new Date().toISOString();
    convSummaryBody.insertAdjacentHTML(
      "afterbegin",
      `<p class="conv-summary-saved-stamp">Saved ${escapeHtml(timestamp)}</p>`,
    );
    showToast("Summary and full chat saved.", "success");
    setTimeout(() => {
      if (label) label.textContent = previous;
    }, 1500);
  } catch (err) {
    showToast(err.message || "Save failed", "error");
    if (label) label.textContent = previous;
  } finally {
    convSummarySaveBtn.disabled = false;
  }
}

convSummaryBtn?.addEventListener("click", convOpenSummary);
convSummarySaveBtn?.addEventListener("click", convSaveCurrentSummary);
convSummaryClose?.addEventListener("click", () => {
  convSummaryModal.style.display = "none";
});
convSummaryModal?.addEventListener("click", (e) => {
  if (e.target === convSummaryModal) convSummaryModal.style.display = "none";
});

function convHistoryHeaders(extra = {}) {
  return {
    ...extra,
    Authorization: `Bearer ${currentUserToken || ""}`,
  };
}

function convRequireLogin() {
  if (currentUserToken) return true;
  showAuthModal("login");
  return false;
}

function convShowSummaryModal(title, html) {
  if (!convSummaryModal || !convSummaryBody) return;
  convSummaryModal.style.display = "flex";
  if (convSummaryTitle) convSummaryTitle.textContent = title;
  convSummaryBody.innerHTML = html;
  lucide.createIcons({ nodes: [convSummaryModal] });
}

function convShowAdminPanel(title, html) {
  if (!adminTab) return;
  adminTab.innerHTML = `
    <div class="admin-panel-wrap">
      <div class="admin-panel-header">
        <h2 class="admin-panel-title">${title}</h2>
      </div>
      <div class="admin-panel-body">${html}</div>
    </div>
  `;
  lucide.createIcons({ nodes: [adminTab] });
}

function convHistoryDateRangeHtml() {
  const today = new Date().toISOString().slice(0, 10);
  return `
    <div class="conv-history-toolbar">
      <label>From <input type="date" id="convHistoryStart"></label>
      <label>To <input type="date" id="convHistoryEnd" value="${today}"></label>
      <button type="button" class="btn btn-secondary" id="convHistorySearchBtn">
        <i data-lucide="search"></i><span>List</span>
      </button>
    </div>
    <div id="convHistoryList" class="conv-history-list">
      <p>Choose a date range to list saved chat summaries.</p>
    </div>
  `;
}

async function convOpenHistory() {
  if (!convRequireLogin()) return;
  convShowSummaryModal("Conversation History", convHistoryDateRangeHtml());
  document.getElementById("convHistorySearchBtn")?.addEventListener("click", convLoadHistoryDates);
  await convLoadHistoryDates();
}

async function convLoadHistoryDates() {
  const list = document.getElementById("convHistoryList");
  if (!list) return;
  const params = new URLSearchParams();
  const start = document.getElementById("convHistoryStart")?.value || "";
  const end = document.getElementById("convHistoryEnd")?.value || "";
  if (start) params.set("start_date", start);
  if (end) params.set("end_date", end);
  list.innerHTML = "<p>Loading history...</p>";
  try {
    const res = await fetch(`${API_BASE}/api/v1/conversation/history/dates?${params}`, {
      headers: convHistoryHeaders(),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Could not load history");
    const data = await res.json();
    const dates = Array.isArray(data.dates) ? data.dates : [];
    if (!dates.length) {
      list.innerHTML = "<p>No saved conversation history found for that range.</p>";
      return;
    }
    list.innerHTML = dates.map((item) => `
      <button type="button" class="conv-history-date" data-date="${escapeHtml(item.date)}">
        <strong>${escapeHtml(item.date)}</strong>
        <span>${escapeHtml(String(item.count))} saved summar${item.count === 1 ? "y" : "ies"}</span>
        <small>${escapeHtml((item.participants || []).join(", ") || "No participants listed")}</small>
      </button>
    `).join("");
    list.querySelectorAll(".conv-history-date").forEach((btn) => {
      btn.addEventListener("click", () => convOpenHistoryDate(btn.dataset.date));
    });
  } catch (err) {
    list.innerHTML = `<p>${escapeHtml(err.message || "Could not load history")}</p>`;
  }
}

async function convOpenHistoryDate(date) {
  if (!date || !convRequireLogin()) return;
  convShowSummaryModal(`Conversation History - ${date}`, "<p>Loading saved summary...</p>");
  try {
    const res = await fetch(`${API_BASE}/api/v1/conversation/history/date/${encodeURIComponent(date)}`, {
      headers: convHistoryHeaders(),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Could not load saved summary");
    const data = await res.json();
    const records = Array.isArray(data.records) ? data.records : [];
    if (!records.length) {
      convSummaryBody.innerHTML = "<p>No history remains for this date.</p>";
      return;
    }
    convSummaryBody.innerHTML = `
      <div class="conv-history-toolbar">
        <button type="button" class="btn btn-secondary" id="convHistoryBackBtn">
          <i data-lucide="arrow-left"></i><span>Back</span>
        </button>
        <button type="button" class="btn btn-secondary danger" id="convHistoryDeleteDateBtn">
          <i data-lucide="trash-2"></i><span>Delete date</span>
        </button>
      </div>
      <div class="conv-history-records">
        ${records.map((record) => `
          <section class="conv-history-record">
            <div class="conv-history-record-head">
              <strong>${escapeHtml(record.created_at || record.local_date || date)}</strong>
              <button type="button" class="btn btn-secondary conv-history-email-btn" data-record-id="${escapeHtml(record.id)}">
                <i data-lucide="mail"></i><span>Email</span>
              </button>
            </div>
            <p class="conv-history-meta">Room ${escapeHtml(record.room_id || "Not identified")} · ${escapeHtml((record.participants || []).join(", ") || "No participants listed")} · ${escapeHtml(String(record.metadata?.message_count || 0))} chat messages</p>
            ${convSummaryHtml(record.summary || {})}
          </section>
        `).join("")}
      </div>
    `;
    document.getElementById("convHistoryBackBtn")?.addEventListener("click", convOpenHistory);
    document.getElementById("convHistoryDeleteDateBtn")?.addEventListener("click", () => convDeleteHistoryDate(date));
    convSummaryBody.querySelectorAll(".conv-history-email-btn").forEach((btn) => {
      btn.addEventListener("click", () => convEmailHistoryRecord(btn.dataset.recordId));
    });
    lucide.createIcons({ nodes: [convSummaryModal] });
  } catch (err) {
    convSummaryBody.innerHTML = `<p>${escapeHtml(err.message || "Could not load saved summary")}</p>`;
  }
}

async function convDeleteHistoryDate(date) {
  if (!confirm(`Delete all saved summaries and full chat sources for ${date}?`)) return;
  try {
    const res = await fetch(`${API_BASE}/api/v1/conversation/history/date/${encodeURIComponent(date)}`, {
      method: "DELETE",
      headers: convHistoryHeaders(),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Delete failed");
    await convOpenHistory();
  } catch (err) {
    alert(err.message || "Delete failed");
  }
}

async function convEmailHistoryRecord(recordId) {
  const recipient = prompt("Email conversation history to:");
  if (!recipient) return;
  const choice = prompt(
    "What should be emailed?\n1 = Summary and full chat\n2 = Summary only\n3 = Full chat only",
    "1",
  );
  if (!choice) return;
  const contentType =
    choice.trim() === "2" ? "summary" : choice.trim() === "3" ? "chat" : "both";
  try {
    const res = await fetch(`${API_BASE}/api/v1/conversation/history/record/${encodeURIComponent(recordId)}/email`, {
      method: "POST",
      headers: convHistoryHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ recipient: recipient.trim(), content_type: contentType }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Email failed");
    alert("History email queued.");
  } catch (err) {
    alert(err.message || "Email failed");
  }
}

function convAdminAuthHtml(mode = "login") {
  const isCreate = mode === "create";
  return `
    <div class="conv-admin-auth">
      <div class="conv-admin-tabs">
        <button type="button" class="${!isCreate ? "active" : ""}" id="convAdminLoginTab">Login</button>
        <button type="button" class="${isCreate ? "active" : ""}" id="convAdminCreateTab">Create Account</button>
      </div>
      <label>Email <input type="email" id="convAdminEmailInput" placeholder="admin@company.com" value="${escapeHtml(convAdminEmail)}"></label>
      <label>Password <input type="password" id="convAdminPasswordInput" placeholder="Password"></label>
      <button type="button" class="btn btn-primary" id="convAdminSubmitBtn">
        <i data-lucide="${isCreate ? "user-plus" : "log-in"}"></i><span>${isCreate ? "Create Admin Account" : "Login"}</span>
      </button>
      <p class="conv-history-meta">Admin accounts are stored separately from participant accounts and default to the admin role with retention-management privilege.</p>
    </div>
  `;
}

function convShowAdminAuth(mode = "login") {
  convShowAdminPanel("Admin", convAdminAuthHtml(mode));
  document.getElementById("convAdminLoginTab")?.addEventListener("click", () => convShowAdminAuth("login"));
  document.getElementById("convAdminCreateTab")?.addEventListener("click", () => convShowAdminAuth("create"));
  document.getElementById("convAdminSubmitBtn")?.addEventListener("click", () => convSubmitAdminAuth(mode));
}

async function convSubmitAdminAuth(mode = "login") {
  const email = document.getElementById("convAdminEmailInput")?.value.trim();
  const password = document.getElementById("convAdminPasswordInput")?.value;
  if (!email || !password) {
    showToast("Enter admin email and password.", "error");
    return;
  }
  try {
    if (mode === "create") {
      const create = await fetch(`${API_BASE}/api/v1/admin/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, role: "admin" }),
      });
      if (!create.ok) throw new Error((await create.json()).detail || "Admin account creation failed");
    }
    const login = await fetch(`${API_BASE}/api/v1/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!login.ok) throw new Error((await login.json()).detail || "Admin login failed");
    const data = await login.json();
    convAdminToken = data.admin_token;
    convAdminEmail = data.email || email;
    sessionStorage.setItem("history_admin_token", convAdminToken);
    sessionStorage.setItem("history_admin_email", convAdminEmail);
    await convOpenHistoryAdmin();
  } catch (err) {
    showToast(err.message || "Admin login failed", "error");
  }
}

function convAdminHeaders(extra = {}) {
  return { ...extra, "X-Admin-Token": convAdminToken };
}

function convAdminPanelHtml(retentionDays = 90) {
  const today = new Date().toISOString().slice(0, 10);
  return `
    <div class="conv-history-toolbar">
      <label>Retention days <input type="number" id="convAdminRetentionDays" min="1" max="3650" value="${escapeHtml(String(retentionDays))}"></label>
      <button type="button" class="btn btn-secondary" id="convAdminRetentionSaveBtn">
        <i data-lucide="save"></i><span>Save Retention</span>
      </button>
    </div>
    <div class="conv-history-toolbar">
      <label>From <input type="date" id="convAdminHistoryStart"></label>
      <label>To <input type="date" id="convAdminHistoryEnd" value="${today}"></label>
      <label>Participant email <input type="email" id="convAdminHistoryEmail" placeholder="name@company.com"></label>
      <label>Room code <input type="text" id="convAdminHistoryRoom" placeholder="123456" maxlength="6"></label>
      <button type="button" class="btn btn-secondary" id="convAdminHistorySearchBtn">
        <i data-lucide="search"></i><span>List History</span>
      </button>
    </div>
    <p class="conv-history-list-title">List Conversation History:</p>
    <p class="conv-history-meta">Click the date to show full summary report.</p>
    <div id="convAdminHistoryList" class="conv-history-list">
      <p>Choose a date range to list saved conversation histories.</p>
    </div>
    <div class="conv-admin-footer">
      <button type="button" class="btn btn-secondary" id="convAdminCancelBtn">
        <i data-lucide="x"></i><span>Cancel</span>
      </button>
    </div>
  `;
}

async function convOpenHistoryAdmin() {
  if (!convAdminToken) {
    convShowAdminAuth("login");
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/conversation-history/retention`, {
      headers: convAdminHeaders(),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Admin login required");
    const data = await res.json();
    convShowAdminPanel(`Admin — ${convAdminEmail}`, convAdminPanelHtml(data.retention_days || 90));
    document.getElementById("convAdminRetentionSaveBtn")?.addEventListener("click", convAdminSaveRetention);
    document.getElementById("convAdminHistorySearchBtn")?.addEventListener("click", convAdminLoadHistoryDates);
    document.getElementById("convAdminCancelBtn")?.addEventListener("click", () => {
      showTab({ btn: tabConv, panel: convTab });
    });
    await convAdminLoadHistoryDates();
  } catch (err) {
    convAdminToken = "";
    sessionStorage.removeItem("history_admin_token");
    convShowAdminAuth("login");
  }
}

async function convAdminSaveRetention() {
  const retentionDays = Number(document.getElementById("convAdminRetentionDays")?.value);
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    showToast("Enter a whole number of days.", "error");
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/conversation-history/retention`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...convAdminHeaders(),
      },
      body: JSON.stringify({ retention_days: retentionDays }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Could not update retention");
    const saved = await res.json();
    showToast(`Retention updated to ${saved.retention_days} days. Purged records: ${saved.purged_records || 0}.`, "success");
  } catch (err) {
    showToast(err.message || "Could not update retention", "error");
  }
}

async function convAdminLoadHistoryDates() {
  const list = document.getElementById("convAdminHistoryList");
  if (!list) return;
  const params = new URLSearchParams();
  const start = document.getElementById("convAdminHistoryStart")?.value || "";
  const end = document.getElementById("convAdminHistoryEnd")?.value || "";
  const participantEmail = document.getElementById("convAdminHistoryEmail")?.value.trim() || "";
  const room = document.getElementById("convAdminHistoryRoom")?.value.trim() || "";
  if (start) params.set("start_date", start);
  if (end) params.set("end_date", end);
  if (participantEmail) params.set("participant_email", participantEmail);
  if (room) params.set("room_id", room);
  list.innerHTML = "<p>Loading history...</p>";
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/conversation-history/dates?${params}`, {
      headers: convAdminHeaders(),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Could not load history");
    const data = await res.json();
    const dates = Array.isArray(data.dates) ? data.dates : [];
    if (!dates.length) {
      list.innerHTML = "<p>No saved conversation history found for that range.</p>";
      return;
    }
    list.innerHTML = dates.map((item) => `
      <button type="button" class="conv-history-date" data-date="${escapeHtml(item.date)}">
        <strong>${escapeHtml(item.date)}</strong>
        <span>${escapeHtml(String(item.count))} saved summar${item.count === 1 ? "y" : "ies"}</span>
        <small>CC: ${escapeHtml((item.participant_emails || []).join(", ") || "No participant emails captured")}</small>
      </button>
    `).join("");
    list.querySelectorAll(".conv-history-date").forEach((btn) => {
      btn.addEventListener("click", () => convAdminOpenHistoryDate(btn.dataset.date));
    });
  } catch (err) {
    list.innerHTML = `<p>${escapeHtml(err.message || "Could not load history")}</p>`;
  }
}

async function convAdminOpenHistoryDate(date) {
  if (!date) return;
  convShowAdminPanel(`Admin History — ${date}`, "<p>Loading saved summaries...</p>");
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/conversation-history/date/${encodeURIComponent(date)}`, {
      headers: convAdminHeaders(),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Could not load date");
    const data = await res.json();
    const records = Array.isArray(data.records) ? data.records : [];
    const adminBody = adminTab.querySelector(".admin-panel-body");
    adminBody.innerHTML = `
      <div class="conv-history-toolbar">
        <button type="button" class="btn btn-secondary" id="convAdminBackBtn">
          <i data-lucide="arrow-left"></i><span>Back</span>
        </button>
        <button type="button" class="btn btn-secondary danger" id="convAdminDeleteDateBtn">
          <i data-lucide="trash-2"></i><span>Delete date</span>
        </button>
      </div>
      <div class="conv-status-legend">
        <span><b class="active"></b>Active</span>
        <span><b class="speaking"></b>Speaking</span>
        <span><b class="away"></b>Away/backgrounded</span>
      </div>
      <div class="conv-history-records">
        ${records.map((record) => `
          <section class="conv-history-record">
            <div class="conv-history-record-head">
              <strong>${escapeHtml(record.created_at || record.local_date || date)}</strong>
              <div class="conv-history-record-actions">
                <button type="button" class="btn btn-secondary conv-admin-chat-btn" data-record-id="${escapeHtml(record.id)}">
                  <i data-lucide="messages-square"></i><span>View Full Chat</span>
                </button>
                <button type="button" class="btn btn-secondary conv-admin-regen-btn" data-record-id="${escapeHtml(record.id)}">
                  <i data-lucide="refresh-cw"></i><span>Regenerate</span>
                </button>
                <button type="button" class="btn btn-secondary conv-admin-email-btn" data-record-id="${escapeHtml(record.id)}">
                  <i data-lucide="mail"></i><span>Email</span>
                </button>
              </div>
            </div>
            <p class="conv-history-meta">To/From: ${escapeHtml(convAdminEmail || "Admin")} · CC: ${escapeHtml((record.participant_emails || []).join(", ") || "No participant emails captured")}</p>
            <p class="conv-history-meta">Room ${escapeHtml(record.room_id || "Not identified")} · ${escapeHtml((record.participants || []).join(", ") || "No participants listed")} · ${escapeHtml(String(record.metadata?.message_count || 0))} chat messages</p>
            ${convSummaryHtml(record.summary || {})}
          </section>
        `).join("") || "<p>No history remains for this date.</p>"}
      </div>
    `;
    document.getElementById("convAdminBackBtn")?.addEventListener("click", convOpenHistoryAdmin);
    document.getElementById("convAdminDeleteDateBtn")?.addEventListener("click", () => convAdminDeleteHistoryDate(date));
    adminBody.querySelectorAll(".conv-admin-email-btn").forEach((btn) => {
      btn.addEventListener("click", () => convAdminEmailHistoryRecord(btn.dataset.recordId));
    });
    adminBody.querySelectorAll(".conv-admin-chat-btn").forEach((btn) => {
      btn.addEventListener("click", () => convAdminViewFullChat(btn.dataset.recordId, date));
    });
    adminBody.querySelectorAll(".conv-admin-regen-btn").forEach((btn) => {
      btn.addEventListener("click", () => convAdminRegenerateSummary(btn.dataset.recordId, date));
    });
    lucide.createIcons({ nodes: [adminTab] });
  } catch (err) {
    if (adminTab) adminTab.querySelector(".admin-panel-body").innerHTML = `<p>${escapeHtml(err.message || "Could not load date")}</p>`;
  }
}

async function convAdminDeleteHistoryDate(date) {
  if (!confirm(`Delete all saved summaries and full chat sources for ${date}?`)) return;
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/conversation-history/date/${encodeURIComponent(date)}`, {
      method: "DELETE",
      headers: convAdminHeaders(),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Delete failed");
    await convOpenHistoryAdmin();
  } catch (err) {
    showToast(err.message || "Delete failed", "error");
  }
}

async function convAdminFetchRecord(recordId) {
  const res = await fetch(`${API_BASE}/api/v1/admin/conversation-history/record/${encodeURIComponent(recordId)}`, {
    headers: convAdminHeaders(),
  });
  if (!res.ok) throw new Error((await res.json()).detail || "Could not load record");
  return res.json();
}

async function convAdminViewFullChat(recordId, date) {
  try {
    const record = await convAdminFetchRecord(recordId);
    const rows = Array.isArray(record.chat_messages) ? record.chat_messages : [];
    convShowAdminPanel(`Full Chat — ${record.local_date || date}`, `
      <div class="conv-history-toolbar">
        <button type="button" class="btn btn-secondary" id="convAdminChatBackBtn">
          <i data-lucide="arrow-left"></i><span>Back</span>
        </button>
      </div>
      <div class="conv-full-chat-list">
        ${rows.map((m) => `
          <div class="conv-full-chat-row">
            <strong>${escapeHtml(m.speaker || "Unknown")}</strong>
            <span>${escapeHtml(m.shown_text || m.original || m.translation || "")}</span>
            ${m.original && m.original !== (m.shown_text || m.translation) ? `<small>Original: ${escapeHtml(m.original)}</small>` : ""}
            ${m.translation && m.translation !== (m.shown_text || m.original) ? `<small>Translation: ${escapeHtml(m.translation)}</small>` : ""}
          </div>
        `).join("") || "<p>No full chat source saved.</p>"}
      </div>
    `);
    document.getElementById("convAdminChatBackBtn")?.addEventListener("click", () => convAdminOpenHistoryDate(date));
  } catch (err) {
    showToast(err.message || "Could not load full chat", "error");
  }
}

async function convAdminRegenerateSummary(recordId, date) {
  try {
    showToast("Regenerating summary from full chat...", "info");
    const res = await fetch(`${API_BASE}/api/v1/admin/conversation-history/record/${encodeURIComponent(recordId)}/regenerate`, {
      method: "POST",
      headers: convAdminHeaders(),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Regeneration failed");
    showToast("Summary regenerated from full chat.", "success");
    await convAdminOpenHistoryDate(date);
  } catch (err) {
    showToast(err.message || "Regeneration failed", "error");
  }
}

function convAdminEmailChoiceHtml(recordId) {
  return `
    <div class="conv-admin-auth">
      <p class="conv-history-meta">To/From will use the logged-in admin email. Participant emails for this saved chat are added to CC.</p>
      <label>Email content
        <select id="convAdminEmailContent">
          <option value="both">Summary and full chat</option>
          <option value="summary">Summary only</option>
          <option value="chat">Full chat only</option>
        </select>
      </label>
      <div class="conv-admin-footer">
        <button type="button" class="btn btn-secondary" id="convAdminEmailCancelBtn">
          <i data-lucide="x"></i><span>Cancel</span>
        </button>
        <button type="button" class="btn btn-primary" id="convAdminEmailSendBtn" data-record-id="${escapeHtml(recordId)}">
          <i data-lucide="mail"></i><span>Send</span>
        </button>
      </div>
    </div>
  `;
}

async function convAdminEmailHistoryRecord(recordId) {
  convShowAdminPanel("Email Conversation History", convAdminEmailChoiceHtml(recordId));
  document.getElementById("convAdminEmailCancelBtn")?.addEventListener("click", convOpenHistoryAdmin);
  document.getElementById("convAdminEmailSendBtn")?.addEventListener("click", async () => {
    const contentType = document.getElementById("convAdminEmailContent")?.value || "both";
    await convAdminSendHistoryEmail(recordId, contentType);
  });
}

async function convAdminSendHistoryEmail(recordId, contentType) {
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/conversation-history/record/${encodeURIComponent(recordId)}/email`, {
      method: "POST",
      headers: convAdminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ content_type: contentType }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Email failed");
    const data = await res.json();
    showToast(`History email queued. CC: ${(data.cc || []).join(", ") || "none"}`, "success");
    await convOpenHistoryAdmin();
  } catch (err) {
    showToast(err.message || "Email failed", "error");
  }
}

convHistoryBtn?.addEventListener("click", convOpenHistory);
convAdminBtn?.addEventListener("click", () => {
  setMenuOpen(false);
  _selectTab({ btn: convAdminBtn, panel: adminTab });
  convOpenHistoryAdmin();
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
        "Open this app via HTTPS or http://localhost.",
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
            "3. Reload the page and try again.",
        );
        return;
      }
    } catch (_) {}
  }

  // Confirm a video input device is actually present before requesting access.
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hasCamera = devices.some((d) => d.kind === "videoinput");
    if (!hasCamera) {
      alert(
        "No camera detected on this device. Please connect a camera and try again.",
      );
      return;
    }
  } catch (_) {}

  // Try to open the camera. If the browser rejects the boolean shorthand
  // (`video: true`) with a constraint error, retry with an empty constraints
  // object — both are spec-equivalent but some engines handle them differently.
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });
  } catch (err) {
    const n = err.name;
    if (n === "NotAllowedError" || n === "PermissionDeniedError") {
      alert(
        "Camera access was denied.\n\n" +
          "To fix:\n" +
          "1. Click the lock (or ⓘ) icon in the address bar.\n" +
          "2. Set Camera to Allow.\n" +
          "3. Reload the page and try again.\n\n" +
          "If on macOS, also check System Settings → Privacy & Security → Camera.",
      );
      return;
    }
    if (n === "NotReadableError" || n === "TrackStartError") {
      alert(
        "Camera is already in use by another application. Close it and try again.",
      );
      return;
    }
    if (n === "NotFoundError" || n === "DevicesNotFoundError") {
      alert("No camera found. Please connect a camera and try again.");
      return;
    }
    // Constraint / overconstrained / unknown — retry with minimal constraints.
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {},
        audio: false,
      });
    } catch (_) {
      alert(
        "Could not open camera. Make sure no other app is using it, then try again.",
      );
      return;
    }
  }

  convCamStream = stream;
  // Show local stream inside the participant's own carousel card
  const _myVid = document.getElementById(`conv-card-vid-${convUserId}`);
  const _myPh = document.getElementById(`conv-card-ph-${convUserId}`);
  if (_myVid) {
    _myVid.srcObject = stream;
    _myVid.style.display = "block";
  }
  if (_myPh) _myPh.style.display = "none";
  convCamOn = true;
  convSetCamUI(true);
  convWs?.readyState === WebSocket.OPEN &&
    convWs.send(JSON.stringify({ type: "camera_status", is_on: true }));
  try {
    await livekitPublishVideo(stream);
  } catch (err) {
    console.error("[LiveKit] publish camera:", err);
    showToast(err.message || "Could not start video broadcast.", "error");
    convStopCamera();
  }
}

function convStopCamera() {
  livekitUnpublishVideo();
  if (convCamStream) {
    convCamStream.getTracks().forEach((t) => t.stop());
    convCamStream = null;
  }
  // Clear local stream from carousel card
  const _myVid = document.getElementById(`conv-card-vid-${convUserId}`);
  const _myPh = document.getElementById(`conv-card-ph-${convUserId}`);
  if (_myVid) {
    _myVid.srcObject = null;
    _myVid.style.display = "";
  }
  if (_myPh) _myPh.style.display = "";
  convCamOn = false;
  convSetCamUI(false);
  convWs?.readyState === WebSocket.OPEN &&
    convWs.send(JSON.stringify({ type: "camera_status", is_on: false }));
}

function convSetCamUI(isOn) {
  convCamBtn.classList.toggle("active", isOn);
  convCamBtn.innerHTML = isOn
    ? '<i data-lucide="video"></i><span id="convCamLabel">Stop Video</span>'
    : '<i data-lucide="video-off"></i><span id="convCamLabel">Video</span>';
  lucide.createIcons({ nodes: [convCamBtn] });
  if (convUserId && convUsers[convUserId]) {
    convUsers[convUserId].camera_on = isOn;
    convUpdateChipCam(convUserId, isOn);
  }
}

convCamBtn.addEventListener("click", () => {
  convCamOn ? convStopCamera() : convStartCamera();
});

function convCloseToolbarPopovers(except = null) {
  if (except !== "participants" && convParticipantsPopover) {
    convParticipantsPopover.style.display = "none";
    convParticipantsBtn?.classList.remove("open");
  }
  if (except !== "more" && convMorePopover) {
    convMorePopover.style.display = "none";
    convMoreBtn?.classList.remove("open");
  }
}

convParticipantsBtn?.addEventListener("click", () => {
  const isOpen = convParticipantsPopover?.style.display === "block";
  convCloseToolbarPopovers(isOpen ? null : "participants");
  if (!convParticipantsPopover) return;
  convRenderParticipantsPopover();
  convParticipantsPopover.style.display = isOpen ? "none" : "block";
  convParticipantsBtn.classList.toggle("open", !isOpen);
});

convChatBtn?.addEventListener("click", () => {
  convCloseToolbarPopovers();
  convKeyboardBar?.classList.toggle("open");
  convChatBtn.classList.toggle("open", convKeyboardBar?.classList.contains("open"));
  if (convKeyboardBar?.classList.contains("open")) convKeyboardInput?.focus();
});

convMoreBtn?.addEventListener("click", () => {
  const isOpen = convMorePopover?.style.display === "flex";
  convCloseToolbarPopovers(isOpen ? null : "more");
  if (!convMorePopover) return;
  convMorePopover.style.display = isOpen ? "none" : "flex";
  convMoreBtn.classList.toggle("open", !isOpen);
  lucide.createIcons({ nodes: [convMorePopover] });
});

convToolbarVocabBtn?.addEventListener("click", () => {
  convCloseToolbarPopovers();
  vocabOpen();
});

convEndBtn?.addEventListener("click", () => {
  sendConversationLeave();
  convReset();
  showToast("You left the meeting.", "success");
});

document.addEventListener("click", (e) => {
  if (!convActive?.contains(e.target)) return;
  const insidePopover = e.target.closest(".conv-toolbar-popover");
  const insideToolbarButton = e.target.closest("#convParticipantsBtn, #convMoreBtn");
  if (!insidePopover && !insideToolbarButton) convCloseToolbarPopovers();
});

// ── Reset / disconnect ─────────────────────────────────────────────────────
function convHandleDisconnect(reason) {
  if (convWs) {
    convWs.onclose = null;
    convWs.onerror = null;
    convWs = null;
  }
  if (reason) alert(reason + "\nYou have been logged out.");
  endBrowserSession({ showLogin: true });
}

function convReset() {
  webrtcCloseAll();
  convStopListening();
  convStopIosMic();
  convStopCamera();
  livekitDisconnectVideo();
  convSpeakCancel();
  for (const timeoutId of _voiceAwaiting.values()) clearTimeout(timeoutId);
  _voiceAwaiting.clear();
  _ttsUnlocked = false;
  _ttsSpeakerMode = true;
  convSetTtsUI();
  _voiceCloneEnrolled = false;
  _voiceCloneCapturing = false;
  _voiceCloneAvailable = null;
  _voiceCloneBadge("hidden");
  if (convWs) {
    convWs.close();
    convWs = null;
  }
  convRoomId = null;
  convUserId = null;
  convIsHost = false;
  convUsers = {};
  convTranscript = [];
  // Reset carousel, colour and typing state for next session
  Object.keys(_participantIdleTimers).forEach((userId) => convStopIdleTimer(userId));
  _carouselCards.length = 0;
  _carouselPage = 0;
  const _track = document.getElementById("convCarouselTrack");
  if (_track) _track.innerHTML = "";
  Object.keys(_participantColors).forEach((k) => delete _participantColors[k]);
  _paletteIndex = 0;
  Object.keys(_typingUsers).forEach((k) => {
    clearTimeout(_typingUsers[k].timerId);
    delete _typingUsers[k];
  });
  clearTimeout(_typingTimer);
  clearInterval(_typingHeartbeat);
  _typingHeartbeat = null;
  _isTyping = false;
  convMessages.innerHTML =
    '<div class="conv-start-hint">Press your mic to start speaking</div>';
  setConversationRoomCode("");
  convCloseToolbarPopovers();
  convKeyboardBar?.classList.remove("open");
  convChatBtn?.classList.remove("open");
  convRenderParticipantsPopover();
  if (convRoomInput) convRoomInput.value = "";
  if (convSummaryModal) convSummaryModal.style.display = "none";
  if (convSummaryBody) convSummaryBody.innerHTML = "";
  convShowScreen(convSetup);
  convCreateBtn.disabled = false;
  convCreateBtn.querySelector("span").textContent = "Create New Room";
}

// ── Create / Join buttons ──────────────────────────────────────────────────
convCreateBtn.addEventListener("click", async () => {
  _unlockTts(); // synchronous — before first await, still in user-gesture context
  const name = convNameInput.value.trim();
  if (!name) {
    convNameInput.focus();
    return;
  }

  convCreateBtn.disabled = true;
  convCreateBtn.querySelector("span").textContent = "Connecting…";

  try {
    const res = await fetch(`${API_BASE}/create_room`);
    if (!res.ok) {
      convCreateBtn.disabled = false;
      convCreateBtn.querySelector("span").textContent = "Create New Room";
      alert(`Backend error (${res.status}). Is the server running?`);
      return;
    }
    const data = await res.json();
    if (!data.room_id) {
      convCreateBtn.disabled = false;
      convCreateBtn.querySelector("span").textContent = "Create New Room";
      alert("Invalid response from server.");
      return;
    }
    await convConnect(data.room_id, true);
  } catch (e) {
    convCreateBtn.disabled = false;
    convCreateBtn.querySelector("span").textContent = "Create New Room";
    alert(`Failed to create room: ${e.message}`);
  }
});

convJoinBtn.addEventListener("click", () => {
  _unlockTts(); // synchronous — user-gesture context
  const roomId = convRoomInput.value.replace(/\s+/g, "").trim();
  if (!roomId) {
    convRoomInput.focus();
    return;
  }
  const name = convNameInput.value.trim();
  if (!name) {
    convNameInput.focus();
    return;
  }
  convConnect(roomId, false);
});

convRoomInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") convJoinBtn.click();
});
convNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") convCreateBtn.click();
});

syncConversationNameField();

convCopyCodeBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(getConversationRoomCode()).then(() => {
    convCopyCodeBtn.title = "Copied!";
    setTimeout(() => {
      convCopyCodeBtn.title = "Copy meeting ID";
    }, 1500);
  });
});

// ── Invite Modal ───────────────────────────────────────────────────────────
const convInviteBtn = document.getElementById("convInviteBtn");
const convCopyLinkBtn = document.getElementById("convCopyLinkBtn");
const convInviteModal = document.getElementById("convInviteModal");
const convInviteMsg = document.getElementById("convInviteMsg");
const convInviteClose = document.getElementById("convInviteClose");

const INVITE_PLATFORMS = [
  { id: "copy", label: "Copy", bg: "#6366f1", emoji: "📋" },
  { id: "sms", label: "SMS", bg: "#10b981", emoji: "💬" },
  { id: "email", label: "Email", bg: "#f59e0b", emoji: "✉️" },
  { id: "whatsapp", label: "WhatsApp", bg: "#25d366", emoji: "📱" },
  { id: "teams", label: "Teams", bg: "#5059c9", emoji: "🏢" },
  { id: "messenger", label: "Messenger", bg: "#0084ff", emoji: "💙" },
  { id: "telegram", label: "Telegram", bg: "#2ca5e0", emoji: "✈️" },
  { id: "slack", label: "Slack", bg: "#4a154b", emoji: "💼" },
  { id: "discord", label: "Discord", bg: "#5865f2", emoji: "🎮" },
];

function inviteText() {
  const code = getConversationRoomCode();
  const url = window.location.origin + window.location.pathname;
  return `You're invited to a live AI Translate conversation!\n\nRoom Code: ${code}\nOpen the app: ${url}\n\nEnter the room code to join.`;
}
function inviteShort() {
  const code = getConversationRoomCode();
  const url = window.location.origin + window.location.pathname;
  return `Join my AI Translate room! Code: ${code} | ${url}`;
}

function inviteCopyAndLabel(platformId, label) {
  navigator.clipboard.writeText(inviteText()).then(() => {
    const el = document.querySelector(
      `[data-platform="${platformId}"] .conv-invite-platform-name`,
    );
    if (!el) return;
    const orig = el.textContent;
    el.textContent = label;
    setTimeout(() => {
      el.textContent = orig;
    }, 2200);
  });
}

function inviteShare(platformId) {
  const enc = encodeURIComponent(inviteText());
  const encs = encodeURIComponent(inviteShort());
  const url = encodeURIComponent(
    window.location.origin + window.location.pathname,
  );
  const subj = encodeURIComponent("Join my AI Translate room");
  ({
    copy: () => inviteCopyAndLabel("copy", "Copied!"),
    sms: () => window.open(`sms:?&body=${enc}`),
    email: () => window.open(`mailto:?subject=${subj}&body=${enc}`),
    whatsapp: () => window.open(`https://api.whatsapp.com/send?text=${enc}`),
    teams: () =>
      window.open(
        `https://teams.microsoft.com/l/chat/0/0?users=&message=${encs}`,
      ),
    messenger: () => inviteCopyAndLabel("messenger", "Copied!"),
    telegram: () =>
      window.open(`https://t.me/share/url?url=${url}&text=${encs}`),
    slack: () => inviteCopyAndLabel("slack", "Copied — paste in Slack"),
    discord: () => inviteCopyAndLabel("discord", "Copied — paste in Discord"),
  })[platformId]?.();
}

(function buildInviteGrid() {
  const grid = document.getElementById("convInvitePlatforms");
  INVITE_PLATFORMS.forEach((p) => {
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
convCopyLinkBtn?.addEventListener("click", () => {
  navigator.clipboard.writeText(inviteShort()).then(() => {
    showToast("Room link copied.", "success");
  });
});
convInviteClose.addEventListener("click", () => {
  convInviteModal.style.display = "none";
});
convInviteModal.addEventListener("click", (e) => {
  if (e.target === convInviteModal) convInviteModal.style.display = "none";
});

// ── Keyboard Input Module ──────────────────────────────────────────────────
const convKeyboardInput = document.getElementById("convKeyboardInput");
const convKeyboardSend = document.getElementById("convKeyboardSend");

// Typing heartbeat — best practice used by Slack / WhatsApp / iMessage:
//   • Send typing=true ONCE on first keystroke (not on every keystroke)
//   • Resend typing=true every HEARTBEAT_MS while the user is still composing
//   • Send typing=false immediately on send, clear, or blur
//   • Receiver auto-expires the indicator after EXPIRE_MS — handles
//     disconnects / lost stop signals with no zombie "X is typing…"
const _TYPING_HEARTBEAT_MS = 3000;
const _TYPING_EXPIRE_MS = 5000; // slightly longer than heartbeat for network slack

let _typingTimer = null;
let _typingHeartbeat = null;
let _isTyping = false;

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
  _unlockTts();
  const text = convKeyboardInput.value.trim();
  if (!text || convWs?.readyState !== WebSocket.OPEN) return;
  _typingStop();
  convWs.send(JSON.stringify({ type: "keyboard", text }));
  convKeyboardInput.value = "";
  convKeyboardSend.disabled = false;
}

convKeyboardSend.addEventListener("click", convSendKeyboard);

convKeyboardInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    convSendKeyboard();
  }
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

// ── LiveKit video transport ───────────────────────────────────────────────
// LiveKit replaces the previous peer-to-peer video mesh. Audio/STT translation
// remains on the existing app pipeline.

let lkRoom = null;
let lkConnecting = false;
let lkVideoPublication = null;

function livekitClient() {
  return window.LivekitClient || null;
}

function livekitVideoReady() {
  return !!livekitClient()?.Room;
}

async function livekitConnectVideo() {
  if (!convRoomId || !convUserId || lkConnecting) return;
  if (lkRoom?.state === "connected") return;
  if (!livekitVideoReady()) {
    showToast("Video service could not load. Refresh and try again.", "error");
    return;
  }
  if (!currentUserToken) {
    showToast("Login is required for video.", "error");
    return;
  }

  lkConnecting = true;
  try {
    const name = convUsers[convUserId]?.name || getAuthenticatedDisplayName() || convUserId;
    const params = new URLSearchParams({
      room_id: convRoomId,
      identity: convUserId,
      name,
    });
    const res = await fetch(`${API_BASE}/api/livekit/token?${params.toString()}`, {
      headers: { Authorization: `Bearer ${currentUserToken}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "LiveKit video is unavailable");

    const LK = livekitClient();
    const room = new LK.Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: {
        resolution: LK.VideoPresets?.h540?.resolution,
      },
      publishDefaults: {
        simulcast: true,
      },
    });

    room
      .on(LK.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        livekitAttachRemoteVideo(participant.identity, track);
      })
      .on(LK.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        livekitDetachRemoteVideo(participant.identity, track);
      })
      .on(LK.RoomEvent.ParticipantDisconnected, (participant) => {
        livekitDetachRemoteVideo(participant.identity);
      })
      .on(LK.RoomEvent.Disconnected, () => {
        lkVideoPublication = null;
      });

    await room.connect(data.url, data.token, { autoSubscribe: true });
    lkRoom = room;
    livekitAttachExistingRemoteVideos();
  } catch (err) {
    console.error("[LiveKit] connect:", err);
    showToast(err.message || "Video service unavailable.", "error");
  } finally {
    lkConnecting = false;
  }
}

function livekitAttachExistingRemoteVideos() {
  if (!lkRoom) return;
  lkRoom.remoteParticipants?.forEach((participant) => {
    participant.trackPublications?.forEach((publication) => {
      if (publication?.track) {
        livekitAttachRemoteVideo(participant.identity, publication.track);
      }
    });
  });
}

function livekitAttachRemoteVideo(userId, track) {
  if (!track || userId === convUserId) return;
  const LK = livekitClient();
  const isVideo =
    track.kind === "video" ||
    track.kind === LK?.Track?.Kind?.Video ||
    track.source === LK?.Track?.Source?.Camera;
  if (!isVideo) return;

  const vid = document.getElementById(`conv-card-vid-${userId}`);
  const ph = document.getElementById(`conv-card-ph-${userId}`);
  if (!vid) {
    setTimeout(() => livekitAttachRemoteVideo(userId, track), 250);
    return;
  }
  try {
    track.attach(vid);
    vid.autoplay = true;
    vid.playsInline = true;
    vid.muted = true;
    vid.style.display = "block";
    if (ph) ph.style.display = "none";
    vid.play?.().catch(() => {});
  } catch (err) {
    console.error("[LiveKit] attach remote video:", err);
  }
}

function livekitDetachRemoteVideo(userId, track = null) {
  const vid = document.getElementById(`conv-card-vid-${userId}`);
  const ph = document.getElementById(`conv-card-ph-${userId}`);
  if (track) {
    try {
      if (vid) track.detach(vid);
      else track.detach();
    } catch {}
  }
  if (vid) {
    vid.srcObject = null;
    vid.style.display = "";
  }
  if (ph) ph.style.display = "";
}

async function livekitPublishVideo(stream) {
  await livekitConnectVideo();
  if (!lkRoom || lkRoom.state !== "connected") {
    throw new Error("LiveKit video room is not connected");
  }
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  const LK = livekitClient();
  lkVideoPublication = await lkRoom.localParticipant.publishTrack(track, {
    source: LK?.Track?.Source?.Camera,
    name: `camera-${convUserId}`,
    simulcast: true,
  });
}

async function livekitUnpublishVideo() {
  if (!lkRoom || !lkVideoPublication) return;
  try {
    const track = lkVideoPublication.track || convCamStream?.getVideoTracks()[0];
    if (track) {
      lkRoom.localParticipant.unpublishTrack(track, false);
    }
  } catch (err) {
    console.warn("[LiveKit] unpublish video:", err);
  } finally {
    lkVideoPublication = null;
  }
}

function livekitDisconnectVideo() {
  try {
    lkRoom?.disconnect();
  } catch {}
  lkRoom = null;
  lkConnecting = false;
  lkVideoPublication = null;
}

// ── WebRTC Module ─────────────────────────────────────────────────────────
const WEBRTC_ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// convVideoGrid removed — remote video shown inside carousel cards

let rtcPeers = {}; // userId → RTCPeerConnection
let rtcAudioTrack = null; // local mic audio track (for WebRTC)
let rtcVideoTrack = null; // local camera video track (for WebRTC)
let rtcAudioContext = null; // created on user click so it's always activated
let rtcAudioSources = {}; // userId → AudioContext source node
let rtcVideoSenders = {}; // userId → RTCRtpSender (kept across pause/resume so
// re-opening the camera reuses the same sender)
let rtcAudioSenders = {}; // userId → RTCRtpSender (same idea for audio)

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

  rtcLocalTracks().forEach((t) => {
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
      convWs?.readyState === WebSocket.OPEN &&
        convWs.send(
          JSON.stringify({
            type: "webrtc_offer",
            target_id: userId,
            sdp: {
              type: pc.localDescription.type,
              sdp: pc.localDescription.sdp,
            },
          }),
        );
    } catch (e) {
      console.error("[WebRTC] negotiate:", e);
    } finally {
      pc._makingOffer = false;
    }
  };

  pc.ontrack = ({ track }) => {
    if (track.kind === "video") rtcShowRemoteVideo(userId, track);
    else rtcPlayRemoteAudio(userId, track);
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate && convWs?.readyState === WebSocket.OPEN) {
      convWs.send(
        JSON.stringify({
          type: "webrtc_ice",
          target_id: userId,
          candidate: candidate.toJSON(),
        }),
      );
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
  const polite = !convIsHost;
  const collision = pc._makingOffer || pc.signalingState !== "stable";

  if (!polite && collision) return; // impolite peer drops the colliding offer

  try {
    // Polite peer: setRemoteDescription auto-rolls back the pending local offer
    // (implicit rollback — Chrome 80+, Firefox 75+, Safari 14.1+).
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    convWs?.readyState === WebSocket.OPEN &&
      convWs.send(
        JSON.stringify({
          type: "webrtc_answer",
          target_id: fromId,
          sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        }),
      );
  } catch (e) {
    console.error("[WebRTC] handle offer:", e);
  }
}

async function rtcHandleAnswer(fromId, sdp) {
  try {
    await rtcPeers[fromId]?.setRemoteDescription(
      new RTCSessionDescription(sdp),
    );
  } catch (e) {
    console.error("[WebRTC] handle answer:", e);
  }
}

async function rtcHandleIce(fromId, candidate) {
  if (!candidate || !rtcPeers[fromId]) return;
  try {
    await rtcPeers[fromId].addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.error("[WebRTC] ICE:", e);
  }
}

function rtcShowRemoteVideo(userId, track) {
  // Remote video goes directly into the participant's carousel card video box
  const vid = document.getElementById(`conv-card-vid-${userId}`);
  const ph = document.getElementById(`conv-card-ph-${userId}`);
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
    el._clearTimer = setTimeout(() => {
      el.textContent = "";
    }, 4000);
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
  const ph = document.getElementById(`conv-card-ph-${userId}`);
  if (vid) {
    vid.srcObject = null;
    vid.style.display = "";
  }
  if (ph) ph.style.display = "";
  rtcAudioSources[userId]?.disconnect();
  delete rtcAudioSources[userId];
}

async function webrtcStartAudio() {
  if (rtcAudioTrack) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
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
    Object.keys(convUsers)
      .filter((uid) => uid !== convUserId && !rtcPeers[uid])
      .forEach((uid) => rtcCreatePeer(uid)); // onnegotiationneeded fires when track added
  } catch (e) {
    console.error("[WebRTC] audio start:", e);
    if (e.name === "NotAllowedError" && _isSafari) {
      convStopListening();
      alert(
        "Safari mic conflict:\n\n" +
          "Safari allows only ONE tab to use the mic at a time.\n" +
          "Another tab in this Safari window already holds the mic.\n\n" +
          "► Use Chrome or Firefox to test multiple participants in separate tabs.\n" +
          "► On real devices (separate phones/computers) this is not a problem.",
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
    try {
      sender.replaceTrack(null);
    } catch {}
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
  Object.keys(convUsers)
    .filter((uid) => uid !== convUserId && !rtcPeers[uid])
    .forEach((uid) => rtcCreatePeer(uid));
}

function webrtcStopVideo() {
  rtcVideoTrack = null;
  // Pause by clearing the track but keep the sender so re-opening the camera
  // reuses the same m-line and doesn't add a duplicate sender. Without this,
  // the second open created a phantom sender and remote peers saw blank video.
  for (const sender of Object.values(rtcVideoSenders)) {
    try {
      sender.replaceTrack(null);
    } catch {}
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
  Object.keys(rtcPeers).forEach((uid) => {
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

let _vocabEditId = null; // non-null when the form is in edit mode

const vocabModal = document.getElementById("vocabModal");
const vocabClose = document.getElementById("vocabClose");
const vocabTerm = document.getElementById("vocabTerm");
const vocabLang = document.getElementById("vocabLang");
const vocabDef = document.getElementById("vocabDef");
const vocabVariants = document.getElementById("vocabVariants");
const vocabDomain = document.getElementById("vocabDomain");
const vocabSaveBtn = document.getElementById("vocabSaveBtn");
const vocabSaveBtnLabel = document.getElementById("vocabSaveBtnLabel");
const vocabCancelEditBtn = document.getElementById("vocabCancelEditBtn");
const vocabBulkBtn = document.getElementById("vocabBulkBtn");
const vocabBulkArea = document.getElementById("vocabBulkArea");
const vocabBulkJson = document.getElementById("vocabBulkJson");
const vocabBulkImportBtn = document.getElementById("vocabBulkImportBtn");
const vocabBulkCancelBtn = document.getElementById("vocabBulkCancelBtn");
const vocabList = document.getElementById("vocabList");
const vocabEmpty = document.getElementById("vocabEmpty");
const vocabCountBadge = document.getElementById("vocabCountBadge");
const convVocabBtn = document.getElementById("convVocabBtn");
const convVocabBadge = document.getElementById("convVocabBadge");

async function vocabFetchAll() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/vocabulary`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.entries || [];
  } catch {
    return [];
  }
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
  entries.forEach((entry) => {
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
  lucide.createIcons({
    nodes: Array.from(vocabList.querySelectorAll("[data-lucide]")),
  });
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
  const def = vocabDef?.value.trim();
  if (!term || !def) {
    alert("Term and definition are required.");
    return;
  }

  const variants = (vocabVariants?.value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
    const res = await fetch(`${API_BASE}/api/v1/vocabulary/${id}`, {
      method: "DELETE",
    });
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
  try {
    rows = JSON.parse(raw);
  } catch {
    alert("Invalid JSON. Expected an array of objects.");
    return;
  }
  if (!Array.isArray(rows)) {
    alert("JSON must be an array.");
    return;
  }
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
vocabModal?.addEventListener("click", (e) => {
  if (e.target === vocabModal) {
    vocabModal.style.display = "none";
    vocabClearForm();
  }
});
vocabSaveBtn?.addEventListener("click", vocabSave);
vocabCancelEditBtn?.addEventListener("click", vocabClearForm);
vocabBulkBtn?.addEventListener("click", () => {
  if (vocabBulkArea)
    vocabBulkArea.style.display =
      vocabBulkArea.style.display === "none" ? "flex" : "none";
});
vocabBulkImportBtn?.addEventListener("click", vocabBulkImport);
vocabBulkCancelBtn?.addEventListener("click", () => {
  if (vocabBulkArea) vocabBulkArea.style.display = "none";
  if (vocabBulkJson) vocabBulkJson.value = "";
});
convVocabBtn?.addEventListener("click", vocabOpen);

// Allow Enter in term/def fields to submit
vocabTerm?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") vocabSave();
});
vocabDef?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    vocabSave();
  }
});

// Show login modal on startup if user is not authenticated
window.addEventListener("DOMContentLoaded", () => {
  if (!currentUserToken) {
    showAuthModal("landing");
  }
  updateAuthHeader();
});

window.addEventListener("pagehide", prepareConversationPageExit);
window.addEventListener("beforeunload", prepareConversationPageExit);
