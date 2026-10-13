import { expect, it, vi } from "vitest";
import { commandAcknowledgement } from "../src/mqtt-node.js";

it("withholds PUBACK until completion and never acknowledges a failed command", async () => {
  let finish!: () => void;
  const consumer = { receive: () => new Promise<"processed">(resolve => { finish = () => resolve("processed"); }) };
  const ack = vi.fn(), failed = vi.fn();
  const handle = commandAcknowledgement(consumer, failed);
  handle({ topic: "topic", payload: Buffer.from("{}"), qos: 1, retain: false } as never, ack);
  expect(ack).not.toHaveBeenCalled();
  finish(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(ack).toHaveBeenCalledWith();
  const reject = commandAcknowledgement({ receive: async () => { throw new Error("private details"); } }, failed);
  const rejectedAck = vi.fn();
  reject({ topic: "topic", payload: Buffer.from("{}"), qos: 1, retain: false } as never, rejectedAck);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(rejectedAck).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledWith(new Error("MQTT command completion failed; consumer stopped without acknowledgement"));
});
