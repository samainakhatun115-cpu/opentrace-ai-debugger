import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 3000);
const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const model = process.env.OLLAMA_MODEL || "llama3.2:3b";

const systemPrompt = `You are OpenTrace, a careful debugging assistant.
Analyze the supplied log without inventing facts. Return valid JSON with exactly these keys:
summary (string), severity (one of "critical", "high", "medium", "low", "unknown"),
rootCause (string), actions (array of 3 to 5 short strings), evidence (array of 2 to 4 strings),
questions (array of 0 to 3 strings), safetyNote (string).
Separate evidence from hypotheses. If the log is incomplete, say what is missing.
Never suggest deleting data, disabling security controls, or exposing secrets.`;

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function askOllama(log) {
  const result = await fetch(`${ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      prompt: `Analyze this log:\n\n${log}`,
      stream: false,
      format: "json",
      options: { temperature: 0.2 }
    }),
    signal: AbortSignal.timeout(45_000)
  });
  if (!result.ok) throw new Error(`Ollama returned HTTP ${result.status}`);
  const payload = await result.json();
  return JSON.parse(payload.response);
}

function demoAnalysis(log) {
  const lower = log.toLowerCase();
  const database = lower.includes("database") || lower.includes("postgres") || lower.includes("sql");
  return {
    summary: "The log shows a failed operation that needs a narrower reproduction and one confirmed dependency check.",
    severity: lower.includes("fatal") || lower.includes("panic") ? "high" : "medium",
    rootCause: database
      ? "A database dependency appears to be involved, but the log does not include enough context to distinguish connectivity, authentication, and query failures."
      : "The available log identifies a failure but does not contain enough context to confirm the underlying cause.",
    actions: [
      "Reproduce the failure with a timestamp and correlation ID recorded.",
      "Check the first error in the chain, not only the final stack trace.",
      "Compare the failing configuration with the last known working version.",
      "Capture the service version, environment, and request identifier."
    ],
    evidence: ["The supplied text contains an error signal.", "No complete request context or environment details were provided."],
    questions: ["What changed immediately before the failure?", "Does the same input fail in a local or staging environment?"],
    safetyNote: "Demo mode is heuristic. Do not apply a suggested change to production without validating it."
  };
}

async function handleAnalyze(request, response) {
  let body = "";
  for await (const chunk of request) body += chunk;
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return sendJson(response, 400, { error: "Request body must be valid JSON." });
  }
  const log = typeof input.log === "string" ? input.log.trim() : "";
  if (!log) return sendJson(response, 400, { error: "Paste a log or error message first." });
  if (log.length > 12_000) return sendJson(response, 413, { error: "Keep the log under 12,000 characters." });

  try {
    const analysis = await askOllama(log);
    return sendJson(response, 200, { analysis, mode: "ollama", model });
  } catch (error) {
    console.warn(`Ollama unavailable: ${error.message}`);
    return sendJson(response, 200, { analysis: demoAnalysis(log), mode: "demo", model });
  }
}

async function serveStatic(request, response) {
  const requested = request.url === "/" ? "/index.html" : request.url.split("?")[0];
  const file = normalize(join(publicDir, requested));
  if (!file.startsWith(publicDir)) return sendJson(response, 403, { error: "Forbidden." });
  try {
    const content = await readFile(file);
    const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
    response.writeHead(200, { "Content-Type": `${types[extname(file)] || "application/octet-stream"}; charset=utf-8` });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "Not found." });
  }
}

createServer((request, response) => {
  if (request.method === "POST" && request.url === "/api/analyze") return handleAnalyze(request, response);
  if (request.method === "GET") return serveStatic(request, response);
  sendJson(response, 405, { error: "Method not allowed." });
}).listen(port, () => console.log(`OpenTrace running at http://localhost:${port}`));
