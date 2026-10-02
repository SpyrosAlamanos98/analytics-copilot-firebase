// report-engine.js
// Direct JS port of the original Streamlit app's pandas logic. Runs entirely
// in the browser: parses rows already extracted by SheetJS/PapaParse, so
// there's no pandas here — just plain arrays/objects.

// ---------------------------------------------------------------------------
// Formatting helpers (Greek-style numbers: 1.234,56)
// ---------------------------------------------------------------------------
export function fmtInt(n) {
  return Math.round(n).toLocaleString("el-GR");
}
export function fmtPct(p) {
  return `${p.toFixed(1).replace(".", ",")}%`;
}
export function fmtNum(n) {
  return Number(n).toLocaleString("el-GR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function severityForPct(pct) {
  if (pct >= 20) return { emoji: "🔴", level: "Critical", rank: 3 };
  if (pct >= 5) return { emoji: "🟡", level: "Warning", rank: 2 };
  return { emoji: "🔵", level: "Informational", rank: 1 };
}

const MARKER_KEYWORDS = [
  "geography", "product", "item", "time", "market", "brand", "category",
  "manufacturer", "sku", "upc", "ean", "description", "sub-category", "segment",
  "γεωγραφια", "προϊον", "προιον", "αγορα", "κατηγορια", "μαρκα"
];
const NUMERIC_KEYWORDS = ["sales", "change", "%", "volume", "units", "share", "price"];
const CORE_COLUMNS = ["geography", "product", "item", "time", "market", "brand",
  "manufacturer", "sku", "upc", "description", "category"];
export const ID_COLUMN_CANDIDATES = ["product", "item", "brand", "manufacturer",
  "sku", "upc", "description", "item description", "product description", "product name", "category"];

// Column-name fragments that mean "this is an identifier/code, never treat
// its digits as a metric" — even though the values themselves are numeric
// (e.g. a UPC like "0899962000061" passes any numeric-looking check).
const ID_LIKE_KEYWORDS = ["upc", "gtin", "ean", "sku", "barcode", "bar code",
  "zip", "postal", "digit", "code", " id", "id ", "identifier"];

function looksLikeIdColumn(colName) {
  const lower = ` ${colName.toLowerCase()} `; // pad so " id " matches at edges too
  return ID_LIKE_KEYWORDS.some((k) => lower.includes(k));
}

function isEmptyCell(v) {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

// ---------------------------------------------------------------------------
// Robust parser for Circana / Nielsen-style exports
// rawRows: array of arrays (as returned by SheetJS/PapaParse with header:1)
// Returns: { columns: [...], numericColumns: [...], rows: [{col: val, ...}] }
// ---------------------------------------------------------------------------
export function cleanCircanaReport(rawRows, filename) {
  let headerRowIdx = -1;
  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i] || [];
    const values = row.map((v) => String(v ?? "").trim().toLowerCase());
    const nonEmptyCount = values.filter((v) => v !== "" && v !== "nan").length;
    if (nonEmptyCount < 2) continue;

    // A header row contains column titles — it must NOT be a data row with sales/metrics numbers
    const hasDataNumbers = row.some((v) => {
      if (typeof v === "number" && !Number.isInteger(v)) return true;
      const s = String(v ?? "").replace(/,/g, "").trim();
      return /^-?\d+\.\d+$/.test(s) || /^-?\d{5,}$/.test(s);
    });
    if (hasDataNumbers) continue;

    if (values.some((v) => MARKER_KEYWORDS.some((kw) => v === kw || v.includes(kw)))) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) {
    throw new Error(`Header row not found in '${filename}'. Please check if the file format is valid.`);
  }

  const headers = rawRows[headerRowIdx] || [];

  // Try to grab a "period" label row just above the header (e.g. "This
  // Period" / "Year Ago") to make duplicate columns human-readable.
  let periodLabels = null;
  if (headerRowIdx > 0) {
    const candidate = (rawRows[headerRowIdx - 1] || []).map((v) => String(v ?? "").trim());
    const nonEmptyCount = candidate.filter((v) => v !== "" && v.toLowerCase() !== "nan").length;
    if (nonEmptyCount >= 2) {
      // forward-fill
      let last = "";
      periodLabels = candidate.map((v) => {
        if (v !== "" && v.toLowerCase() !== "nan") last = v;
        return last;
      });
    }
  }

  const bodyRows = rawRows.slice(headerRowIdx + 1);

  // Make duplicate column names unique
  const seen = {};
  const newCols = [];
  headers.forEach((raw, pos) => {
    let col = String(raw ?? "").trim();
    const isBlank = (col === "" || col.toLowerCase() === "nan");
    const label = periodLabels && pos < periodLabels.length ? periodLabels[pos].trim() : "";

    if (isBlank) {
      // If the header cell is empty, adopt the parent/metric label from the row above
      col = label || "Unnamed";
    }

    if (seen[col] !== undefined) {
      seen[col] += 1;
      if (isBlank) {
        newCols.push(`${col} (${seen[col] + 1})`);
      } else {
        newCols.push(label ? `${col} (${label})` : `${col} (version ${seen[col] + 1})`);
      }
    } else {
      seen[col] = 0;
      newCols.push(col);
    }
  });

  // Build row objects, dropping fully-empty columns and rows
  const colIsNumeric = newCols.map((c) => NUMERIC_KEYWORDS.some((k) => c.toLowerCase().includes(k)));

  let objRows = bodyRows.map((r) => {
    const obj = {};
    newCols.forEach((col, i) => { obj[col] = r[i] !== undefined ? r[i] : null; });
    return obj;
  });

  // Drop fully-empty columns
  const keepCols = newCols.filter((col) => objRows.some((r) => !isEmptyCell(r[col])));
  // Drop fully-empty rows
  objRows = objRows.filter((r) => keepCols.some((col) => !isEmptyCell(r[col])));

  const numericColumns = [];
  keepCols.forEach((col) => {
    const idx = newCols.indexOf(col);
    if (colIsNumeric[idx]) numericColumns.push(col);
  });

  // Coerce numeric-looking columns
  objRows.forEach((r) => {
    numericColumns.forEach((col) => {
      let v = r[col];
      if (v === null || v === undefined) { r[col] = null; return; }
      if (typeof v === "number") return; // already numeric (SheetJS often gives numbers)
      v = String(v).replace(/,/g, "").replace(/%/g, "").trim();
      const n = parseFloat(v);
      r[col] = Number.isNaN(n) ? null : n;
    });
  });

  return { columns: keepCols, numericColumns, rows: objRows };
}

// ---------------------------------------------------------------------------
// Data Quality (QC) checks
// ---------------------------------------------------------------------------
export function runQcChecks(parsed, name) {
  const { columns, numericColumns, rows } = parsed;
  const nRows = rows.length;
  const issuesTable = [];

  const isCoreOrMetric = (col) => {
    if (numericColumns.includes(col)) return true;
    const lower = col.toLowerCase();
    return CORE_COLUMNS.some((core) => lower.includes(core));
  };

  const addIssue = (category, column, count, maxRank = null) => {
    if (count <= 0 || nRows === 0) return;
    const pct = (count / nRows) * 100;
    let sev = severityForPct(pct);
    if (maxRank !== null && sev.rank > maxRank) {
      const table = {
        1: { emoji: "🔵", level: "Informational", rank: 1 },
        2: { emoji: "🟡", level: "Warning", rank: 2 },
        3: { emoji: "🔴", level: "Critical", rank: 3 }
      };
      sev = table[maxRank];
    }
    issuesTable.push({ category, column: String(column), count, pct, ...sev });
  };

  // 1. Missing values per column
  columns.forEach((col) => {
    const missing = rows.filter((r) => isEmptyCell(r[col])).length;
    if (missing > 0) {
      const cap = isCoreOrMetric(col) ? null : 1;
      addIssue("Missing values", col, missing, cap);
    }
  });

  // 2. Duplicate rows
  const seenRows = new Set();
  let dupCount = 0;
  rows.forEach((r) => {
    const key = JSON.stringify(columns.map((c) => r[c]));
    if (seenRows.has(key)) dupCount += 1;
    else seenRows.add(key);
  });
  if (dupCount > 0) addIssue("Duplicate rows", "— whole row —", dupCount);

  // Common change/growth identifiers (negative values in these are normal business trends, not corruption)
  const CHANGE_KEYWORDS = ["change", "chg", "%", "cya", "ya", "vs", "diff", "growth", "var", "pt", "share pt"];

  // 3. Negative values in absolute sales/volume/units/price columns
  numericColumns.forEach((col) => {
    const lower = col.toLowerCase();
    const isChangeCol = CHANGE_KEYWORDS.some((k) => lower.includes(k));
    if (["sales", "volume", "units", "price"].some((k) => lower.includes(k)) && !isChangeCol) {
      const negCount = rows.filter((r) => typeof r[col] === "number" && r[col] < 0).length;
      addIssue("Negative values", col, negCount);
    }
  });

  // 4. Zero values in main sales columns (excluding change metrics)
  numericColumns.forEach((col) => {
    const lower = col.toLowerCase();
    const isChangeCol = CHANGE_KEYWORDS.some((k) => lower.includes(k));
    if (lower.includes("sales") && !isChangeCol) {
      const zeroCount = rows.filter((r) => r[col] === 0).length;
      addIssue("Zero values", col, zeroCount);
    }
  });

  // 5. Simple outlier check (> 5x mean) on sales columns (excluding change metrics)
  numericColumns.forEach((col) => {
    const lower = col.toLowerCase();
    const isChangeCol = CHANGE_KEYWORDS.some((k) => lower.includes(k));
    if (lower.includes("sales") && !isChangeCol) {
      const series = rows.map((r) => r[col]).filter((v) => typeof v === "number");
      if (series.length > 3) {
        const mean = series.reduce((a, b) => a + b, 0) / series.length;
        if (mean !== 0) {
          const threshold = mean * 5;
          const outlierCount = series.filter((v) => v > threshold).length;
          addIssue("Potential outliers (>5x mean)", col, outlierCount);
        }
      }
    }
  });

  issuesTable.sort((a, b) => (b.rank - a.rank) || (b.pct - a.pct));

  const penalty = issuesTable.reduce((sum, i) => sum + Math.min(i.pct, 25) * (i.rank / 3), 0);
  const score = Math.max(0, Math.round(100 - penalty));

  const categories = [...new Set(issuesTable.map((i) => i.category))].sort();
  const issuesText = categories.map((cat) => {
    const items = issuesTable.filter((i) => i.category === cat);
    const details = items.map((i) => `${i.column}: ${i.count} (${fmtPct(i.pct)})`).join(", ");
    return `${cat}: ${details}`;
  });

  return {
    name, rows: nRows, columns: columns.length,
    issuesTable, issuesText, duplicateRows: dupCount, score,
    isClean: issuesTable.length === 0,
  };
}

export function buildQcContext(qcResults) {
  const parts = [];
  qcResults.forEach((r) => {
    parts.push(`### QC — ${r.name} (score: ${r.score}/100)`);
    parts.push(`Rows: ${r.rows}, Columns: ${r.columns}`);
    if (r.isClean) {
      parts.push("No quality issues detected.");
    } else {
      r.issuesText.forEach((t) => parts.push(`- ${t}`));
    }
    parts.push("");
  });
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Identifier column detection + trend / movers
// ---------------------------------------------------------------------------
export function findIdColumn(parsed) {
  const { columns, numericColumns, rows } = parsed;
  const candidates = columns.filter((c) => ID_COLUMN_CANDIDATES.includes(c.trim().toLowerCase()));
  if (candidates.length) {
    candidates.sort((a, b) =>
      ID_COLUMN_CANDIDATES.indexOf(a.trim().toLowerCase()) - ID_COLUMN_CANDIDATES.indexOf(b.trim().toLowerCase()));
    return candidates[0];
  }
  const textCols = columns.filter((c) => !numericColumns.includes(c));
  const eligible = textCols.filter((c) => {
    const lower = c.trim().toLowerCase();
    if (["geography", "time", "market", "measure"].includes(lower)) return false;
    const distinct = new Set(rows.map((r) => r[c]));
    return distinct.size > 5;
  });
  return eligible.length ? eligible[0] : null;
}

// Rank + dedupe rows for the movers table. Real-world exports sometimes
// contain literal duplicate rows for the same product (same id AND same
// metric value) — without this, "Top Growing" / "Largest Declines" show the
// same product twice in a row. We only collapse EXACT id+value repeats, so
// two genuinely different rows for the same product (e.g. different SKUs of
// one brand) are still both shown.
function dedupeForMovers(rows, idCol, metric) {
  const seen = new Set();
  const out = [];
  rows.forEach((r) => {
    const key = `${r[idCol]}||${r[metric]}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  });
  return out;
}

export function computeTrendAndMovers(reportsMap, fileOrder, metric, topN = 10) {
  const trend = [];
  fileOrder.forEach((name) => {
    const parsed = reportsMap[name];
    if (!parsed.columns.includes(metric)) return;
    const total = parsed.rows.reduce((sum, r) => sum + (typeof r[metric] === "number" ? r[metric] : 0), 0);
    trend.push({ file: name, value: total });
  });

  const firstParsed = reportsMap[fileOrder[0]];
  const idCol = findIdColumn(firstParsed);

  let moversTop = null;
  let moversBottom = null;
  const latestName = fileOrder[fileOrder.length - 1];
  const latestParsed = reportsMap[latestName];

  if (idCol && latestParsed.columns.includes(idCol) && latestParsed.columns.includes(metric)) {
    const candidateRows = latestParsed.rows
      .filter((r) => r[idCol] != null && typeof r[metric] === "number")
      .map((r) => ({ [idCol]: r[idCol], [metric]: r[metric] }));
    const deduped = dedupeForMovers(candidateRows, idCol, metric);
    const ranked = deduped.sort((a, b) => b[metric] - a[metric]);
    moversTop = ranked.slice(0, topN);
    moversBottom = ranked.slice(-topN).sort((a, b) => a[metric] - b[metric]);
  }

  let pctChange = null;
  if (trend.length >= 2) {
    pctChange = trend[0].value !== 0 ? ((trend[trend.length - 1].value - trend[0].value) / trend[0].value) * 100 : 0;
  }

  return { trend, pctChange, idColumn: idCol, moversTop, moversBottom };
}

// ---------------------------------------------------------------------------
// Free, local "Ask Your Data" answer engine (no AI, keyword-based)
// ---------------------------------------------------------------------------
export function getLocalAnswer(prompt, reportsMap, fileNames, idCol, metric, qcResults) {
  const text = prompt.toLowerCase().trim();
  const latest = reportsMap[fileNames[fileNames.length - 1]];

  const qcStems = ["qc", "ποιοτητ", "quality", "missing", "κενε", "διπλοτυπ", "duplicate", "outlier", "αξιοπιστ", "καθαρ"];
  if (qcResults && qcStems.some((k) => text.includes(k))) {
    const lines = ["**🧪 Data Quality Summary**"];
    qcResults.forEach((r) => {
      if (r.isClean) {
        lines.push(`\n✅ **${r.name}** — καμία ανωμαλία εντοπίστηκε (score: ${r.score}/100).`);
      } else {
        lines.push(`\n⚠️ **${r.name}** (score: ${r.score}/100):`);
        r.issuesText.forEach((t) => lines.push(`- ${t}`));
      }
    });
    return lines.join("\n");
  }

  let topN = 5;
  const nMatch = text.match(/top\s*(\d+)|(\d+)\s*(κορυφαι|top)/);
  if (nMatch) {
    const num = nMatch[1] || nMatch[2];
    if (num) topN = parseInt(num, 10);
  }

  if (!idCol || !latest.columns.includes(metric)) {
    return "Δεν έχω αρκετές πληροφορίες (λείπει στήλη Product/Brand/Manufacturer ή το επιλεγμένο KPI δεν υπάρχει στο τελευταίο report). Δοκίμασε να αλλάξεις το KPI.";
  }

  const ranked = latest.rows
    .filter((r) => r[idCol] != null && typeof r[metric] === "number")
    .map((r) => ({ [idCol]: r[idCol], [metric]: r[metric] }))
    .sort((a, b) => b[metric] - a[metric]);

  const growthStems = ["top", "growing", "αυξησ", "αυξηθ", "κορυφαι", "καλυτερ", "μεγαλυτερ"];
  const declineStems = ["πτωσ", "declin", "χειροτερ", "μειωσ", "μειωθ"];
  if (growthStems.some((k) => text.includes(k)) && !declineStems.some((k) => text.includes(k))) {
    const lines = [`**Top ${topN} — ${metric}** (από: ${fileNames[fileNames.length - 1]})`];
    ranked.slice(0, topN).forEach((r) => lines.push(`- ${r[idCol]}: ${fmtNum(r[metric])}`));
    return lines.join("\n");
  }

  if ([...declineStems, "worst", "drop"].some((k) => text.includes(k))) {
    const bottom = ranked.slice(-topN).sort((a, b) => a[metric] - b[metric]);
    const lines = [`**Largest declines — ${metric}** (από: ${fileNames[fileNames.length - 1]})`];
    bottom.forEach((r) => lines.push(`- ${r[idCol]}: ${fmtNum(r[metric])}`));
    return lines.join("\n");
  }

  const trendStems = ["trend", "change", "ταση", "τασ", "αλλαγ", "αλλαξ", "αυξηθ", "αυξησ", "μειωθ", "μειωσ", "διαφορ", "ποσο"];
  if (trendStems.some((k) => text.includes(k))) {
    const totals = fileNames
      .filter((n) => reportsMap[n].columns.includes(metric))
      .map((n) => ({ name: n, value: reportsMap[n].rows.reduce((s, r) => s + (typeof r[metric] === "number" ? r[metric] : 0), 0) }));
    if (totals.length < 2) return "Χρειάζομαι τουλάχιστον 2 reports με αυτό το KPI για να δείξω trend.";
    const firstVal = totals[0].value;
    const lastVal = totals[totals.length - 1].value;
    const pct = firstVal ? ((lastVal - firstVal) / firstVal) * 100 : 0;
    const direction = pct > 0 ? "αυξήθηκε" : pct < 0 ? "μειώθηκε" : "έμεινε σταθερό";
    const lines = [`**${metric} trend**`];
    totals.forEach((t) => lines.push(`- ${t.name}: ${fmtNum(t.value)}`));
    lines.push(`\nΣυνολικά ${direction} κατά ${fmtPct(Math.abs(pct))} από το πρώτο στο τελευταίο report.`);
    return lines.join("\n");
  }

  if (["columns", "στηλες", "στήλες", "fields", "πεδια"].some((k) => text.includes(k))) {
    return `Οι στήλες στο '${fileNames[fileNames.length - 1]}' είναι:\n\n${latest.columns.join(", ")}`;
  }

  const matches = latest.rows.filter((r) => {
    const v = String(r[idCol] ?? "").toLowerCase();
    return v && (text.includes(v) || text.includes(v.slice(0, 15)));
  });
  if (matches.length) {
    const lines = [`Βρήκα ${matches.length} αποτέλεσμα(τα):`];
    matches.slice(0, topN).forEach((r) => lines.push(`- ${r[idCol]}: ${metric} = ${r[metric] ?? "N/A"}`));
    return lines.join("\n");
  }

  return "Δεν κατάλαβα ακριβώς την ερώτηση 🙂 Μπορώ να απαντήσω σε πράγματα όπως:\n"
    + "- \"top 10 growing\"\n- \"largest declines\"\n- \"trend\"\n- \"columns\"\n- \"data quality\"\n\n"
    + "(Δωρεάν, τοπικό chatbox — χωρίς AI model.)";
}

// ---------------------------------------------------------------------------
// Context builder for Gemini calls
// ---------------------------------------------------------------------------
export function buildDataContext(reportsMap, fileNames, maxRowsPerReport = 15) {
  const parts = [];
  fileNames.forEach((name) => {
    const parsed = reportsMap[name];
    parts.push(`### Report: ${name}`);
    parts.push(`Columns: ${parsed.columns.join(", ")}`);
    parts.push(`Rows: ${parsed.rows.length}`);

    if (parsed.numericColumns.length) {
      const totals = parsed.numericColumns.map((col) => {
        const sum = parsed.rows.reduce((s, r) => s + (typeof r[col] === "number" ? r[col] : 0), 0);
        return `${col}=${sum.toFixed(2)}`;
      });
      parts.push("Column totals: " + totals.join(", "));
    }

    const sample = parsed.rows.slice(0, maxRowsPerReport);
    const header = parsed.columns.join(",");
    const sampleLines = sample.map((r) => parsed.columns.map((c) => r[c] ?? "").join(","));
    parts.push("Sample rows:\n" + [header, ...sampleLines].join("\n"));
    parts.push("");
  });
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Auto-detect numeric columns by VALUE, not just by column name.
// cleanCircanaReport only flags a column numeric if its name matches a
// keyword like "sales" or "%". Files that don't follow Circana's naming
// convention (e.g. custom dashboards) got zero numeric columns even when
// full of numbers. This scans every column's actual values and adds any
// column that's mostly numeric, regardless of what it's called — EXCEPT
// identifier-style columns (UPC, SKU, barcode, zip, "...id", "...code"),
// which are excluded even when every value is digits, since they're codes,
// not metrics that should ever be summed or charted.
// ---------------------------------------------------------------------------
export function autoDetectNumericColumns(parsed) {
  const { columns, rows } = parsed;
  const numericColumns = new Set(parsed.numericColumns);

  const looksNumeric = (v) => {
    if (typeof v === "number") return true;
    const cleaned = String(v).replace(/,/g, "").replace(/%/g, "").trim();
    return cleaned !== "" && /^-?\d+(\.\d+)?$/.test(cleaned);
  };

  columns.forEach((col) => {
    if (numericColumns.has(col)) return;
    if (looksLikeIdColumn(col)) return; // never auto-promote UPC/SKU/etc. to a metric
    if (/^-?\d+(\.\d+)?$/.test(String(col).trim())) return; // raw numbers are not valid metric names
    let numericCount = 0;
    let nonNullCount = 0;
    rows.forEach((r) => {
      const v = r[col];
      if (v === null || v === undefined || v === "") return;
      nonNullCount += 1;
      if (looksNumeric(v)) numericCount += 1;
    });
    // Require a handful of samples and a clear numeric majority before
    // committing — avoids miscalling an ID column like "SKU 100234" numeric.
    if (nonNullCount >= 3 && numericCount / nonNullCount >= 0.8) {
      numericColumns.add(col);
      rows.forEach((r) => {
        const v = r[col];
        if (v === null || v === undefined || v === "" || typeof v === "number") return;
        const cleaned = String(v).replace(/,/g, "").replace(/%/g, "").trim();
        const n = parseFloat(cleaned);
        r[col] = Number.isNaN(n) ? null : n;
      });
    }
  });

  parsed.numericColumns = Array.from(numericColumns);
  return parsed;
}