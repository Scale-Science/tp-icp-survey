/**
 * Toothpod ICP Survey — one-question-at-a-time wizard with partial-answer
 * capture.
 *
 * Behaviour:
 *  - Shows the welcome + Q1 on the first screen, then one question per step.
 *  - A progress bar advances as the respondent moves through the 8 questions.
 *  - Every forward step (and an exit/refresh flush) POSTs the *current* answers
 *    to the Apps Script endpoint, keyed by a per-session id. The backend
 *    upserts that one row, so incomplete responses are still captured and a
 *    completed submission simply finishes filling the same row.
 *  - Progress is mirrored to localStorage so a refresh resumes where they left
 *    off (and survives flaky connections).
 *
 * Until config.js has an endpoint, submissions are logged to the console.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "tp_icp_survey_v1";

  const form = document.getElementById("survey");
  const steps = Array.from(form.querySelectorAll(".step"));
  const total = steps.length; // 8 questions
  const backBtn = document.getElementById("nav-back");
  const nextBtn = document.getElementById("nav-next");
  const nextLabel = nextBtn.querySelector(".submit-label");
  const errorEl = document.getElementById("form-error");
  const thanksEl = document.getElementById("thanks");
  const progressFill = document.getElementById("progress-fill");
  const progressLabel = document.getElementById("progress-label");
  const progressBar = document.querySelector(".progress-track");
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  const config = window.TOOTHPOD_SURVEY_CONFIG || {};
  const endpoint = (config.endpoint || "").trim();

  const cssEsc = window.CSS && CSS.escape ? CSS.escape.bind(CSS) : (s) => s;

  // Question metadata mirrors the DOM order — one question per step.
  // All questions are optional — respondents can move forward without
  // answering. Partial answers are still captured per step.
  const QUESTIONS = [
    { name: "q1_main_reason", label: "Q1 · Main reason for buying", type: "radio", required: false, hasOther: true, otherKey: "q1_main_reason_other", otherLabel: "Other" },
    { name: "q2_trigger", label: "Q2 · What was going on in life", type: "text", required: false },
    { name: "q3_fear", label: "Q3 · Biggest fear / frustration", type: "text", required: false },
    { name: "q4_tried", label: "Q4 · What they tried & why it failed", type: "text", required: false },
    { name: "q5_convinced", label: "Q5 · What convinced them", type: "checkbox", required: false, max: 2, hasOther: true, otherKey: "q5_convinced_other", otherLabel: "Other" },
    { name: "q6_disappointment", label: "Q6 · Feeling if no longer available", type: "radio", required: false },
    { name: "q7_age", label: "Q7 · Age", type: "radio", required: false },
    { name: "q8_identity", label: "Q8 · Identity", type: "radio", required: false, hasOther: true, otherKey: "q8_identity_other", otherLabel: "Non-binary / prefer to self-describe" },
  ];

  // ----- Session identity (persisted so a row can be upserted) -----
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function readStore() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch (_) {
      return null;
    }
  }
  function writeStore(obj) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch (_) {
      /* private mode / storage full — non-fatal */
    }
  }
  function clearStore() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  let current = 0;
  let completedState = false;
  let sessionId;
  let startedAt;

  const stored = readStore();
  if (stored && stored.sessionId && !stored.completed) {
    sessionId = stored.sessionId;
    startedAt = stored.startedAt || new Date().toISOString();
    current = clampStep(stored.step || 0);
  } else {
    sessionId = uuid();
    startedAt = new Date().toISOString();
  }

  function clampStep(i) {
    i = parseInt(i, 10) || 0;
    return Math.max(0, Math.min(total - 1, i));
  }

  // ----- Reading answers -----
  function formatOther(q) {
    const el = q.otherKey ? form.querySelector('[name="' + cssEsc(q.otherKey) + '"]') : null;
    const txt = el && el.value ? el.value.trim() : "";
    const base = q.otherLabel || "Other";
    return txt ? base + ": " + txt : base;
  }

  function getValue(q) {
    if (q.type === "text") {
      const el = form.querySelector('[name="' + cssEsc(q.name) + '"]');
      return el && el.value ? el.value.trim() : "";
    }
    if (q.type === "checkbox") {
      const checked = Array.from(form.querySelectorAll('input[name="' + cssEsc(q.name) + '"]:checked'));
      return checked
        .map(function (inp) {
          return inp.value === "__other__" ? formatOther(q) : inp.value;
        })
        .filter(Boolean)
        .join(" | ");
    }
    const checked = form.querySelector('input[name="' + cssEsc(q.name) + '"]:checked');
    if (!checked) return "";
    return checked.value === "__other__" ? formatOther(q) : checked.value;
  }

  // ----- Raw form snapshot (for localStorage resume) -----
  function serializeRaw() {
    const data = {};
    form.querySelectorAll("input, textarea").forEach(function (el) {
      if (!el.name) return;
      if (el.type === "radio" || el.type === "checkbox") {
        if (el.checked) (data[el.name] = data[el.name] || []).push(el.value);
      } else if (el.value) {
        data[el.name] = el.value;
      }
    });
    return data;
  }
  function restoreRaw(data) {
    if (!data) return;
    form.querySelectorAll("input, textarea").forEach(function (el) {
      if (!el.name || !(el.name in data)) return;
      const v = data[el.name];
      if (el.type === "radio" || el.type === "checkbox") {
        if (Array.isArray(v) && v.indexOf(el.value) !== -1) el.checked = true;
      } else if (typeof v === "string") {
        el.value = v;
      }
    });
  }

  function persistLocal() {
    writeStore({
      v: 1,
      sessionId: sessionId,
      startedAt: startedAt,
      step: current,
      completed: completedState,
      raw: serializeRaw(),
    });
  }

  // ----- Payload + transport -----
  function buildPayload(completed) {
    const answers = {};
    QUESTIONS.forEach(function (q) {
      answers[q.name] = getValue(q);
    });
    const answeredCount = Object.keys(answers).filter(function (k) {
      return answers[k] && String(answers[k]).trim();
    }).length;
    return {
      sessionId: sessionId,
      startedAt: startedAt,
      updatedAt: new Date().toISOString(),
      completed: !!completed,
      currentStep: current + 1,
      totalSteps: total,
      answeredCount: answeredCount,
      schema: QUESTIONS.map(function (q) {
        return { name: q.name, label: q.label };
      }),
      answers: answers,
      meta: {
        userAgent: navigator.userAgent,
        timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || "",
        page: location.href,
      },
    };
  }

  function postPayload(payload, keepalive) {
    if (!endpoint) {
      // Preview mode — surface the data so you can verify the wiring.
      console.info("[Toothpod ICP survey] preview payload:", payload);
      return Promise.resolve();
    }
    return fetch(endpoint, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow",
      keepalive: !!keepalive,
    });
  }

  // Fire-and-forget partial save (never blocks the UI).
  function savePartial() {
    persistLocal();
    const payload = buildPayload(false);
    if (payload.answeredCount === 0) return; // nothing worth sending yet
    postPayload(payload, false).catch(function (err) {
      console.warn("Partial save failed (will retry on next step):", err);
    });
  }

  // Best-effort flush when the tab is hidden/closed mid-survey.
  function flushOnHide() {
    if (completedState) return;
    const payload = buildPayload(false);
    if (payload.answeredCount === 0) return;
    persistLocal();
    postPayload(payload, true).catch(function () {});
  }

  // ----- "Other" inputs: reveal/focus + clear when deselected -----
  function syncOtherInputs(focusName) {
    form.querySelectorAll("[data-other-target]").forEach(function (ctrl) {
      const targetName = ctrl.getAttribute("data-other-target");
      const target = form.querySelector('[name="' + cssEsc(targetName) + '"]');
      if (!target) return;
      if (!ctrl.checked) {
        target.value = "";
      } else if (focusName && ctrl.name === focusName) {
        setTimeout(function () {
          target.focus();
        }, 0);
      }
    });
  }

  // ----- "Choose up to N" enforcement -----
  function enforceCap(fieldset) {
    const max = parseInt(fieldset.getAttribute("data-max") || "0", 10);
    if (!max) return;
    const boxes = Array.from(fieldset.querySelectorAll('input[type="checkbox"]'));
    const atCap = boxes.filter(function (b) { return b.checked; }).length >= max;
    boxes.forEach(function (b) {
      b.disabled = atCap && !b.checked;
    });
  }
  function refreshCaps() {
    form.querySelectorAll("fieldset[data-max]").forEach(enforceCap);
  }

  // ----- Validation -----
  function fail(fs, msg) {
    if (fs) fs.classList.add("invalid");
    return { ok: false, msg: msg };
  }

  function validateStep(idx) {
    const q = QUESTIONS[idx];
    const fs = form.querySelector('fieldset[data-q="' + q.name + '"]');
    if (fs) fs.classList.remove("invalid");
    if (!q.required) return { ok: true };

    if (q.type === "text") {
      if (!getValue(q)) return fail(fs, "Please share a short answer, or tap “Skip this question.”");
      return { ok: true };
    }
    if (q.type === "checkbox") {
      const checked = Array.from(form.querySelectorAll('input[name="' + cssEsc(q.name) + '"]:checked'));
      if (checked.length === 0) return fail(fs, "Please choose at least one option to continue.");
      if (q.otherRequiresText && checked.some(function (e) { return e.value === "__other__"; })) {
        const el = form.querySelector('[name="' + cssEsc(q.otherKey) + '"]');
        if (!el || !el.value.trim()) return fail(fs, "Please add a few words for your “something else” answer.");
      }
      return { ok: true };
    }
    // radio
    const checked = form.querySelector('input[name="' + cssEsc(q.name) + '"]:checked');
    if (!checked) return fail(fs, "Please choose an option to continue.");
    if (q.otherRequiresText && checked.value === "__other__") {
      const el = form.querySelector('[name="' + cssEsc(q.otherKey) + '"]');
      if (!el || !el.value.trim()) return fail(fs, "Please add a few words for your “something else” answer.");
    }
    return { ok: true };
  }

  // ----- Navigation / rendering -----
  function setProgress(idx, done) {
    const n = done ? total : idx + 1;
    const pct = Math.round((n / total) * 100);
    progressFill.style.width = pct + "%";
    progressLabel.textContent = done ? "All done" : "Question " + (idx + 1) + " of " + total;
    if (progressBar) progressBar.setAttribute("aria-valuenow", String(n));
  }

  function render(focusStep) {
    steps.forEach(function (s, i) {
      s.hidden = i !== current;
    });
    backBtn.hidden = current === 0;
    const last = current === total - 1;
    nextLabel.textContent = last ? "Finish & submit" : "Continue";
    setProgress(current, false);
    refreshCaps();
    errorEl.textContent = "";
    if (focusStep) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      const el = steps[current];
      el.setAttribute("tabindex", "-1");
      el.focus({ preventScroll: true });
    }
  }

  function goTo(idx, focusStep) {
    current = clampStep(idx);
    render(focusStep);
    persistLocal();
  }

  // ----- Events -----
  form.addEventListener("change", function (e) {
    const t = e.target;
    if (!t || !(t.matches('input[type="radio"]') || t.matches('input[type="checkbox"]'))) return;
    const fs = t.closest("fieldset");
    if (fs) {
      fs.classList.remove("invalid");
      if (fs.hasAttribute("data-max")) enforceCap(fs);
    }
    syncOtherInputs(t.checked ? t.name : null);
    savePartial();
  });

  // Remove the error state as soon as they start typing / editing text.
  form.addEventListener("input", function (e) {
    const fs = e.target.closest && e.target.closest("fieldset");
    if (fs) fs.classList.remove("invalid");
    errorEl.textContent = "";
  });

  backBtn.addEventListener("click", function () {
    if (current > 0) goTo(current - 1, true);
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errorEl.textContent = "";

    const result = validateStep(current);
    if (!result.ok) {
      errorEl.textContent = result.msg;
      const fs = form.querySelector('fieldset[data-q="' + QUESTIONS[current].name + '"]');
      if (fs) fs.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    const last = current === total - 1;
    if (!last) {
      savePartial();
      goTo(current + 1, true);
      return;
    }

    // Final submit — write the completed row and confirm.
    submitFinal();
  });

  async function submitFinal() {
    nextBtn.classList.add("is-loading");
    nextBtn.disabled = true;
    completedState = true;
    persistLocal();
    try {
      await postPayload(buildPayload(true), false);
      clearStore();
      showThanks();
    } catch (err) {
      // The earlier partial saves almost certainly captured the answers, but
      // let them retry the final write so the row is flagged complete.
      completedState = false;
      console.error("Final submission error:", err);
      errorEl.textContent =
        "Sorry — we couldn't save your final answer. Please tap Finish again. (Your earlier answers are already saved.)";
    } finally {
      nextBtn.classList.remove("is-loading");
      nextBtn.disabled = false;
    }
  }

  function showThanks() {
    form.hidden = true;
    thanksEl.hidden = false;
    setProgress(total - 1, true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushOnHide();
  });
  window.addEventListener("pagehide", flushOnHide);

  // ----- Boot -----
  if (stored && stored.raw && !stored.completed) {
    restoreRaw(stored.raw);
    syncOtherInputs(null); // re-clear any orphaned "other" text, keep checked ones
  }
  render(false);
})();
