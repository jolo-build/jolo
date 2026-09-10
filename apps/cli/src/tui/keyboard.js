// Query before Ink mounts: two simultaneous stdin readers can replay early keystrokes.
// The caller owns raw mode; Ink owns enabling and restoring the negotiated protocol.
export function supportsKittyKeyboard(stdin = process.stdin, stdout = process.stdout) {
  if (!stdin.isTTY || !stdout.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    let pending = Buffer.alloc(0);
    let finished = false;
    const finish = (supported, remaining = pending) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stdin.off("readable", onReadable);
      stdin.off("end", onEnd);
      if (remaining.length && !stdin.readableEnded) stdin.unshift(remaining);
      resolve(supported);
    };
    const onEnd = () => finish(false);
    const onData = (chunk) => {
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const response = /\x1b\[\?\d+u/.exec(pending.toString("latin1"));
      if (response) {
        finish(true, Buffer.concat([pending.subarray(0, response.index), pending.subarray(response.index + response[0].length)]));
      } else if (pending.length >= 64 * 1024) finish(false);
    };
    const onReadable = () => {
      let chunk;
      while (!finished && (chunk = stdin.read()) !== null) onData(chunk);
    };
    const timer = setTimeout(() => finish(false), 200);
    stdin.on("readable", onReadable);
    stdin.once("end", onEnd);
    stdout.write("\x1b[?u");
  });
}
