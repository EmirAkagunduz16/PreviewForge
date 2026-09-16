"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { parseSse } from "./sse";

type Project = {
  id: string;
  repositoryFullName: string;
  defaultBranch: string;
  dockerfilePath: string;
};
type Deployment = {
  id: string;
  attempt: number;
  commitSha: string;
  status: string;
  failureCode?: string | null;
  failureMessage?: string | null;
  imageDigest?: string | null;
  createdAt: string;
  updatedAt: string;
};
type Preview = {
  id: string;
  previewKey: string;
  desiredCommitSha: string;
  status: string;
  pullRequest?: { number: number; title: string };
  currentDeployment?: Deployment | null;
};
type Log = { sequence: number; stage: string; stream: string; text: string; createdAt: string };
type Key = { key: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: "include", ...init });
  if (!response.ok)
    throw new Error(response.status === 401 ? "AUTH_REQUIRED" : `REQUEST_${response.status}`);
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [keys, setKeys] = useState<Key[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [gap, setGap] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      const result = await api<{ items: Project[] }>("/projects");
      setProjects(result.items);
      setProject(
        (current) =>
          result.items.find((item) => item.id === current?.id) ?? result.items[0] ?? null,
      );
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message === "AUTH_REQUIRED"
          ? "Sign in to view your previews."
          : "Projects could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    void Promise.all([
      api<{ items: Preview[] }>(`/projects/${project.id}/previews`),
      api<{ items: Deployment[] }>(`/projects/${project.id}/deployments`),
      api<{ items: Key[] }>(`/projects/${project.id}/environment-variables`),
    ])
      .then(([p, d, k]) => {
        if (cancelled) return;
        setPreviews(p.items);
        setDeployments(d.items);
        setKeys(k.items);
        setDeployment(
          (current) => d.items.find((item) => item.id === current?.id) ?? d.items[0] ?? null,
        );
      })
      .catch(() => setError("Project details could not be loaded."));
    return () => {
      cancelled = true;
    };
  }, [project]);
  useEffect(() => {
    if (!deployment) return;
    const cacheKey = `previewforge-log-cache:${deployment.id}`;
    const cached = readLogCache(cacheKey);
    let cachedLogs = cached.logs;
    let lastCursor = cached.cursor;
    let currentGap = cached.gap;
    setLogs(cachedLogs);
    setGap(currentGap);
    const controller = new AbortController();
    const consume = async () => {
      let retryMs = 250;
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(`/api/deployments/${deployment.id}/events`, {
            headers: lastCursor ? { "Last-Event-ID": String(lastCursor) } : {},
            credentials: "include",
            signal: controller.signal,
          });
          if (response.status === 401) {
            setError("Sign in to view your previews.");
            return;
          }
          if (response.status === 404) {
            setError("Deployment is no longer available.");
            return;
          }
          if (!response.ok || !response.body) throw new Error("stream unavailable");
          retryMs = 250;
          setError((current) => (current.startsWith("Live logs") ? "" : current));
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          while (!controller.signal.aborted) {
            const next = await reader.read();
            if (next.done) break;
            buffer += next.value;
            const frames = buffer.split("\n\n");
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              const event = parseSse(frame);
              if (!event || event.event === "heartbeat") continue;
              if (event.event === "status")
                setDeployment((current) =>
                  current ? { ...current, ...JSON.parse(event.data) } : current,
                );
              if (event.event === "log") {
                const log = JSON.parse(event.data) as Log;
                lastCursor = log.sequence;
                cachedLogs = [...cachedLogs, log].slice(-500);
                writeLogCache(cacheKey, { cursor: lastCursor, logs: cachedLogs, gap: currentGap });
                setLogs(cachedLogs);
              }
              if (event.event === "gap") {
                const resume = (JSON.parse(event.data) as { resumeSequence: number })
                  .resumeSequence;
                lastCursor = Math.max(0, resume - 1);
                cachedLogs = [];
                currentGap = resume;
                writeLogCache(cacheKey, { cursor: lastCursor, logs: [], gap: resume });
                setLogs([]);
                setGap(resume);
              }
            }
          }
          if (!controller.signal.aborted) {
            setError("Live logs disconnected; reconnecting…");
            await new Promise((resolve) => window.setTimeout(resolve, retryMs));
            retryMs = Math.min(retryMs * 2, 5_000);
          }
        } catch {
          if (controller.signal.aborted) return;
          setError("Live logs disconnected; reconnecting…");
          await new Promise((resolve) => window.setTimeout(resolve, retryMs));
          retryMs = Math.min(retryMs * 2, 5_000);
        }
      }
    };
    void consume();
    return () => controller.abort();
  }, [deployment?.id]);
  const signOut = async () => {
    await fetch("/api/auth/github/logout", { method: "POST", credentials: "include" });
    window.location.reload();
  };
  const selected = useMemo(
    () => previews.find((item) => item.currentDeployment?.id === deployment?.id),
    [previews, deployment],
  );
  if (loading)
    return (
      <main className="shell">
        <p className="eyebrow">PREVIEWFORGE / M6</p>
        <h1>Loading your control plane…</h1>
        <div className="skeleton" />
      </main>
    );
  if (error === "Sign in to view your previews.")
    return (
      <main className="shell empty">
        <p className="eyebrow">PREVIEWFORGE / M6</p>
        <h1>Forge previews with confidence.</h1>
        <p>{error}</p>
        <a className="button" href="/api/auth/github/start">
          Sign in with GitHub
        </a>
      </main>
    );
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">PREVIEWFORGE / DASHBOARD</p>
          <h1>Live preview control plane</h1>
        </div>
        <button type="button" className="quiet" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      {error && <div className="alert">{error}</div>}
      {!projects.length ? (
        <section className="panel empty">
          <h2>No projects yet</h2>
          <p>Install the GitHub App and import a repository to see previews here.</p>
        </section>
      ) : (
        <div className="grid">
          <aside className="panel project-list">
            <div className="section-heading">
              <span>Projects</span>
              <span className="count">{projects.length}</span>
            </div>
            {projects.map((item) => (
              <button
                type="button"
                className={project?.id === item.id ? "project selected" : "project"}
                key={item.id}
                onClick={() => setProject(item)}
              >
                <strong>{item.repositoryFullName}</strong>
                <small>
                  {item.defaultBranch} · {item.dockerfilePath}
                </small>
              </button>
            ))}
          </aside>
          <section className="content">
            <section className="panel">
              <div className="section-heading">
                <span>{project?.repositoryFullName}</span>
                <span className="muted">{project?.defaultBranch}</span>
              </div>
              <div className="cards">
                {previews.map((item) => (
                  <button
                    type="button"
                    className={
                      selected?.id === item.currentDeployment?.id ? "preview selected" : "preview"
                    }
                    key={item.id}
                    onClick={() => item.currentDeployment && setDeployment(item.currentDeployment)}
                  >
                    <div>
                      <strong>PR #{item.pullRequest?.number ?? "—"}</strong>
                      <span className={`status ${item.status.toLowerCase()}`}>{item.status}</span>
                    </div>
                    <p>{item.pullRequest?.title ?? item.previewKey}</p>
                    <small>{item.desiredCommitSha.slice(0, 12)}</small>
                  </button>
                ))}
              </div>
              {!previews.length && <p className="muted">No active previews.</p>}
            </section>
            <div className="split">
              <section className="panel">
                <div className="section-heading">
                  <span>Deployment history</span>
                  <span className="count">{deployments.length}</span>
                </div>
                {deployments.map((item) => (
                  <button
                    type="button"
                    className={deployment?.id === item.id ? "history-row selected" : "history-row"}
                    key={item.id}
                    onClick={() => setDeployment(item)}
                  >
                    <span>
                      <strong>Attempt {item.attempt}</strong>
                      <small>{item.commitSha.slice(0, 12)}</small>
                    </span>
                    <span className={`status ${item.status.toLowerCase()}`}>{item.status}</span>
                  </button>
                ))}
              </section>
              <EnvironmentEditor projectId={project?.id ?? ""} keys={keys} setKeys={setKeys} />
            </div>
            {deployment && <Detail deployment={deployment} logs={logs} gap={gap} />}
          </section>
        </div>
      )}
    </main>
  );
}

function EnvironmentEditor({
  projectId,
  keys,
  setKeys,
}: {
  projectId: string;
  keys: Key[];
  setKeys: (keys: Key[]) => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [message, setMessage] = useState("");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api(`/projects/${projectId}/environment-variables/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      setValue("");
      setMessage(`${name} saved`);
      if (!keys.some((item) => item.key === name)) setKeys([...keys, { key: name }]);
    } catch {
      setMessage("Could not save key");
    }
  };
  const remove = async (key: string) => {
    try {
      await api(`/projects/${projectId}/environment-variables/${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      setKeys(keys.filter((item) => item.key !== key));
      setMessage(`${key} deleted`);
    } catch {
      setMessage("Could not delete key");
    }
  };
  return (
    <section className="panel env">
      <div className="section-heading">
        <span>Environment keys</span>
        <span className="muted">write-only</span>
      </div>
      <p className="muted">Values are encrypted and never returned.</p>
      <form onSubmit={(event) => void save(event)}>
        <input
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="KEY_NAME"
          aria-label="Environment key"
        />
        <input
          required
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="New value"
          type="password"
          aria-label="Environment value"
          autoComplete="off"
        />
        <button type="submit" className="button">
          Save
        </button>
      </form>
      {keys.map((item) => (
        <div className="key" key={item.key}>
          <code>{item.key}</code>
          <button type="button" className="danger" onClick={() => void remove(item.key)}>
            Delete
          </button>
        </div>
      ))}
      {message && <small className="muted">{message}</small>}
    </section>
  );
}

function Detail({
  deployment,
  logs,
  gap,
}: {
  deployment: Deployment;
  logs: Log[];
  gap: number | null;
}) {
  const stages = [
    "QUEUED",
    "CLONING",
    "BUILDING",
    "PUSHING",
    "DEPLOYING",
    "WAITING_FOR_HEALTHCHECK",
    "READY",
    "FAILED",
    "SUPERSEDED",
    "CANCELLED",
  ];
  return (
    <section className="panel detail">
      <div className="section-heading">
        <span>Deployment detail</span>
        <span className={`status ${deployment.status.toLowerCase()}`}>{deployment.status}</span>
      </div>
      <div className="stages">
        {stages.map((stage) => (
          <span className={stage === deployment.status ? "stage active" : "stage"} key={stage}>
            {stage.replaceAll("_", " ")}
          </span>
        ))}
      </div>
      {deployment.failureMessage && (
        <div className="failure">
          <strong>{deployment.failureCode ?? "Deployment failed"}</strong>
          <p>{deployment.failureMessage}</p>
        </div>
      )}
      {deployment.imageDigest && (
        <p className="muted">
          Immutable image: <code>{deployment.imageDigest}</code>
        </p>
      )}
      <div className="log-heading">
        <strong>Live logs</strong>
        {gap !== null && <span className="gap">Logs expired · reset at sequence {gap}</span>}
      </div>
      <pre className="logs">
        {logs.length ? (
          logs.map((item) => (
            <span key={item.sequence}>
              <b>{item.sequence}</b> {item.text}
            </span>
          ))
        ) : (
          <span className="muted">Waiting for durable output…</span>
        )}
      </pre>
    </section>
  );
}

type LogCache = { cursor: number; logs: Log[]; gap: number | null };

function readLogCache(key: string): LogCache {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null") as Partial<LogCache> | null;
    if (
      value &&
      typeof value.cursor === "number" &&
      Array.isArray(value.logs) &&
      value.logs.every((item) => item && typeof item.sequence === "number")
    ) {
      return {
        cursor: value.cursor,
        logs: value.logs as Log[],
        gap: typeof value.gap === "number" ? value.gap : null,
      };
    }
  } catch {
    // Ignore malformed or unavailable session storage and start from the live stream.
  }
  return { cursor: 0, logs: [], gap: null };
}

function writeLogCache(key: string, value: LogCache): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A full or disabled session storage must not stop log delivery.
  }
}
