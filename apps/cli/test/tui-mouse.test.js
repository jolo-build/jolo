import { expect, test } from "bun:test";
import { mouseReport, enableMouse } from "../src/tui/mouse.js";
import { scrollHistory, historyViewport } from "../src/tui/layout.js";

const lines = Array.from({ length: 100 }, (_, index) => String(index));

test("wheel reports scroll, with or without the escape byte Ink may have consumed", () => {
  expect(mouseReport("[<64;10;5M").delta).toBeLessThan(0); // wheel up
  expect(mouseReport("\x1b[<64;10;5M").delta).toBeLessThan(0);
  expect(mouseReport("[<65;10;5M").delta).toBeGreaterThan(0); // wheel down
  expect(mouseReport("[<68;10;5M").delta).toBeLessThan(0); // shift+wheel still scrolls
});

test("clicks, drags, and releases are consumed without scrolling or reaching the draft", () => {
  for (const report of ["[<0;10;5M", "[<0;10;5m", "[<2;80;24M", "[<32;10;5M"]) {
    expect(mouseReport(report)).toEqual({ delta: 0 });
  }
});

test("ordinary text is never mistaken for a mouse report", () => {
  for (const value of ["hello", "", undefined, null, "[<abc;1;1M", "[<64;10;5", "x[<64;10;5M"]) {
    expect(mouseReport(value)).toBeNull();
  }
});

test("a wheel report moves the history viewport and returns to live at the bottom", () => {
  const height = 10;
  const up = scrollHistory(lines, height, null, mouseReport("[<64;10;5M").delta);
  expect(up).toBe(85);
  expect(historyViewport(lines, height, up).lines[0]).toBe("85");
  expect(scrollHistory(lines, height, up, mouseReport("[<65;10;5M").delta)).toBeNull(); // back at the newest line
  expect(scrollHistory(["only"], height, null, mouseReport("[<64;10;5M").delta)).toBeNull(); // nothing to scroll
});

test("enabling mouse reports is a no-op off a TTY and restores the previous modes once", () => {
  const written = [];
  const tty = { isTTY: true, write: (text) => written.push(text) };
  const restore = enableMouse(tty);
  expect(written.join("")).toContain("1006h"); // request SGR cell reports
  restore();
  restore();
  expect(written.join("")).toContain("1006l"); // disabled again
  expect(written.filter((text) => text.includes("1006l"))).toHaveLength(1); // exactly once
  expect(enableMouse({ isTTY: false, write: () => { throw new Error("must not write"); } })()).toBeUndefined();
});
