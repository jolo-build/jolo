export function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('cancelled'));
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason ?? new Error('cancelled')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Retry a whole provider request; incomplete attempt output is never reused. */
export async function collectSummary(provider, request, signal, maxBytes, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    let summary = '', bytes = 0;
    try {
      for await (const event of provider.stream(request, signal)) {
        if (signal.aborted) throw signal.reason ?? new Error('cancelled');
        if (event.type === 'text_delta') {
          bytes += Buffer.byteLength(event.text);
          if (bytes > maxBytes) throw new Error('compaction summary exceeds output limit');
          summary += event.text;
        } else if (event.type === 'error') throw Object.assign(new Error(`compaction failed: ${event.category}: ${event.message ?? ''}`), { retryable: event.retryable === true });
        else if (event.type === 'finished') break;
      }
      if (!summary.trim()) throw new Error('compaction produced an empty summary');
      return summary.trim();
    } catch (error) {
      if (signal.aborted || !error.retryable || attempt >= retries) throw error;
      await abortableDelay(Math.min(4000, 500 * 2 ** attempt), signal);
    }
  }
}
