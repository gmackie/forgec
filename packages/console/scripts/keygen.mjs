// Prints a newly generated key only when explicitly invoked by the operator. Never runs at startup.
const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
]);
console.log(
  JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)),
);
