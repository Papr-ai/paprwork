/**
 * Plan A Turso replica E2E — run from Settings → Cloud Sync (dev builds only).
 */

import React, { useCallback, useEffect, useState } from "react";
import "./ReplicaE2ePanel.css";

interface ReplicaE2eTestDefinition {
  id: string;
  name: string;
  npmScript: string;
  description: string;
  requiresAuth: boolean;
}

interface ReplicaE2eRunResult {
  testId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  cancelled: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function ReplicaE2ePanel() {
  const [available, setAvailable] = useState(false);
  const [tests, setTests] = useState<ReplicaE2eTestDefinition[]>([]);
  const [runningTestId, setRunningTestId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>("cutover-dry-run");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ReplicaE2eRunResult | null>(
    null,
  );

  const api = window.electronAPI?.replicaE2e;

  const refreshList = useCallback(async () => {
    if (!api) {
      setAvailable(false);
      return;
    }
    try {
      const result = await api.list();
      setAvailable(result.available);
      setTests(result.tests);
      setRunningTestId(result.runningTestId);
      if (result.tests.length > 0 && !result.tests.some((t) => t.id === selectedId)) {
        setSelectedId(result.tests[0]!.id);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, selectedId]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const handleRun = async () => {
    if (!api || runningTestId) return;
    setError(null);
    setOutput(`Running ${selectedId}…\n`);
    setLastResult(null);
    setRunningTestId(selectedId);
    try {
      const result = await api.run(selectedId);
      setLastResult(result);
      const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
      setOutput(
        combined ||
          `(no output — exit ${result.exitCode ?? "?"}${result.cancelled ? ", cancelled" : ""})`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunningTestId(null);
      void refreshList();
    }
  };

  const handleCancel = async () => {
    if (!api) return;
    try {
      await api.cancel();
      setOutput((prev) => `${prev}\n\n[cancelled]\n`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunningTestId(null);
      void refreshList();
    }
  };

  if (!api) {
    return null;
  }

  return (
    <section className="replica-e2e-panel">
      <div className="replica-e2e-panel__header">
        <h3 className="replica-e2e-panel__title">Plan A replica E2E</h3>
        <p className="replica-e2e-panel__hint">
          Run Turso Sync tests against live cloud APIs on demand. Uses your Papr
          login / PAPR_API_KEY and current workspace.
        </p>
      </div>

      {!available ? (
        <p className="replica-e2e-panel__unavailable">
          Available when running from source (<code>npm start</code>), not in
          packaged releases.
        </p>
      ) : (
        <>
          <div className="replica-e2e-panel__controls">
            <select
              className="replica-e2e-panel__select"
              value={selectedId}
              disabled={Boolean(runningTestId)}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {tests.map((test) => (
                <option key={test.id} value={test.id}>
                  {test.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="replica-e2e-panel__run"
              disabled={Boolean(runningTestId)}
              onClick={() => void handleRun()}
            >
              {runningTestId ? "Running…" : "Run test"}
            </button>
            {runningTestId ? (
              <button
                type="button"
                className="replica-e2e-panel__cancel"
                onClick={() => void handleCancel()}
              >
                Cancel
              </button>
            ) : null}
          </div>

          {tests.find((t) => t.id === selectedId)?.description ? (
            <p className="replica-e2e-panel__desc">
              {tests.find((t) => t.id === selectedId)?.description}
            </p>
          ) : null}

          {lastResult ? (
            <p
              className={
                lastResult.exitCode === 0 && !lastResult.cancelled
                  ? "replica-e2e-panel__status replica-e2e-panel__status--ok"
                  : "replica-e2e-panel__status replica-e2e-panel__status--fail"
              }
            >
              {lastResult.cancelled
                ? "Cancelled"
                : lastResult.exitCode === 0
                  ? "Passed"
                  : `Failed (exit ${lastResult.exitCode ?? "?"})`}
              {" · "}
              {formatDuration(lastResult.durationMs)}
            </p>
          ) : null}

          {error ? <div className="replica-e2e-panel__error">{error}</div> : null}

          {output ? (
            <pre className="replica-e2e-panel__output">{output}</pre>
          ) : null}
        </>
      )}
    </section>
  );
}
