/** Research-only ExternalBinding adapter; no production API or support claim.
 * The vendor SDK owns serialization. This layer owns credentials, tenant binding,
 * domain conversion and failure classification. Retries are explicitly disabled.
 */
export function createBinding(options) {
  const { client: Client, map, operationId, baseUrl, credential, mapInput, decodeOutput } = options;
  const entry = map[operationId];
  if (!entry) throw new Error(`Unmapped vendor operation: ${operationId}`);
  return async (input, ctx) => {
    if (ctx.tenant !== options.tenant) return { ok: false, code: "ConnectionScopeMismatch" };
    let token;
    try {
      token = await credential(ctx);
    } catch {
      return { ok: false, code: "ExternalCredentialsUnavailable" };
    }
    const sdk = new Client({
      auth: false,
      baseUrl,
      timeoutInSeconds: options.timeoutInSeconds ?? 10,
      headers: { Authorization: `Bearer ${token}` },
      maxRetries: 0,
    });
    let owner = sdk;
    for (const segment of entry.accessor) owner = owner[segment];
    let result;
    try {
      result = await owner[entry.method](mapInput(input), { maxRetries: 0 });
    } catch (error) {
      const status = error.statusCode;
      const code =
        status === 401 || status === 403
          ? "ExternalCredentialsRejected"
          : status === 429
            ? "ExternalRateLimited"
            : status >= 400 && status < 500
              ? "ExternalRejected"
              : entry.httpMethod === "GET"
                ? "ExternalUnavailable"
                : "ExternalOutcomeUnknown";
      return { ok: false, code };
    }
    try {
      return { ok: true, value: decodeOutput(result) };
    } catch {
      return { ok: false, code: "ExternalResponseInvalid" };
    }
  };
}
