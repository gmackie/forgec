/** Dedicated disposable certification DB only. Deployment is an explicit operator
 * action. No migration, provisioning or automatic cleanup endpoint exists.
 * The authenticated SQL bridge permits data DELETE statements on the test DB. */
export default {
  async fetch(request, env) {
    if (!env.CERT_TOKEN || request.headers.get('authorization') !== `Bearer ${env.CERT_TOKEN}`) return new Response('Unauthorized', { status: 401 });
    if (!request.cf || !env.BUNDLE_SHA256 || !env.HARNESS_SHA256) return new Response('Hosted identity not configured', { status: 503 });
    const url = new URL(request.url);
    if (url.pathname === '/identity') return Response.json({ protocol: 'foundation-d1/1', provider: 'cloudflare-d1-hosted', bundleSha256: env.BUNDLE_SHA256, harnessSha256: env.HARNESS_SHA256, colo: request.cf.colo });
    if (url.pathname !== '/sql' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    try {
      const body = await request.json();
      if (!['first', 'all', 'run', 'batch'].includes(body.kind) || !Array.isArray(body.statements) || !body.statements.length || body.statements.length > 100) throw new Error('Invalid command');
      if (body.kind !== 'batch' && body.statements.length !== 1) throw new Error('Invalid arity');
      const statements = body.statements.map(({ sql, params }) => {
        if (typeof sql !== 'string' || !/^(SELECT|INSERT|UPDATE|DELETE)\b/i.test(sql.trim()) || !Array.isArray(params)) throw new Error('Invalid statement');
        return env.DB.prepare(sql).bind(...params);
      });
      const value = body.kind === 'batch' ? (await env.DB.batch(statements)).map(r => ({ changes: r.meta.changes }))
        : body.kind === 'first' ? await statements[0].first()
        : body.kind === 'all' ? (await statements[0].all()).results
        : { changes: (await statements[0].run()).meta.changes };
      return Response.json({ value });
    } catch (error) {
      // Preserve SQLite constraint markers required by the adapter classifier.
      // Never send submitted SQL/params or arbitrary exception text to callers.
      const message = String(error?.message ?? error);
      const match = message.match(/(?:UNIQUE constraint failed|CHECK constraint failed|FOREIGN KEY constraint failed|NOT NULL constraint failed)[^\n]*/i);
      return Response.json({ error: match?.[0] ?? 'D1 certification command failed' }, { status: 409 });
    }
  },
};
