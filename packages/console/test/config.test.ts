import { expect, it } from "vitest";
import { registryFrom, portableSigningJwk } from "../src/config.js";
it("normalizes optional algorithm labels for Node and Workers WebCrypto interoperability", async () => {
  const key = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", key.privateKey);
  const normalized = portableSigningJwk({ ...jwk, alg: "Ed25519" });
  expect(normalized.alg).toBeUndefined();
  expect(normalized.crv).toBe("Ed25519");
  expect(
    await registryFrom({
      INSTANCE_AUTHORITY: "local.test",
      OCI_URL: "https://registry.example",
      OCI_REPOSITORY: "forge",
      SIGNING_KEY_JWK: JSON.stringify(jwk),
    }),
  ).not.toBeNull();
});
