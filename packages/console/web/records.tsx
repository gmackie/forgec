import React, { useCallback, useEffect, useState } from "react";
import { GizmoWorkspace, type ForgeCall } from "@forgegraph/react";
import { Button } from "@cloudflare/kumo/components/button";
import type { RecordWorkspace, RuntimeTarget } from "../src/runtime-control.js";
import { gizmos } from "./gizmos/index.js";
import "./gizmos/gizmos.css";
export type StudioApi = <T>(
  path: string,
  method?: string,
  body?: unknown,
) => Promise<T>;

export function RecordWorkspaceView({ api }: { api: StudioApi }) {
  const [targets, setTargets] = useState<Omit<RuntimeTarget, "token">[]>([]);
  const [target, setTarget] = useState("");
  const [opened, setOpened] = useState<{
    target: string;
    contract: RecordWorkspace;
  } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [activePurpose, setActivePurpose] = useState("");
  useEffect(() => {
    let alive = true;
    api<{ targets: Omit<RuntimeTarget, "token">[] }>("/runtime/targets")
      .then((r) => {
        if (alive) setTargets(r.targets);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [api]);
  async function open() {
    setLoading(true);
    setError("");
    try {
      const contract = await api<RecordWorkspace>(
        `/runtime/targets/${target}/workspace`,
      );
      setOpened({ target, contract });
      setActivePurpose(purpose);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  const call = useCallback<ForgeCall>(
    async (operationId, input, opts) => {
      if (!opened)
        return {
          ok: false,
          code: "NotConnected",
          status: 409,
          problem: { code: "NotConnected" },
        };
      try {
        return await api(`/runtime/targets/${opened.target}/record`, "POST", {
          operationId,
          input,
          buildHash: opened.contract.buildHash,
          ...(opened.contract.deploymentRevision
            ? { deploymentRevision: opened.contract.deploymentRevision }
            : {}),
          ...(activePurpose ? { purpose: activePurpose } : {}),
          ...opts,
        });
      } catch (e) {
        return {
          ok: false,
          code: "RecordRequestFailed",
          status: 502,
          problem: {
            code: "RecordRequestFailed",
            detail: (e as Error).message,
          },
        };
      }
    },
    [api, opened, activePurpose],
  );
  return (
    <section className="studio-use">
      <header>
        <p className="eyebrow">USE · LIVE RECORDS</p>
        <h2>Your daily workspace</h2>
        <p>
          Browse records, update information, and run business actions. Design
          drafts do not change this deployed application.
        </p>
      </header>
      {error && <p role="alert">{error}</p>}
      {opened ? (
        <>
          <div className="studio-live-banner">
            <strong>
              Live data · {targets.find((t) => t.id === opened.target)?.name}
            </strong>
            <span>{opened.contract.descriptor.package}</span>
            <span>
              Review record changes before saving. Actions run when confirmed.
            </span>
            <Button disabled={dirty} onClick={() => setOpened(null)}>
              Change environment
            </Button>
          </div>
          <GizmoWorkspace
            operations={opened.contract.operations.map((op) => op.id)}
            gizmos={gizmos}
            descriptor={opened.contract.descriptor}
            call={call}
            onDirtyChange={setDirty}
          />
        </>
      ) : (
        <div className="studio-connect-card">
          <h3>Choose where to work</h3>
          <p>Select an environment explicitly before loading its records.</p>
          <label>
            Environment
            <select
              aria-label="Record environment"
              value={target}
              disabled={loading}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">Choose environment</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reason for accessing data (if required)
            <input
              aria-label="Record access purpose"
              value={purpose}
              disabled={loading}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </label>
          <Button disabled={!target || loading} onClick={() => void open()}>
            {loading ? "Opening…" : "Open records"}
          </Button>
          {!targets.length && (
            <p>
              No environments are available. An administrator can connect a
              deployed application.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
