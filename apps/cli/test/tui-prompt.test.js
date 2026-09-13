import { expect, test } from "bun:test";
import React, { useReducer } from "react";
import { PassThrough } from "node:stream";
import { render, useInput } from "ink";
import { Prompt } from "../src/tui/prompt.jsx";
import { createPromptState, promptReducer } from "../src/tui/prompt-history.js";

test("terminal arrow sequences move the prompt cursor through Ink", async () => {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { columns: 32, rows: 12 });
  const frames = [];
  stdout.on("data", (data) => frames.push(data.toString()));
  let state = createPromptState();
  function Composer() {
    const [current, dispatch] = useReducer(promptReducer, undefined, createPromptState);
    state = current;
    useInput((chunk, key) => dispatch({ type: "edit", chunk, key }));
    return React.createElement(Prompt, { value: current.value, cursor: current.cursor, columns: 32, model: "test" });
  }
  const app = render(React.createElement(Composer), {
    stdin: /** @type {any} */ (stdin), stdout: /** @type {any} */ (stdout),
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const send = async (sequence) => {
    stdin.write(sequence);
    await new Promise((resolve) => setImmediate(resolve));
    await app.waitUntilRenderFlush();
  };
  try {
    await app.waitUntilRenderFlush();
    await new Promise((resolve) => setImmediate(resolve));
    await send("fix the bug");
    expect(state.cursor).toBe(11);
    for (const sequence of ["\x1b[D", "\x1bOD", "\x1b[1;1D"]) {
      await send(sequence);
    }
    expect(state.cursor).toBe(8);
    await send("\x1b[C");
    expect(state.cursor).toBe(9);
    await send("\x1b[1;3D"); // Option+Left, CSI form
    expect(state.cursor).toBe(8);
    await send("\x1bb"); // Option+Left, macOS Escape+b form
    expect(state.cursor).toBe(4);
    await send("\x1bf");
    expect(state.cursor).toBe(7);
    await send("\x1b[1;3C");
    expect(state.cursor).toBe(11);
    await send("\x1b[1;3D");
    await send("big ");
    expect(state).toMatchObject({ value: "fix the big bug", cursor: 12 });
    await send("\x7f");
    await send("\x1b[3~");
    expect(state).toMatchObject({ value: "fix the bigug", cursor: 11 });
    await send("\x1b[H");
    expect(state.cursor).toBe(0);
    await send("\x1b[F");
    expect(state.cursor).toBe(state.value.length);
    await send("x".repeat(40));
    expect(frames.at(-1)).not.toContain("fix the");
    await send("\x1b[H");
    expect(frames.at(-1)).toContain("fix the bigug");
  } finally {
    app.unmount();
    await app.waitUntilExit();
    stdin.destroy();
    stdout.destroy();
  }
});
