/**
 * Toothpod ICP Survey — Google Apps Script backend (writes to Sheet1).
 *
 * What it does
 * ------------
 * The survey POSTs the respondent's *current* answers on every step (and again
 * if they close the tab mid-way), each tagged with a per-session id. This
 * script UPSERTS one row per session into "Sheet1": the first POST creates the
 * row, and every later POST fills it in further. That means partial / abandoned
 * responses are captured too — not just completed ones. The "Status" column
 * tells you whether a row is still "In progress" or "Completed".
 *
 * One-time deployment
 * -------------------
 *   1. Open (or create) the Google Sheet that should hold responses. The first
 *      tab is named "Sheet1" by default — that's what this writes to.
 *   2. In that sheet: Extensions → Apps Script.
 *   3. Delete the placeholder code, paste this whole file, and Save.
 *   4. Deploy → New deployment → Type: Web app
 *        • Description: Toothpod ICP Survey
 *        • Execute as: Me
 *        • Who has access: Anyone
 *      Click Deploy and authorize when prompted.
 *   5. Copy the "Web app" URL (ends in /exec) and paste it into config.js:
 *        window.TOOTHPOD_SURVEY_CONFIG = { endpoint: "https://script.google.com/macros/s/XXXX/exec" };
 *   6. After ANY later edit to this script, redeploy a new version:
 *        Deploy → Manage deployments → (edit, pencil) → Version: New version → Deploy.
 *
 * Tip: run `setupHeaders` once from the editor (Run ▸ setupHeaders) if you want
 * the header row created before the first real response arrives.
 */

var SHEET_NAME = "Sheet1";

// Fixed columns written before / after the per-question answer columns.
var BASE_HEADERS = ["Session ID", "Started At", "Last Updated", "Status", "Answered", "Current Step"];
var META_HEADERS = ["Timezone", "User Agent", "Page URL"];

// Header labels in the order they should appear if no schema is sent. The
// survey always sends a schema, but this keeps the sheet sensible regardless.
var DEFAULT_QUESTION_HEADERS = [
  "Q1 · Main reason for buying",
  "Q2 · What was going on in life",
  "Q3 · Biggest fear / frustration",
  "Q4 · What they tried & why it failed",
  "Q5 · What convinced them",
  "Q6 · Feeling if no longer available",
  "Q7 · Age",
  "Q8 · Identity",
];

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // serialize concurrent partial saves
  } catch (lockErr) {
    return jsonResponse_({ ok: false, error: "Server busy, please retry." });
  }
  try {
    var body = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    var payload = JSON.parse(body);
    var sheet = getOrCreateSheet_();
    upsertRow_(sheet, payload);
    return jsonResponse_({ ok: true });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return jsonResponse_({ ok: true, message: "Toothpod ICP survey endpoint is live." });
}

function getOrCreateSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  return sheet;
}

/** Ensure the header row exists and contains every column we need. Returns the
 *  current full header array. */
function ensureHeaders_(sheet, questionHeaders) {
  var desired = BASE_HEADERS.concat(questionHeaders).concat(META_HEADERS);
  var lastCol = sheet.getLastColumn();
  var existing = [];
  if (lastCol > 0) {
    existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].filter(function (v) {
      return v !== "" && v !== null;
    });
  }

  if (existing.length === 0) {
    styleHeaderRange_(sheet.getRange(1, 1, 1, desired.length).setValues([desired]));
    sheet.setFrozenRows(1);
    return desired.slice();
  }

  // Union in any columns we don't have yet (e.g. a question was added later).
  var missing = desired.filter(function (h) {
    return existing.indexOf(h) === -1;
  });
  if (missing.length) {
    styleHeaderRange_(sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]));
    existing = existing.concat(missing);
  }
  return existing;
}

function styleHeaderRange_(range) {
  range.setFontWeight("bold").setBackground("#013165").setFontColor("#ffffff");
}

function upsertRow_(sheet, payload) {
  var answers = (payload && payload.answers) || {};
  var schema = (payload && payload.schema) || [];
  var meta = (payload && payload.meta) || {};

  var questionHeaders = schema.length
    ? schema.map(function (q) { return q.label || q.name; })
    : DEFAULT_QUESTION_HEADERS;
  var questionKeys = schema.length
    ? schema.map(function (q) { return q.name; })
    : Object.keys(answers);

  var headers = ensureHeaders_(sheet, questionHeaders);

  var startedAt = payload && payload.startedAt ? new Date(payload.startedAt) : new Date();
  var status = payload && payload.completed ? "Completed" : "In progress";
  var answered =
    (payload && payload.answeredCount != null ? payload.answeredCount : "") +
    "/" +
    (payload && payload.totalSteps != null ? payload.totalSteps : questionHeaders.length);

  // Map each header to its value for this submission.
  function valueForHeader(header) {
    switch (header) {
      case "Session ID": return payload.sessionId || "";
      case "Started At": return startedAt;
      case "Last Updated": return new Date();
      case "Status": return status;
      case "Answered": return answered;
      case "Current Step": return payload && payload.currentStep != null ? payload.currentStep : "";
      case "Timezone": return meta.timezone || "";
      case "User Agent": return meta.userAgent || "";
      case "Page URL": return meta.page || "";
      default:
        var idx = questionHeaders.indexOf(header);
        if (idx >= 0) {
          var key = questionKeys[idx];
          return answers[key] != null ? answers[key] : "";
        }
        return "";
    }
  }

  var row = headers.map(valueForHeader);

  // Find an existing row for this session id (column A) and update in place.
  var sessionId = payload.sessionId || "";
  var existingRowIndex = sessionId ? findRowBySession_(sheet, sessionId) : -1;

  if (existingRowIndex > 0) {
    sheet.getRange(existingRowIndex, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
}

/** Returns the 1-based row index whose Session ID matches, or -1. */
function findRowBySession_(sheet, sessionId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1; // only header (or empty)
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(sessionId)) return i + 2;
  }
  return -1;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Optional: run once from the editor to pre-create the header row. */
function setupHeaders() {
  ensureHeaders_(getOrCreateSheet_(), DEFAULT_QUESTION_HEADERS);
}
