import React, { useEffect, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Table } from "@cloudflare/kumo/components/table";
import { Banner } from "@cloudflare/kumo/components/banner";
import { KeyIcon, TrashIcon } from "@phosphor-icons/react";

/**
 * Registry credentials.
 *
 * Operators sign in through whatever scheme this instance uses; container clients cannot. The
 * Docker CLI reserves `Authorization` for the registry's own bearer scheme, so it authenticates
 * with a credential issued here instead.
 *
 * The secret is shown exactly once, because only a salted hash is stored. There is deliberately
 * no way to retrieve it again — an operator who loses one issues another and revokes the first.
 */
export interface Credential {
  id: string;
  label: string;
  scopes: string[];
  createdAt: string;
  createdBy: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

type Api = <T>(
  path: string,
  method?: string,
  body?: unknown,
  revision?: number,
) => Promise<T>;

export function RegistryCredentials({
  api,
  authority,
}: {
  api: Api;
  authority: string;
}) {
  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [canPush, setCanPush] = useState(true);
  // Held only until the operator navigates away: it cannot be shown again.
  const [issued, setIssued] = useState<{ id: string; secret: string } | null>(
    null,
  );

  async function load() {
    try {
      const result = await api<{ credentials: Credential[] }>(
        "/registry/credentials",
      );
      setCredentials(result.credentials);
      setError("");
    } catch (e) {
      // A registry that is not configured has no credentials to manage; say so plainly.
      setCredentials([]);
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ credential: Credential; secret: string }>(
        "/registry/credentials",
        "POST",
        { label, scopes: canPush ? ["pull", "push"] : ["pull"] },
      );
      setIssued({ id: result.credential.id, secret: result.secret });
      setLabel("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(credential: Credential) {
    setBusy(true);
    setError("");
    try {
      await api(`/registry/credentials/${credential.id}`, "DELETE");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const active = (credentials ?? []).filter((c) => !c.revokedAt);
  return (
    <section className="panel detail-panel">
      <KeyIcon size={24} />
      <h2>Registry credentials</h2>
      <p className="muted">
        Container clients cannot use this instance’s sign-in, so they
        authenticate with a credential issued here. Each one is shown once.
      </p>

      {issued ? (
        <Banner variant="default">
          <p>
            <strong>Copy this now — it is not stored and cannot be shown
            again.</strong>
          </p>
          <pre className="credential-secret">
            docker login {authority} -u {issued.id} -p {issued.secret}
          </pre>
          <Button variant="ghost" onClick={() => setIssued(null)}>
            I have copied it
          </Button>
        </Banner>
      ) : null}

      {error ? <Banner variant="error" role="alert">{error}</Banner> : null}

      <form onSubmit={create} className="credential-form">
        <Input
          label="Label"
          required
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          description="What this credential is for, so it can be revoked knowingly."
        />
        <label className="credential-scope">
          <input
            type="checkbox"
            checked={canPush}
            onChange={(e) => setCanPush(e.target.checked)}
          />
          <span>Allow publishing (push). Unchecked issues a read-only credential.</span>
        </label>
        <Button variant="primary" type="submit" loading={busy}>
          Issue credential
        </Button>
      </form>

      {credentials === null ? null : active.length === 0 ? (
        <p className="muted">No active credentials.</p>
      ) : (
        <div className="table-scroll">
          <Table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Identifier</th>
                <th>Scopes</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {active.map((c) => (
                <tr key={c.id}>
                  <td>{c.label}</td>
                  <td>
                    <code>{c.id}</code>
                  </td>
                  <td>
                    {c.scopes.map((s) => (
                      <Badge key={s} variant="outline">
                        {s}
                      </Badge>
                    ))}
                  </td>
                  <td>{c.lastUsedAt ? c.lastUsedAt.slice(0, 10) : "never"}</td>
                  <td>
                    <Button
                      variant="ghost"
                      icon={<TrashIcon />}
                      disabled={busy}
                      onClick={() => void revoke(c)}
                    >
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </section>
  );
}
