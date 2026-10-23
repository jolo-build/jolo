const FINISHED = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/** Claude's open questions and plan approvals, restored from a session snapshot like permission requests are (D7). */
export class PendingDialogs {
  requests = new Map();
  duringLoad = [];
  cursor = 0n;

  get first() { return this.requests.values().next().value ?? null; }
  add(dialog) { this.requests.set(dialog.dialogId, dialog); }
  remove(id) { this.requests.delete(id); }

  seed(dialogs, cursor) {
    const newer = this.duringLoad ?? [];
    this.requests = new Map(dialogs.map(dialog => [dialog.dialogId, dialog]));
    this.duringLoad = null;
    this.cursor = BigInt(cursor);
    for (const event of newer) this.apply(event);
  }

  apply(event) {
    const relevant = event.type.startsWith('dialog.') || (event.type === 'run.state' && FINISHED.has(event.payload.state));
    if (!relevant || BigInt(event.eventSeq) <= this.cursor) return;
    if (this.duringLoad) this.duringLoad.push(event);
    this.cursor = BigInt(event.eventSeq);
    if (event.type === 'dialog.requested') this.add(event.payload);
    else if (event.type === 'dialog.resolved') this.remove(event.payload.dialogId);
    else for (const [id, dialog] of this.requests) if (dialog.runId === event.runId) this.remove(id);
  }
}
