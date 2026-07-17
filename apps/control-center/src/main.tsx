import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Status = "completed" | "waiting" | "paused" | "uncertain" | "stopped" | "failed" | "unknown";
interface Run {
  runId: string;
  status: Status;
  health: "healthy" | "attention" | "error";
  integrity: string;
  integrityDetail?: string;
  iteration: number;
  tokens: number;
  usd: number;
  state: Record<string, unknown>;
  updatedAt?: number;
  source: { events: string };
  timeline: Array<{ seq: number; ts: number; type: string; summary: string }>;
}
interface Loop {
  id: string;
  path: string;
  target: string;
  specHash: string;
  schedulerAuthority: string;
  hostScheduleDetected: boolean;
  operation?: { nextDueAt?: number; pendingDueAt?: number; active?: { runId: string; action: string; startedAt: number }; lastOutcome?: Status };
  artifacts?: { files: Array<{ path: string; size: number; mime: string; sha256: string; modifiedAt: number; localUrl: string }>; totalBytes: number; truncated: boolean; diagnostics: string[] };
  score?: number;
  grounding?: string;
  spec?: { signal?: string; caps?: Record<string, unknown>; schedule?: Record<string, unknown> };
  runs: Run[];
  source: { artifact: string; spec: string };
}

function badge(value: string): string {
  if (["completed", "healthy", "verified", "external"].includes(value)) return "good";
  if (["failed", "error", "corrupt", "truncated", "uncertain"].includes(value)) return "bad";
  return "warn";
}

function relativeTime(ts?: number): string {
  if (!ts) return "never";
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function App() {
  const [loops, setLoops] = useState<Loop[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [reason, setReason] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/loops", { credentials: "same-origin" });
      if (!response.ok) throw new Error(response.status === 401 ? "Open the tokenized URL printed by loopyd ui." : `API returned ${response.status}`);
      const payload = await response.json() as { loops: Loop[] };
      setLoops(payload.loops);
      setSelectedId((current) => current ?? payload.loops[0]?.id);
      setError(undefined);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const events = new EventSource("/api/v1/events", { withCredentials: true });
    events.addEventListener("snapshot", () => void refresh());
    return () => { window.clearInterval(timer); events.close(); };
  }, [refresh]);

  const selected = useMemo(() => loops.find((loop) => loop.id === selectedId), [loops, selectedId]);
  const run = selected?.runs.toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  const healthy = loops.filter((loop) => loop.runs.every((candidate) => candidate.health === "healthy")).length;
  const attention = loops.length - healthy;

  const mutate = useCallback(async (path: string, body: Record<string, unknown>, label: string) => {
    setBusy(label);
    try {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: "control-center", ...body }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `API returned ${response.status}`);
      setError(undefined);
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(undefined);
    }
  }, [refresh]);

  const dispatch = (action: "run" | "step") => selected && void mutate(`/api/v1/loops/${selected.id}/runs`, { action, reason: reason || undefined }, action);
  const control = (action: "pause" | "stop" | "resume" | "approve") => selected && run && void mutate(`/api/v1/loops/${selected.id}/runs/${run.runId}/actions`, { action, reason: reason || undefined }, action);
  const handoff = () => selected && void mutate(`/api/v1/loops/${selected.id}/handoff`, { to: selected.schedulerAuthority === "operator" ? "host" : "operator", reason }, "handoff");

  return <main>
    <header className="topbar">
      <a className="brand" href="/" aria-label="Homepage"><strong>Monkey D Loopy</strong><span>local control center</span></a>
      <div className="live"><span aria-hidden="true" /> loopback · live</div>
    </header>

    <section className="hero" aria-labelledby="overview-title">
      <div><p className="eyebrow">Operator overview</p><h1 id="overview-title">Loops that explain themselves.</h1><p>Runtime journals remain the source of truth. Every status links back to its local evidence.</p></div>
      <div className="metrics" aria-label="Loop summary">
        <div><b>{loops.length}</b><span>installed</span></div><div><b>{healthy}</b><span>healthy</span></div><div><b>{attention}</b><span>attention</span></div>
      </div>
    </section>

    {error && <div className="error" role="alert">{error}</div>}
    {loading ? <div className="empty">Reading verified journals…</div> : loops.length === 0 ? <div className="empty"><b>No loops installed.</b><span>Run <code>loopyd install ./out/my-loop/standalone</code> to add one without changing the artifact.</span></div> :
      <div className="workspace">
        <nav className="loop-list" aria-label="Installed loops">
          {loops.map((loop) => {
            const latest = loop.runs.toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
            return <button key={loop.id} className={selectedId === loop.id ? "loop-card selected" : "loop-card"} onClick={() => setSelectedId(loop.id)}>
              <span className="card-head"><b>{loop.id}</b><i className={badge(latest?.status ?? "unknown")}>{latest?.status ?? "not run"}</i></span>
              <span className="card-meta">{loop.grounding ?? "unknown"} grounding · score {loop.score ?? "—"}</span>
              <span className="card-foot"><span>{loop.schedulerAuthority} schedule</span><span>{relativeTime(latest?.updatedAt)}</span></span>
            </button>;
          })}
        </nav>

        {selected && <section className="detail" aria-live="polite">
          <div className="detail-head"><div><p className="eyebrow">{selected.target} artifact</p><h2>{selected.id}</h2></div><div className="badges"><span className={badge(selected.grounding ?? "")}>{selected.grounding ?? "unknown"} grounding</span><span>score {selected.score ?? "—"}</span></div></div>
          <dl className="facts">
            <div><dt>Termination</dt><dd>{selected.spec?.signal ?? "unknown"}</dd></div>
            <div><dt>Scheduler</dt><dd>{selected.schedulerAuthority}</dd></div>
            <div><dt>Spec hash</dt><dd><code>{selected.specHash.slice(0, 12)}</code></dd></div>
            <div><dt>Runs</dt><dd>{selected.runs.length}</dd></div>
          </dl>
          <section className="controls" aria-labelledby="controls-title">
            <div><h3 id="controls-title">Guarded controls</h3><p>{selected.operation?.active ? `${selected.operation.active.action} active · ${selected.operation.active.runId}` : selected.operation?.nextDueAt ? `next operator fire ${new Date(selected.operation.nextDueAt).toLocaleString()}` : "no active operator claim"}</p></div>
            <label><span>Reason for handoff or intervention</span><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. maintenance window" /></label>
            <div className="control-buttons">
              <button disabled={Boolean(busy || selected.operation?.active)} onClick={() => dispatch("run")}>Run</button>
              <button disabled={Boolean(busy || selected.operation?.active)} onClick={() => dispatch("step")}>Step</button>
              <button disabled={Boolean(busy || !run || !reason)} onClick={() => control("pause")}>Pause safely</button>
              <button disabled={Boolean(busy || !run || !reason)} onClick={() => control("stop")}>Stop safely</button>
              <button disabled={Boolean(busy || !run || selected.operation?.active)} onClick={() => control("resume")}>Resume</button>
              <button disabled={Boolean(busy || !run || selected.operation?.active)} onClick={() => control("approve")}>Approve &amp; resume</button>
              <button className="handoff" disabled={Boolean(busy || !reason || selected.operation?.active)} onClick={handoff}>Hand off to {selected.schedulerAuthority === "operator" ? "host" : "operator"}</button>
            </div>
            {busy && <p className="busy" role="status">Submitting {busy}…</p>}
          </section>
          <section className="products" aria-labelledby="products-title">
            <div><p className="eyebrow">Allowlisted output</p><h3 id="products-title">Artifacts</h3></div>
            {selected.artifacts?.files.length ? <ul>
              {selected.artifacts.files.map((artifact) => <li key={artifact.path}>
                <a href={artifact.localUrl}>{artifact.path}</a>
                <span>{artifact.mime.split(";")[0]} · {artifact.size.toLocaleString()} bytes · <code>{artifact.sha256.slice(0, 10)}</code></span>
              </li>)}
            </ul> : <p>No allowlisted products indexed yet.</p>}
            {selected.artifacts?.truncated && <div className="integrity" role="status">Artifact ceilings reached; the safe index is intentionally incomplete.</div>}
            {selected.artifacts?.diagnostics.length ? <details><summary>Artifact diagnostics ({selected.artifacts.diagnostics.length})</summary><ul className="diagnostics">{selected.artifacts.diagnostics.map((message) => <li key={message}>{message}</li>)}</ul></details> : null}
          </section>
          {run ? <>
            <div className="run-title"><div><h3>Latest run · {run.runId}</h3><p>{run.iteration} iterations · {run.tokens.toLocaleString()} tokens · ${run.usd.toFixed(4)}</p></div><div className="badges"><span className={badge(run.status)}>{run.status}</span><span className={badge(run.integrity)}>{run.integrity}</span></div></div>
            {run.integrityDetail && <div className="integrity" role="status">{run.integrityDetail}</div>}
            <ol className="timeline" role="list">
              {run.timeline.toReversed().slice(0, 12).map((event) => <li key={event.seq}><span className="dot" /><div><b>{event.summary}</b><small>#{event.seq} · {new Date(event.ts).toLocaleString()} · {event.type}</small></div></li>)}
            </ol>
            <details><summary>Current state</summary><pre>{JSON.stringify(run.state, null, 2)}</pre></details>
            <p className="source">Source of truth: <code>{run.source.events}</code></p>
          </> : <div className="empty compact">This loop has no journaled runs yet.</div>}
        </section>}
      </div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
