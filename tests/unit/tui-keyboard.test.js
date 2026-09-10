import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { supportsKittyKeyboard } from "../../apps/cli/src/tui/keyboard.js";

function terminal(tty = true) {
  const stdin = new PassThrough();
  stdin.isTTY = tty;
  const writes = [];
  const stdout = { isTTY: tty, write: (data) => writes.push(data) };
  return { stdin, stdout, writes };
}

test("Kitty reply is consumed and early keystrokes survive exactly once", async () => {
  const { stdin, stdout, writes } = terminal();
  const result = supportsKittyKeyboard(stdin, stdout);
  stdin.write("q\x1b[?0u café 🚀");
  expect(await result).toBe(true);
  expect(writes).toEqual(["\x1b[?u"]);
  expect(stdin.read().toString()).toBe("q café 🚀");
  expect(stdin.read()).toBeNull();
  expect(stdin.listenerCount("readable")).toBe(0);
  expect(stdin.listenerCount("end")).toBe(0);
  stdin.destroy();
});

test("fragmented capability replies are assembled without leaking into the prompt", async () => {
  const { stdin, stdout } = terminal();
  const result = supportsKittyKeyboard(stdin, stdout);
  for (const chunk of ["\x1b", "[?", "12", "u"]) {
    stdin.write(chunk);
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(await result).toBe(true);
  expect(stdin.read()).toBeNull();
  stdin.destroy();
});

test("unsupported terminals time out without losing the first typed characters", async () => {
  const { stdin, stdout } = terminal();
  const result = supportsKittyKeyboard(stdin, stdout);
  stdin.write("query");
  expect(await result).toBe(false);
  expect(stdin.read().toString()).toBe("query");
  expect(stdin.read()).toBeNull();
  expect(stdin.listenerCount("readable")).toBe(0);
  stdin.destroy();
});

test("non-terminal streams are never queried", async () => {
  const { stdin, stdout, writes } = terminal(false);
  expect(await supportsKittyKeyboard(stdin, stdout)).toBe(false);
  expect(writes).toEqual([]);
  stdin.destroy();
});

test("large early input is bounded and returned intact", async () => {
  const { stdin, stdout } = terminal();
  const input = "a".repeat(64 * 1024);
  const result = supportsKittyKeyboard(stdin, stdout);
  stdin.write(input);
  expect(await result).toBe(false);
  expect(stdin.read().toString()).toBe(input);
  stdin.destroy();
});
