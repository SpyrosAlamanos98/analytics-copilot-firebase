// gemini.js
// Calls the Gemini API directly from the browser using the user's own key.
// NOTE (Spark trade-off): because there's no backend, the API key is visible
// in DevTools/network tab while a request is in flight. Acceptable for an
// internal team tool with trusted users; not appropriate for a public app.

import { buildDataContext, buildQcContext, fmtNum, fmtPct } from "./report-engine.js";

const MODEL = "gemini-3.6-flash";

// ---------------------------------------------------------------------------
// Non-streaming call — used for Executive Summary
// ---------------------------------------------------------------------------
async function callGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) throw new Error("Empty response from the Gemini API.");
  return text;
}

// ---------------------------------------------------------------------------
// Streaming call — used for Chat (token-by-token updates via onChunk callback)
// ---------------------------------------------------------------------------
async function callGeminiStream(apiKey, prompt, onChunk) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE lines: "data: {...}"
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;
      try {
        const parsed = JSON.parse(jsonStr);
        const chunk = parsed?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
        if (chunk) {
          fullText += chunk;
          onChunk(fullText);
        }
      } catch {
        // skip malformed SSE chunks
      }
    }
  }

  if (!fullText) throw new Error("Empty response from the Gemini API.");
  return fullText;
}

// ---------------------------------------------------------------------------
// Chat answer — streams tokens into a DOM element via onChunk
// ---------------------------------------------------------------------------
export async function getGeminiAnswer(prompt, reportsMap, fileNames, apiKey, qcResults, onChunk) {
  try {
    const context = buildDataContext(reportsMap, fileNames);
    const qcContext = buildQcContext(qcResults);

    const systemInstructions = "You are a sales data analysis assistant specialising in retail/CPG reports. "
      + "Answer ONLY based on the data and QC findings provided below. "
      + "If something is not visible in the data, state it clearly instead of making it up. "
      + "Always respond in formal English, concisely and with numbers wherever possible.";

    const fullPrompt = `${systemInstructions}\n\n--- DATA ---\n${context}\n--- END OF DATA ---\n\n`
      + `--- QC RESULTS ---\n${qcContext}\n--- END QC ---\n\nUser question: ${prompt}`;

    if (onChunk) {
      return await callGeminiStream(apiKey, fullPrompt, onChunk);
    }
    return await callGemini(apiKey, fullPrompt);
  } catch (err) {
    return `⚠️ Error calling the Gemini API: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Executive Summary — non-streaming (one-shot, rendered as markdown)
// ---------------------------------------------------------------------------
export async function getGeminiExecSummary(qcResults, metric, trendResult, apiKey) {
  try {
    const qcContext = buildQcContext(qcResults);
    const trendLines = trendResult.trend.map((t) => `- ${t.file}: ${fmtNum(t.value)}`).join("\n");
    const pctChange = trendResult.pctChange ?? 0;

    let moversText = "No identifiable product/brand column available for ranking.";
    if (trendResult.moversTop && trendResult.moversBottom) {
      const idCol = trendResult.idColumn;
      const topLines = trendResult.moversTop.map((r) => `- ${r[idCol]}: ${fmtNum(r[metric])}`).join("\n");
      const bottomLines = trendResult.moversBottom.map((r) => `- ${r[idCol]}: ${fmtNum(r[metric])}`).join("\n");
      moversText = `Top performers:\n${topLines}\n\nLargest declines:\n${bottomLines}`;
    }

    const systemInstructions = "You are a senior data analyst at a retail/CPG company writing an executive "
      + "summary for a manager who does not have time to read raw data. "
      + "Use ONLY the information provided below. "
      + "Write in formal English, concisely, in markdown, with EXACTLY these 4 sections (as ## headers): "
      + "'🔑 Key Findings', '📈 Opportunities', '⚠️ Risks', '✅ Recommendations'. "
      + "Each section should have 2-4 bullet points, specific and with numbers wherever possible. "
      + "If the QC findings show serious data quality issues, mention them under Risks.";

    const fullPrompt = `${systemInstructions}\n\n--- KPI: ${metric} ---\nTrend per report:\n${trendLines}\n`
      + `Overall change: ${fmtPct(pctChange)}\n\n--- TOP / BOTTOM MOVERS ---\n${moversText}\n\n`
      + `--- QC RESULTS ---\n${qcContext}\n--- END QC ---`;

    return await callGemini(apiKey, fullPrompt);
  } catch (err) {
    return `⚠️ Error generating the executive summary: ${err.message}`;
  }
}
