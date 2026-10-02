import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { readFileAsSheets } from "./file-parser.js";
import {
  cleanCircanaReport, runQcChecks, findIdColumn, computeTrendAndMovers,
  getLocalAnswer, fmtInt, fmtPct, fmtNum, autoDetectNumericColumns,
} from "./report-engine.js";
import { saveReport, listReports, loadReportData, deleteReport, deleteReports, getStorageEstimateMB } from "./firestore-storage.js";
import { getGeminiAnswer, getGeminiExecSummary } from "./gemini.js";

function toast(msg) {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// Fallback for files the Circana parser can't make sense of: treat the
// first row as the header, everything else as data (mirrors the original
// app's plain pd.read_csv / pd.read_excel fallback).
function plainParse(rawRows) {
  const rows = rawRows.filter((r) => r && r.some((v) => v !== null && v !== undefined && String(v).trim() !== ""));
  if (!rows.length) return { columns: [], numericColumns: [], rows: [] };

  // Instead of blindly taking row 0 (which is often a title or banner),
  // pick the row within the first 15 rows that is best suited as a header (text labels, not sales numbers)
  let headerIdx = 0;
  let maxScore = -999;
  const searchLimit = Math.min(15, rows.length);
  for (let i = 0; i < searchLimit; i++) {
    const row = rows[i] || [];
    let textCells = 0;
    let numCells = 0;
    row.forEach((v) => {
      if (v === null || v === undefined || String(v).trim() === "") return;
      const s = String(v).replace(/,/g, "").trim();
      const isDataNumber = (typeof v === "number" && !Number.isInteger(v)) || /^-?\d+\.\d+$/.test(s) || /^-?\d{5,}$/.test(s);
      if (isDataNumber) numCells += 1;
      else textCells += 1;
    });
    const score = textCells - numCells * 5;
    if (score > maxScore) {
      maxScore = score;
      headerIdx = i;
    }
  }

  const rawHeaders = rows[headerIdx] || [];
  const bodyRows = rows.slice(headerIdx + 1);

  const seen = {};
  const headers = rawHeaders.map((h, i) => {
    let name = (h === null || h === undefined || String(h).trim() === "") ? `col_${i}` : String(h).trim();
    if (seen[name] !== undefined) {
      seen[name] += 1;
      name = `${name}_${seen[name] + 1}`;
    } else {
      seen[name] = 0;
    }
    return name;
  });

  let body = bodyRows.map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : null; });
    return obj;
  });

  // Drop columns that are completely empty across the entire body (e.g. ghost Excel columns)
  const keepCols = headers.filter((h) => body.some((r) => r[h] !== null && r[h] !== undefined && String(r[h]).trim() !== ""));
  body = body.filter((r) => keepCols.some((h) => r[h] !== null && r[h] !== undefined && String(r[h]).trim() !== ""));

  return { columns: keepCols, numericColumns: [], rows: body };
}

function loadReport(rawRows, filename) {
  let parsed;
  try {
    parsed = cleanCircanaReport(rawRows, filename);
  } catch (err) {
    parsed = plainParse(rawRows);
  }
  // Regardless of which parser produced it, also flag any column that's
  // mostly numeric by value — catches files that don't use Circana's
  // column-naming convention (e.g. custom "Executive Dashboard" exports).
  return autoDetectNumericColumns(parsed);
}

// A sheet counts as "empty" if it has fewer than 2 rows with any real
// content (i.e. no room for a header + at least one data row) — common for
// leftover blank sheets in Circana/Nielsen workbooks.
function hasRealData(rawRows) {
  const nonEmptyRows = rawRows.filter(
    (r) => r && r.some((v) => v !== null && v !== undefined && String(v).trim() !== ""),
  );
  return nonEmptyRows.length >= 2;
}

// ---------------------------------------------------------------------------
// Auth page — tab switching
// ---------------------------------------------------------------------------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const isLogin = btn.dataset.tab === "login";
    document.getElementById("login-form").classList.toggle("hidden", !isLogin);
    document.getElementById("register-form").classList.toggle("hidden", isLogin);
  });
});

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  errEl.classList.add("hidden");
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    errEl.textContent = "Invalid email or password.";
    errEl.classList.remove("hidden");
  }
});

document.getElementById("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("reg-name").value.trim();
  const email = document.getElementById("reg-email").value.trim();
  const pw1 = document.getElementById("reg-password").value;
  const pw2 = document.getElementById("reg-password2").value;
  const errEl = document.getElementById("register-error");
  errEl.classList.add("hidden");

  if (!email.toLowerCase().endsWith("@circana.com")) {
    errEl.textContent = "Only @circana.com emails are allowed.";
    errEl.classList.remove("hidden");
    return;
  }
  if (pw1 !== pw2) {
    errEl.textContent = "Passwords do not match.";
    errEl.classList.remove("hidden");
    return;
  }

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pw1);
    await updateProfile(cred.user, { displayName: name });
    await setDoc(doc(db, "users", cred.user.uid), { name, email, createdAt: new Date().toISOString() });
    toast(`Welcome, ${name}! 🎉`);
  } catch (err) {
    errEl.textContent = err.code === "auth/email-already-in-use"
      ? "This email is already registered."
      : "Registration failed. Please try again.";
    errEl.classList.remove("hidden");
  }
});

// Only these people can view/edit the shared Gemini key. Keep this list in
// sync with isAdmin() in firestore.rules.
const ADMIN_EMAILS = ["spyros.alamanos@circana.com"];

document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const state = {
  user: null,
  savedReports: [],     // metadata from Firestore: [{id, fileName, columns, numericColumns, rowCount}]
  selectedIds: [],
  reportsMap: {},        // {fileName: {columns, numericColumns, rows}} — loaded on Analyze
  fileNames: [],          // sorted fileNames matching reportsMap, oldest->newest
  qcResults: null,
  metric: null,
  trendResult: null,
  lastSummaryMarkdown: null,
  chart: null,
  geminiKey: "",
};

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    document.getElementById("auth-page").classList.remove("hidden");
    document.getElementById("app-shell").classList.add("hidden");
    return;
  }
  state.user = user;
  state.isAdmin = ADMIN_EMAILS.includes((user.email || "").toLowerCase());
  document.getElementById("auth-page").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");

  document.getElementById("sidebar-name").textContent = user.displayName || "—";
  document.getElementById("sidebar-email").textContent = user.email;
  document.getElementById("welcome-line").textContent = `Welcome, ${user.displayName || user.email}!`;

  await loadGeminiKey();
  await refreshFileList();
});

// ---------------------------------------------------------------------------
// Gemini key — ONE shared key for the whole @circana.com team, stored at
// config/shared. Any signed-in team member can read it (so the AI chat
// "just works" for everyone) and, per firestore.rules, can also update it.
// ---------------------------------------------------------------------------
const SHARED_KEY_DOC = doc(db, "config", "shared");

async function loadGeminiKey() {
  let key = "";
  try {
    const snap = await getDoc(SHARED_KEY_DOC);
    key = snap.exists() ? (snap.data().geminiApiKey || "") : "";
  } catch (err) {
    key = "";
  }
  state.geminiKey = key;

  const adminBlock = document.getElementById("gemini-admin-block");
  const userNote = document.getElementById("gemini-user-note");
  if (state.isAdmin) {
    adminBlock.classList.remove("hidden");
    userNote.classList.add("hidden");
    document.getElementById("gemini-key-input").value = key;
  } else {
    adminBlock.classList.add("hidden");
    userNote.classList.remove("hidden");
    userNote.textContent = key ? "🤖 AI chat active." : "Free, local chatbox (no AI active right now).";
  }

  updateChatModeLine();
  updateSummaryLock();
}

document.getElementById("save-key-btn").addEventListener("click", async () => {
  const key = document.getElementById("gemini-key-input").value.trim();
  await setDoc(SHARED_KEY_DOC, { geminiApiKey: key, updatedBy: state.user.email, updatedAt: new Date().toISOString() });
  state.geminiKey = key;
  toast(key ? "Shared API key saved for the team ✅" : "Shared API key removed.");
  updateChatModeLine();
  updateSummaryLock();
});

function updateChatModeLine() {
  document.getElementById("chat-mode-line").textContent = state.geminiKey
    ? "🤖 Powered by Gemini AI — ask anything freely."
    : "Free, local chatbox (no AI). Add a Gemini API key in the sidebar for free questions.";
}

function updateSummaryLock() {
  document.getElementById("summary-locked").classList.toggle("hidden", !!state.geminiKey);
  document.getElementById("summary-btn").classList.toggle("hidden", !state.geminiKey);
}

// ---------------------------------------------------------------------------
// Upload + list saved reports (Firestore, chunked)
// ---------------------------------------------------------------------------
document.getElementById("file-input").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;

  const statusEl = document.getElementById("upload-status");
  statusEl.classList.remove("hidden");

  let ok = 0;
  for (const file of files) {
    if (!/\.(xlsx|csv)$/i.test(file.name)) {
      toast(`Skipping "${file.name}" — only .xlsx/.csv allowed.`);
      continue;
    }
    try {
      statusEl.textContent = `Reading "${file.name}"...`;
      const sheets = await readFileAsSheets(file);

      // Parse every sheet, keep only the ones that actually contain data —
      // and keep a transparent record of what happened to each one.
      const validSheets = [];
      const skipped = [];
      for (const { sheetName, rows } of sheets) {
        const label = sheetName || file.name;
        if (!hasRealData(rows)) {
          skipped.push(`${label} (empty)`);
          continue;
        }
        let parsed;
        try {
          parsed = loadReport(rows, file.name);
        } catch (err) {
          skipped.push(`${label} (parsing error)`);
          continue;
        }
        if (parsed && parsed.rows.length > 0) {
          validSheets.push({ sheetName, parsed });
        } else {
          skipped.push(`${label} (0 rows after parsing)`);
        }
      }

      toast(`"${file.name}": found ${sheets.length} total sheets — ${validSheets.length} with data`
        + (skipped.length ? `, skipped: ${skipped.join(", ")}` : "."));

      if (!validSheets.length) {
        toast(`No data found in any sheet of "${file.name}".`);
        continue;
      }

      const multiSheet = validSheets.length > 1;
      for (const { sheetName, parsed } of validSheets) {
        const reportName = multiSheet && sheetName ? `${file.name} — ${sheetName}` : file.name;
        statusEl.textContent = `Saving "${reportName}"...`;
        await saveReport(state.user.uid, reportName, parsed);
        ok += 1;
      }
    } catch (err) {
      console.error(`Upload error for "${file.name}":`, err);
      toast(`Error in "${file.name}": ${err.message}`);
    }
  }

  statusEl.classList.add("hidden");
  e.target.value = "";
  if (ok) toast(`✅ ${ok} file(s) saved!`);
  await refreshFileList();
});

function updateSelectionUI() {
  const box = document.getElementById("file-checkboxes");
  const checkedBoxes = Array.from(box.querySelectorAll("input:checked"));
  state.selectedIds = checkedBoxes.map((i) => i.dataset.id);

  const deleteSelectedBtn = document.getElementById("delete-selected-btn");
  const deleteAllBtn = document.getElementById("delete-all-btn");
  const analyzeBtn = document.getElementById("analyze-btn");

  if (deleteSelectedBtn) {
    deleteSelectedBtn.disabled = state.selectedIds.length === 0;
    deleteSelectedBtn.textContent = state.selectedIds.length > 0
      ? `🗑️ Delete Selected (${state.selectedIds.length})`
      : "🗑️ Delete Selected";
  }

  if (deleteAllBtn) {
    deleteAllBtn.disabled = state.savedReports.length === 0;
  }

  if (analyzeBtn) {
    analyzeBtn.disabled = state.selectedIds.length === 0;
  }
}

async function performBatchDelete(ids) {
  if (!ids || !ids.length) return;
  const statusEl = document.getElementById("file-delete-status");
  const selectAllBtn = document.getElementById("select-all-btn");
  const deselectAllBtn = document.getElementById("deselect-all-btn");
  const deleteSelectedBtn = document.getElementById("delete-selected-btn");
  const deleteAllBtn = document.getElementById("delete-all-btn");
  const analyzeBtn = document.getElementById("analyze-btn");
  const box = document.getElementById("file-checkboxes");

  if (selectAllBtn) selectAllBtn.disabled = true;
  if (deselectAllBtn) deselectAllBtn.disabled = true;
  if (deleteSelectedBtn) deleteSelectedBtn.disabled = true;
  if (deleteAllBtn) deleteAllBtn.disabled = true;
  if (analyzeBtn) analyzeBtn.disabled = true;
  box.querySelectorAll("button, input").forEach((el) => { el.disabled = true; });

  if (statusEl) {
    statusEl.classList.remove("hidden");
    statusEl.textContent = `⏳ Deleting 0 of ${ids.length} reports...`;
  }

  try {
    await deleteReports(state.user.uid, ids, (done, total) => {
      if (statusEl) {
        statusEl.textContent = `⏳ Deleting ${done} of ${total} reports...`;
      }
    });
    toast(`✅ Successfully deleted ${ids.length} report(s).`);
  } catch (err) {
    console.error(err);
    toast("Error deleting reports. Please try again.");
  } finally {
    if (statusEl) statusEl.classList.add("hidden");
    await refreshFileList();
  }
}

async function refreshFileList() {
  state.savedReports = await listReports(state.user.uid);

  const sidebarList = document.getElementById("sidebar-file-list");
  sidebarList.innerHTML = "";
  state.savedReports.forEach((r) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>📄 ${r.fileName}</span>`;
    sidebarList.appendChild(li);
  });
  const estMb = await getStorageEstimateMB(state.savedReports);
  document.getElementById("storage-note").textContent = state.savedReports.length
    ? `💾 Estimated usage: ~${estMb.toFixed(1)} MB`
    : "No saved reports yet.";

  const block = document.getElementById("file-select-block");
  const box = document.getElementById("file-checkboxes");
  box.innerHTML = "";

  if (!state.savedReports.length) {
    block.classList.add("hidden");
    state.selectedIds = [];
    updateSelectionUI();
    return;
  }
  block.classList.remove("hidden");

  state.savedReports.forEach((r) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:0.5em;padding:0.2em 0;";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.id = `cb-${r.id}`;
    cb.dataset.id = r.id;
    cb.addEventListener("change", () => {
      updateSelectionUI();
    });

    const label = document.createElement("label");
    label.htmlFor = cb.id;
    label.style.cssText = "margin:0;font-size:0.9rem;color:var(--ink);flex:1;cursor:pointer;";
    label.textContent = `${r.fileName} (${fmtInt(r.rowCount)} rows)`;

    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "🗑️";
    del.title = `Delete ${r.fileName}`;
    del.addEventListener("click", async () => {
      if (!confirm(`Are you sure you want to delete "${r.fileName}"?`)) return;
      del.disabled = true;
      del.textContent = "⏳";
      try {
        await deleteReport(state.user.uid, r.id);
        toast(`Deleted: ${r.fileName}`);
      } catch (err) {
        console.error(err);
        toast("Error deleting report.");
      }
      await refreshFileList();
    });

    row.append(cb, label, del);
    box.appendChild(row);
  });

  state.selectedIds = state.savedReports.map((r) => r.id);
  updateSelectionUI();
}

document.getElementById("select-all-btn").addEventListener("click", () => {
  const box = document.getElementById("file-checkboxes");
  box.querySelectorAll("input[type='checkbox']").forEach((cb) => { cb.checked = true; });
  updateSelectionUI();
});

document.getElementById("deselect-all-btn").addEventListener("click", () => {
  const box = document.getElementById("file-checkboxes");
  box.querySelectorAll("input[type='checkbox']").forEach((cb) => { cb.checked = false; });
  updateSelectionUI();
});

document.getElementById("delete-selected-btn").addEventListener("click", async () => {
  const count = state.selectedIds.length;
  if (!count) {
    toast("Please select at least one report to delete.");
    return;
  }
  if (!confirm(`Are you sure you want to delete ${count} selected report(s)?`)) {
    return;
  }
  await performBatchDelete(state.selectedIds);
});

document.getElementById("delete-all-btn").addEventListener("click", async () => {
  const count = state.savedReports.length;
  if (!count) return;
  if (!confirm(`Are you sure you want to delete ALL ${count} report(s)? This action cannot be undone.`)) {
    return;
  }
  await performBatchDelete(state.savedReports.map((r) => r.id));
});

// ---------------------------------------------------------------------------
// Analyze
// ---------------------------------------------------------------------------
document.getElementById("analyze-btn").addEventListener("click", async () => {
  if (!state.selectedIds.length) {
    toast("Please select at least one report.");
    return;
  }
  const btn = document.getElementById("analyze-btn");
  btn.disabled = true;
  btn.textContent = "Analyzing...";

  try {
    const AQC_PATTERN = /\bAQC\b/i;
    const selected = state.savedReports
      .filter((r) => state.selectedIds.includes(r.id))
      .filter((r) => !AQC_PATTERN.test(r.fileName))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));

    if (!selected.length) {
      toast("All selected reports are of type AQC and skipped — please select at least one other report.");
      btn.disabled = false;
      btn.textContent = "🔍 Analyze";
      return;
    }

    state.reportsMap = {};
    for (const meta of selected) {
      state.reportsMap[meta.fileName] = await loadReportData(state.user.uid, meta);
    }
    state.fileNames = selected.map((r) => r.fileName);

    state.qcResults = state.fileNames.map((name) => runQcChecks(state.reportsMap[name], name));
    renderQc(state.qcResults);

    const nameWithMetric = state.fileNames.find(
      (name) => state.reportsMap[name].numericColumns.length > 0,
    );
    const firstParsed = state.reportsMap[nameWithMetric || state.fileNames[0]];
    const validNumericColumns = firstParsed.numericColumns.filter(
      (col) => !/^-?\d+(\.\d+)?$/.test(String(col).trim())
    );
    const select = document.getElementById("metric-select");
    select.innerHTML = "";
    validNumericColumns.forEach((col) => {
      const opt = document.createElement("option");
      opt.value = col;
      opt.textContent = col;
      select.appendChild(opt);
    });

    document.getElementById("qc-section").classList.remove("hidden");
    document.getElementById("chat-section").classList.remove("hidden");
    document.getElementById("export-section").classList.remove("hidden");

    const hasMetric = validNumericColumns.length > 0;
    document.getElementById("kpi-section").classList.toggle("hidden", !hasMetric);
    document.getElementById("summary-section").classList.toggle("hidden", !hasMetric);

    if (hasMetric) {
      state.metric = validNumericColumns[0];
      computeMetric();
    } else {
      state.metric = null;
      state.trendResult = null;
      toast("No numeric columns found (e.g. Sales, Units, Price) — KPI trend and exec summary need at least one. Chat works normally.");
    }
  } catch (err) {
    toast(`Analysis error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "🔍 Analyze";
  }
});

document.getElementById("metric-select").addEventListener("change", (e) => {
  state.metric = e.target.value;
  computeMetric();
});

function renderQc(qcResults) {
  const root = document.getElementById("qc-panels");
  root.innerHTML = "";

  qcResults.forEach((r) => {
    const panel = document.createElement("div");
    panel.className = "qc-panel";

    const scoreClass = r.score >= 85 ? "good" : r.score >= 60 ? "warn" : "bad";
    const emoji = r.isClean ? "✅" : (r.score < 60 ? "🔴" : r.score < 85 ? "🟡" : "🟢");

    let html = `<h3>${emoji} ${r.name}</h3>`;
    html += `<div class="metrics-row">
      <div class="metric-block"><div class="label">Data Quality</div><div class="value ${scoreClass}">${r.score}/100</div></div>
      <div class="metric-block"><div class="label">Rows</div><div class="value">${fmtInt(r.rows)}</div></div>
      <div class="metric-block"><div class="label">Issues</div><div class="value ${r.issuesTable.length === 0 ? "good" : r.issuesTable.length > 5 ? "bad" : "warn"}">${r.issuesTable.length}</div></div>
    </div>`;

    if (r.isClean) {
      html += `<p class="hint">No quality issues detected.</p>`;
    } else {
      html += `<table class="qc-table"><thead><tr>
        <th>Level</th><th>Issue</th><th>Column</th><th>Count</th><th>% Rows</th>
      </tr></thead><tbody>`;
      r.issuesTable.forEach((i) => {
        const chipClass = i.level === "Critical" ? "critical"
          : i.level === "Warning" ? "warning"
          : i.level === "Info" ? "info" : "ok";
        html += `<tr>
          <td><span class="severity-chip ${chipClass}">${i.level}</span></td>
          <td>${i.category}</td>
          <td>${i.column}</td>
          <td class="num">${fmtInt(i.count)}</td>
          <td class="num">${fmtPct(i.pct)}</td>
        </tr>`;
      });
      html += `</tbody></table>`;
    }
    panel.innerHTML = html;
    root.appendChild(panel);
  });
}


// ---------------------------------------------------------------------------
// KPI trend + movers (all computed client-side, instantly)
// ---------------------------------------------------------------------------
function computeMetric() {
  const result = computeTrendAndMovers(state.reportsMap, state.fileNames, state.metric, 10);
  state.trendResult = result;

  renderTrendChart(result.trend);

  const first = result.trend[0]?.value ?? 0;
  const latest = result.trend[result.trend.length - 1]?.value ?? 0;
  document.getElementById("metric-first").textContent = fmtNum(first);
  document.getElementById("metric-latest").textContent = fmtNum(latest);

  const pct = result.pctChange ?? 0;
  const changeEl = document.getElementById("metric-change");
  changeEl.textContent = fmtPct(pct);
  changeEl.className = "value " + (pct > 0 ? "good" : pct < 0 ? "bad" : "");

  const execLine = document.getElementById("exec-line");
  if (pct > 0) execLine.textContent = `${state.metric} increased by ${fmtPct(pct)} from first to latest report.`;
  else if (pct < 0) execLine.textContent = `${state.metric} decreased by ${fmtPct(Math.abs(pct))} from first to latest report.`;
  else execLine.textContent = `${state.metric} remained stable.`;

  document.getElementById("movers-section").classList.toggle("hidden", !result.idColumn);
  if (result.idColumn) renderMovers(result.moversTop, result.moversBottom, result.idColumn);
}

function renderTrendChart(trend) {
  const ctx = document.getElementById("trend-chart").getContext("2d");
  if (state.chart) state.chart.destroy();
  // eslint-disable-next-line no-undef
  state.chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: trend.map((t) => t.file),
      datasets: [{
        label: state.metric,
        data: trend.map((t) => t.value),
        borderColor: "#C1862E",
        backgroundColor: "#C1862E33",
        tension: 0.15,
        pointRadius: 4,
      }],
    },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: false } } },
  });
}

function renderMovers(top, bottom, idCol) {
  const topEl = document.getElementById("movers-top");
  const bottomEl = document.getElementById("movers-bottom");
  topEl.innerHTML = "";
  bottomEl.innerHTML = "";
  (top || []).forEach((row) => {
    const li = document.createElement("li");
    li.textContent = `${row[idCol]}: ${fmtNum(row[state.metric])}`;
    topEl.appendChild(li);
  });
  (bottom || []).forEach((row) => {
    const li = document.createElement("li");
    li.textContent = `${row[idCol]}: ${fmtNum(row[state.metric])}`;
    bottomEl.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Executive summary (Gemini, client-side call)
// ---------------------------------------------------------------------------
document.getElementById("summary-btn").addEventListener("click", async () => {
  if (!state.trendResult || !state.metric) {
    toast("At least one numeric KPI is needed for executive summary — upload a report with columns like Sales/Units.");
    return;
  }
  const btn = document.getElementById("summary-btn");
  const out = document.getElementById("summary-output");
  btn.disabled = true;
  out.textContent = "Generating executive summary...";
  try {
    const summary = await getGeminiExecSummary(state.qcResults, state.metric, state.trendResult, state.geminiKey);
    out.textContent = summary;
    state.lastSummaryMarkdown = summary;
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
function appendChatMsg(role, content) {
  const log = document.getElementById("chat-log");
  const el = document.createElement("div");
  el.className = `chat-msg ${role}`;
  el.textContent = content;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

async function sendChat() {
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send-btn");
  const prompt = input.value.trim();
  if (!prompt) return;
  input.value = "";
  input.disabled = true;
  sendBtn.disabled = true;
  appendChatMsg("user", prompt);

  const idCol = findIdColumn(state.reportsMap[state.fileNames[0]]);

  if (state.geminiKey) {
    const thinkingEl = appendChatMsg("assistant", "▍"); // blinking cursor placeholder
    const log = document.getElementById("chat-log");

    const result = await getGeminiAnswer(
      prompt,
      state.reportsMap,
      state.fileNames,
      state.geminiKey,
      state.qcResults,
      (partialText) => {
        thinkingEl.textContent = partialText + "▍";
        log.scrollTop = log.scrollHeight;
      }
    );
    thinkingEl.textContent = result; // final clean text, no cursor
    log.scrollTop = log.scrollHeight;
  } else {
    const answer = getLocalAnswer(prompt, state.reportsMap, state.fileNames, idCol, state.metric, state.qcResults);
    appendChatMsg("assistant", answer);
  }

  input.disabled = false;
  sendBtn.disabled = false;
  input.focus();
}

document.getElementById("chat-send-btn").addEventListener("click", sendChat);
document.getElementById("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});
// ---------------------------------------------------------------------------
// PowerPoint Export (PptxGenJS)
// ---------------------------------------------------------------------------

// Turn a light "## Header" / "* bullet" markdown string into structured
// { type: "h" | "b" | "p", text } lines — no raw #/* ever reaches the slide.
function parseMarkdownLite(md) {
  return (md || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      if (/^#{1,3}\s+/.test(line)) return { type: "h", text: line.replace(/^#{1,3}\s+/, "") };
      if (/^[-*]\s+/.test(line)) return { type: "b", text: line.replace(/^[-*]\s+/, "") };
      return { type: "p", text: line };
    });
}

function pptxTruncate(text, max) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 1).trim() + "…" : text;
}

async function exportToPowerPoint() {
  if (!window.PptxGenJS) {
    toast("⚠️ The PowerPoint library has not loaded yet. Please check your connection.");
    return;
  }
  if (!state.fileNames || !state.fileNames.length) {
    toast("⚠️ No analyzed data available for export.");
    return;
  }

  const exportBtn = document.getElementById("export-pptx-btn");
  exportBtn.disabled = true;
  exportBtn.textContent = "⏳ Generating PowerPoint...";

  try {
    // eslint-disable-next-line no-undef
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE"; // 13.33" x 7.5" — MUST be set before addSlide()
    pptx.title = "Circana KPIs Analysis - Executive Presentation";
    pptx.author = state.user?.displayName || "Circana KPIs Analysis";

    const PAGE_W = 13.333;
    const MARGIN = 0.55;
    const CONTENT_W = PAGE_W - MARGIN * 2;

    // Matches the app's own palette (--ink, --accent, --paper, --line).
    const C_INK = "1D2B36";
    const C_MUTED = "64748B";
    const C_LINE = "E2E8F0";
    const C_ACCENT = "C1862E";
    const C_GOOD = "2F6E63";
    const C_BAD = "A64E2E";
    const C_PAPER = "F6F7F2";

    const dateStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const userEmail = state.user?.email || "Circana User";
    const userName = state.user?.displayName || userEmail;

    function addFooter(slide, pageLabel) {
      slide.addText(
        [{ text: "Circana KPIs Analysis", options: { bold: true } }, { text: `   •   ${dateStr}` }],
        { x: MARGIN, y: 7.12, w: 8, h: 0.3, fontSize: 9, color: C_MUTED, fontFace: "Georgia", isTextBox: true },
      );
      if (pageLabel) {
        slide.addText(pageLabel, {
          x: PAGE_W - MARGIN - 3, y: 7.12, w: 3, h: 0.3, fontSize: 9, color: C_MUTED,
          fontFace: "Georgia", align: "right", isTextBox: true,
        });
      }
    }

    function addSectionTitle(slide, title, subtitle) {
      slide.addText(title, {
        x: MARGIN, y: 0.5, w: CONTENT_W, h: 0.55, fontSize: 26, bold: true, color: C_INK,
        fontFace: "Georgia", isTextBox: true,
      });
      if (subtitle) {
        slide.addText(subtitle, {
          x: MARGIN, y: 1.05, w: CONTENT_W, h: 0.35, fontSize: 13, color: C_MUTED,
          fontFace: "IBM Plex Sans", isTextBox: true,
        });
      }
    }

    // ------------------------------------------------------------------
    // Slide 1 — Title
    // ------------------------------------------------------------------
    {
      const s = pptx.addSlide();
      s.background = { color: "FFFFFF" };

      s.addText("Circana KPIs Analysis", {
        x: MARGIN, y: 0.7, w: CONTENT_W, h: 0.5, fontSize: 15, bold: true, color: C_ACCENT,
        fontFace: "IBM Plex Sans", charSpacing: 1, isTextBox: true,
      });
      s.addText("Executive Presentation", {
        x: MARGIN, y: 1.15, w: CONTENT_W, h: 1.0, fontSize: 40, bold: true, color: C_INK,
        fontFace: "Georgia", isTextBox: true,
      });
      s.addText(`Data Analysis & Quality Assessment  •  KPI: ${state.metric || "—"}`, {
        x: MARGIN, y: 2.05, w: CONTENT_W, h: 0.4, fontSize: 15, color: C_MUTED,
        fontFace: "IBM Plex Sans", isTextBox: true,
      });

      const stats = [
        { label: "Reports", value: String(state.fileNames.length) },
        { label: "Date", value: dateStr },
        { label: "Prepared By", value: userName },
      ];
      const cardW = (CONTENT_W - 0.4 * 2) / 3;
      stats.forEach((st, i) => {
        const x = MARGIN + i * (cardW + 0.4);
        s.addShape(pptx.shapes.RECTANGLE, {
          x, y: 2.75, w: cardW, h: 1.05, fill: { color: C_PAPER }, line: { color: C_LINE, width: 1 },
        });
        s.addText(st.label.toUpperCase(), {
          x: x + 0.2, y: 2.87, w: cardW - 0.4, h: 0.25, fontSize: 9, bold: true, color: C_MUTED,
          fontFace: "IBM Plex Sans", charSpacing: 1, isTextBox: true,
        });
        s.addText(st.value, {
          x: x + 0.2, y: 3.15, w: cardW - 0.4, h: 0.55, fontSize: 16, bold: true, color: C_INK,
          fontFace: "Georgia", isTextBox: true, fit: "shrink",
        });
      });

      s.addText("ANALYZED REPORTS", {
        x: MARGIN, y: 4.15, w: CONTENT_W, h: 0.3, fontSize: 10, bold: true, color: C_MUTED,
        fontFace: "IBM Plex Sans", charSpacing: 1, isTextBox: true,
      });

      const MAX_LISTED = 10;
      const shown = state.fileNames.slice(0, MAX_LISTED).map((f) => pptxTruncate(f.split(" — ").pop() || f, 46));
      const extra = state.fileNames.length - shown.length;
      const half = Math.ceil(shown.length / 2);
      const col1 = shown.slice(0, half);
      const col2 = shown.slice(half);
      const bulletize = (arr) => arr.map((t, i) => ({
        text: t, options: { bullet: { code: "2022" }, breakLine: i < arr.length - 1, color: C_INK },
      }));

      s.addText(bulletize(col1), {
        x: MARGIN, y: 4.5, w: CONTENT_W / 2 - 0.2, h: 2.3, fontSize: 11.5, fontFace: "IBM Plex Sans",
        valign: "top", isTextBox: true, paraSpaceAfter: 6,
      });
      if (col2.length) {
        s.addText(bulletize(col2), {
          x: MARGIN + CONTENT_W / 2 + 0.2, y: 4.5, w: CONTENT_W / 2 - 0.2, h: 2.3, fontSize: 11.5,
          fontFace: "IBM Plex Sans", valign: "top", isTextBox: true, paraSpaceAfter: 6,
        });
      }
      if (extra > 0) {
        s.addText(`+ ${extra} more reports`, {
          x: MARGIN, y: 6.85, w: CONTENT_W, h: 0.3, fontSize: 10.5, italic: true, color: C_MUTED,
          fontFace: "IBM Plex Sans", isTextBox: true,
        });
      }
      addFooter(s, "1");
    }

    // ------------------------------------------------------------------
    // Slide(s) — QC table, paginated so rows never overflow
    // ------------------------------------------------------------------
    if (state.qcResults && state.qcResults.length) {
      const ROWS_PER_SLIDE = 9;
      const chunks = [];
      for (let i = 0; i < state.qcResults.length; i += ROWS_PER_SLIDE) {
        chunks.push(state.qcResults.slice(i, i + ROWS_PER_SLIDE));
      }

      chunks.forEach((chunk, idx) => {
        const s = pptx.addSlide();
        s.background = { color: "FFFFFF" };
        addSectionTitle(
          s,
          "Data Quality Assessment (QC)",
          chunks.length > 1 ? `Part ${idx + 1} of ${chunks.length}` : `${state.qcResults.length} reports evaluated`,
        );

        const header = [
          { text: "REPORT", options: { bold: true, fill: { color: C_INK }, color: "FFFFFF" } },
          { text: "SCORE", options: { bold: true, fill: { color: C_INK }, color: "FFFFFF", align: "center" } },
          { text: "ROWS", options: { bold: true, fill: { color: C_INK }, color: "FFFFFF", align: "right" } },
          { text: "ISSUES", options: { bold: true, fill: { color: C_INK }, color: "FFFFFF", align: "center" } },
        ];
        const rows = chunk.map((r, i) => {
          const bg = i % 2 === 0 ? "FFFFFF" : C_PAPER;
          const scoreColor = r.score >= 85 ? C_GOOD : r.score >= 50 ? C_ACCENT : C_BAD;
          return [
            { text: pptxTruncate(r.name, 46), options: { fill: { color: bg } } },
            { text: `${r.score}/100`, options: { fill: { color: bg }, align: "center", bold: true, color: scoreColor } },
            { text: fmtInt(r.rows), options: { fill: { color: bg }, align: "right" } },
            { text: r.issuesTable.length ? String(r.issuesTable.length) : "✓ Clean", options: { fill: { color: bg }, align: "center" } },
          ];
        });

        s.addTable([header, ...rows], {
          x: MARGIN, y: 1.55, w: CONTENT_W,
          fontSize: 11, fontFace: "IBM Plex Sans",
          border: { pt: 0.75, color: C_LINE },
          autoPage: false,
          colW: [CONTENT_W - 2.2 - 1.6 - 1.8, 2.2, 1.6, 1.8],
          rowH: 0.42,
          valign: "middle",
        });

        addFooter(s, `2.${idx + 1}`);
      });
    }

    // ------------------------------------------------------------------
    // Slide — KPI trend (native chart, not a canvas screenshot)
    // ------------------------------------------------------------------
    if (state.trendResult && state.metric) {
      const s = pptx.addSlide();
      s.background = { color: "FFFFFF" };
      addSectionTitle(s, `KPI Trend — ${state.metric}`, "Metric evolution across analyzed reports");

      const RIGHT_COL_W = 3.6;
      const CHART_W = CONTENT_W - RIGHT_COL_W - 0.4;

      s.addChart(pptx.ChartType.line, [
        {
          name: state.metric,
          labels: state.trendResult.trend.map((t) => t.file),
          values: state.trendResult.trend.map((t) => t.value),
        },
      ], {
        x: MARGIN, y: 1.6, w: CHART_W, h: 4.9,
        showTitle: false, showLegend: false,
        chartColors: [C_ACCENT],
        lineSize: 2.5, lineDataSymbol: "circle", lineDataSymbolSize: 6,
        catAxisLabelColor: C_MUTED, catAxisLabelFontSize: 9,
        valAxisLabelColor: C_MUTED, valAxisLabelFontSize: 9,
        valGridLine: { color: C_LINE, size: 1 },
        catGridLine: { style: "none" },
      });

      const first = state.trendResult.trend[0]?.value ?? 0;
      const latest = state.trendResult.trend[state.trendResult.trend.length - 1]?.value ?? 0;
      const pct = state.trendResult.pctChange ?? 0;
      const pctColor = pct > 0 ? C_GOOD : pct < 0 ? C_BAD : C_MUTED;

      const cardX = MARGIN + CHART_W + 0.4;
      const cards = [
        { label: "INITIAL REPORT", value: fmtNum(first), color: C_INK },
        { label: "LATEST REPORT", value: fmtNum(latest), color: C_INK },
        { label: "CHANGE", value: fmtPct(pct), color: pctColor },
      ];
      cards.forEach((c, i) => {
        const y = 1.6 + i * 1.65;
        s.addShape(pptx.shapes.RECTANGLE, {
          x: cardX, y, w: RIGHT_COL_W, h: 1.45, fill: { color: C_PAPER }, line: { color: C_LINE, width: 1 },
        });
        s.addText(c.label, {
          x: cardX + 0.25, y: y + 0.18, w: RIGHT_COL_W - 0.5, h: 0.3, fontSize: 9.5, bold: true,
          color: C_MUTED, fontFace: "IBM Plex Sans", charSpacing: 1, isTextBox: true,
        });
        s.addText(c.value, {
          x: cardX + 0.25, y: y + 0.5, w: RIGHT_COL_W - 0.5, h: 0.8, fontSize: 26, bold: true,
          color: c.color, fontFace: "Georgia", isTextBox: true, fit: "shrink",
        });
      });

      const execText = document.getElementById("exec-line")?.textContent;
      if (execText) {
        s.addText(execText, {
          x: MARGIN, y: 6.65, w: CONTENT_W, h: 0.4, fontSize: 12.5, italic: true, color: C_INK,
          fontFace: "IBM Plex Sans", isTextBox: true,
        });
      }
      addFooter(s, "3");
    }

    // ------------------------------------------------------------------
    // Slide — Top movers
    // ------------------------------------------------------------------
    if (state.trendResult && state.trendResult.idColumn) {
      const s = pptx.addSlide();
      s.background = { color: "FFFFFF" };
      addSectionTitle(s, `Top Movers — ${state.metric}`, "Highest growth and largest declines");

      const idCol = state.trendResult.idColumn;
      const colW = (CONTENT_W - 0.4) / 2;

      function moversTable(title, rowsData, accentColor, x) {
        const header = [
          { text: title, options: { bold: true, fill: { color: accentColor }, color: "FFFFFF" } },
          { text: state.metric, options: { bold: true, fill: { color: accentColor }, color: "FFFFFF", align: "right" } },
        ];
        const rows = (rowsData || []).map((r, i) => [
          { text: pptxTruncate(String(r[idCol] ?? "—"), 28), options: { fill: { color: i % 2 === 0 ? "FFFFFF" : C_PAPER } } },
          { text: fmtNum(r[state.metric]), options: { fill: { color: i % 2 === 0 ? "FFFFFF" : C_PAPER }, align: "right", bold: true, color: accentColor } },
        ]);
        s.addTable([header, ...rows], {
          x, y: 1.6, w: colW, fontSize: 12, fontFace: "IBM Plex Sans",
          border: { pt: 0.75, color: C_LINE }, colW: [colW - 2.0, 2.0], rowH: 0.42, valign: "middle",
        });
      }

      moversTable("TOP GROWING", state.trendResult.moversTop, C_GOOD, MARGIN);
      moversTable("LARGEST DECLINES", state.trendResult.moversBottom, C_BAD, MARGIN + colW + 0.4);

      addFooter(s, "4");
    }

    // ------------------------------------------------------------------
    // Slide(s) — Executive summary, real markdown formatting, paginated by
    // estimated rendered height (not just line count) so nothing overflows.
    // ------------------------------------------------------------------
    const summaryText = document.getElementById("summary-output")?.textContent.trim();
    if (summaryText) {
      const lines = parseMarkdownLite(summaryText);
      const CHARS_PER_LINE = 78;
      function estRows(item) {
        const wrapped = Math.max(1, Math.ceil(item.text.length / CHARS_PER_LINE));
        return item.type === "h" ? wrapped + 0.6 : wrapped + 0.35;
      }

      const BUDGET_ROWS = 15.5;
      const chunks = [];
      let current = [];
      let used = 0;
      lines.forEach((item) => {
        const rows = estRows(item);
        if (used + rows > BUDGET_ROWS && current.length) {
          if (current[current.length - 1].type === "h") {
            const orphan = current.pop();
            chunks.push(current);
            current = [orphan];
            used = estRows(orphan);
          } else {
            chunks.push(current);
            current = [];
            used = 0;
          }
        }
        current.push(item);
        used += rows;
      });
      if (current.length) chunks.push(current);

      chunks.forEach((chunk, idx) => {
        const s = pptx.addSlide();
        s.background = { color: "FFFFFF" };
        addSectionTitle(
          s,
          "Executive Summary",
          chunks.length > 1 ? `Part ${idx + 1} of ${chunks.length}` : "AI-generated insights",
        );

        const textRuns = [];
        chunk.forEach((line, i) => {
          const isLast = i === chunk.length - 1;
          if (line.type === "h") {
            textRuns.push({
              text: line.text,
              options: { bold: true, fontSize: 15, color: C_ACCENT, breakLine: true, paraSpaceBefore: i === 0 ? 0 : 14, paraSpaceAfter: 4 },
            });
          } else if (line.type === "b") {
            textRuns.push({
              text: line.text,
              options: { bullet: { code: "2022" }, breakLine: !isLast, paraSpaceAfter: 8 },
            });
          } else {
            textRuns.push({
              text: line.text,
              options: { fontSize: 13, color: C_INK, breakLine: !isLast, paraSpaceAfter: 8 },
            });
          }
        });

        s.addShape(pptx.shapes.RECTANGLE, {
          x: MARGIN, y: 1.55, w: CONTENT_W, h: 5.35, fill: { color: C_PAPER }, line: { color: C_LINE, width: 1 },
        });
        s.addText(textRuns, {
          x: MARGIN + 0.35, y: 1.8, w: CONTENT_W - 0.7, h: 4.9, fontFace: "IBM Plex Sans",
          valign: "top", isTextBox: true, lineSpacing: 20,
        });

        addFooter(s, `5.${idx + 1}`);
      });
    }

    const cleanMetric = (state.metric || "Report").replace(/[^a-zA-Z0-9]/g, "_");
    const fileName = `Analytics_Report_${cleanMetric}_${new Date().toISOString().slice(0, 10)}.pptx`;
    await pptx.writeFile({ fileName });
    toast(`✅ PowerPoint presentation (${fileName}) generated successfully!`);
  } catch (err) {
    console.error("PowerPoint export error:", err);
    toast(`❌ Error generating PowerPoint: ${err.message}`);
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = "📊 Export to PowerPoint (.pptx)";
  }
}

document.getElementById("export-pptx-btn").addEventListener("click", exportToPowerPoint);