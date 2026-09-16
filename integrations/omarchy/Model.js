// Pure data shaping for the Omarchy widget. Keep this file free of QML globals
// so its parsing and status rules can run under Node in CI.

function cleanText(value, maxLength) {
  var text = value === undefined || value === null ? "" : String(value)
  text = text.replace(/[\t\r]/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
  var limit = Number(maxLength) || 512
  return text.length <= limit ? text : text.slice(0, limit - 1) + "…"
}

function finiteNumber(value) {
  var number = Number(value)
  return isFinite(number) && number >= 0 ? number : 0
}

function normalizeRun(raw) {
  if (!raw || typeof raw !== "object") return null
  var runId = cleanText(raw.runId, 128).trim()
  if (runId === "") return null
  return {
    runId: runId,
    status: cleanText(raw.status || "unknown", 32),
    health: cleanText(raw.health || "healthy", 32),
    integrity: cleanText(raw.integrity || "missing", 32),
    iteration: Math.floor(finiteNumber(raw.iteration)),
    tokens: Math.floor(finiteNumber(raw.tokens)),
    usd: finiteNumber(raw.usd),
    wakeAt: finiteNumber(raw.wakeAt),
    pendingCap: cleanText(raw.pendingCap, 160),
    updatedAt: finiteNumber(raw.updatedAt)
  }
}

function normalizeLoop(raw) {
  if (!raw || typeof raw !== "object") return null
  var id = cleanText(raw.id, 128).trim()
  if (id === "") return null
  var sourceRuns = Array.isArray(raw.runs) ? raw.runs : []
  var runs = []
  for (var i = 0; i < sourceRuns.length && i < 8; i++) {
    var run = normalizeRun(sourceRuns[i])
    if (run) runs.push(run)
  }
  var latest = normalizeRun(raw.latestRun) || (runs.length > 0 ? runs[0] : null)
  var active = raw.active && typeof raw.active === "object" ? {
    runId: cleanText(raw.active.runId, 128),
    action: cleanText(raw.active.action, 32),
    startedAt: finiteNumber(raw.active.startedAt)
  } : null
  return {
    id: id,
    schedulerAuthority: cleanText(raw.schedulerAuthority || "host", 16),
    status: cleanText(raw.status || (latest ? latest.status : "idle"), 32),
    health: cleanText(raw.health || (latest ? latest.health : "healthy"), 32),
    active: active,
    nextDueAt: finiteNumber(raw.nextDueAt),
    lastOutcome: cleanText(raw.lastOutcome, 32),
    latestRun: latest,
    runs: runs
  }
}

function parseSnapshot(raw) {
  try {
    var parsed = JSON.parse(String(raw || ""))
    if (!parsed || !Array.isArray(parsed.loops))
      return { ok: false, error: "loopyd returned an unsupported snapshot.", loops: [] }
    var loops = []
    for (var i = 0; i < parsed.loops.length && i < 64; i++) {
      var loop = normalizeLoop(parsed.loops[i])
      if (loop) loops.push(loop)
    }
    return { ok: true, error: "", loops: loops }
  } catch (error) {
    return { ok: false, error: "loopyd returned invalid JSON.", loops: [] }
  }
}

function selectedIndex(loops, selectedId) {
  var list = Array.isArray(loops) ? loops : []
  for (var i = 0; i < list.length; i++) if (list[i].id === selectedId) return i
  return list.length > 0 ? 0 : -1
}

function hasAttention(loop) {
  if (!loop) return false
  if (loop.health === "attention" || loop.health === "error") return true
  if (["failed", "uncertain", "paused"].indexOf(loop.status) >= 0) return true
  return !!(loop.latestRun && loop.latestRun.pendingCap !== "")
}

function countActive(loops) {
  var count = 0
  for (var i = 0; i < loops.length; i++) if (loops[i].active) count++
  return count
}

function countAttention(loops) {
  var count = 0
  for (var i = 0; i < loops.length; i++) if (hasAttention(loops[i])) count++
  return count
}

function statusLabel(loop) {
  if (!loop) return "No loop selected"
  if (loop.active) return "Running " + loop.active.action + " · " + loop.active.runId
  if (!loop.latestRun) return "Installed · no runs yet"
  var text = loop.latestRun.status + " · iteration " + loop.latestRun.iteration
  if (loop.latestRun.pendingCap !== "") text += " · approval needed"
  return text
}

function runMetrics(loop) {
  if (!loop || !loop.latestRun) return "No recorded usage"
  var run = loop.latestRun
  return run.tokens + " tokens · $" + run.usd.toFixed(4) + " · " + run.integrity
}

function barLabel(loops, loading, error) {
  if (error !== "") return "L  !"
  if (loading && loops.length === 0) return "L  …"
  var attention = countAttention(loops)
  if (attention > 0) return "L  !" + attention
  var active = countActive(loops)
  return "L  " + (active > 0 ? active : loops.length)
}
