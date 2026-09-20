/** Production id generation: time-ordered, URL-safe, unguessable. */
import type { Resource } from "../model.js";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function encode(value: bigint, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

export function productionIds() {
  return {
    next: (r: Resource) => {
      const time = encode(BigInt(Date.now()), 10);
      const rand = crypto.getRandomValues(new Uint8Array(10));
      let bits = 0n;
      for (const b of rand) bits = (bits << 8n) | BigInt(b);
      return `${r.name.slice(0, 3).toLowerCase()}_${time}${encode(bits, 16)}`;
    },
    opId: () => crypto.randomUUID(),
  };
}
