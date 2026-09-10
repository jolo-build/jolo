const FINISHED = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/** Restore requests from a session snapshot without losing decisions arriving during the read. */
export class PendingPermissions {
  requests = new Map();
  duringLoad = [];
  cursor = 0n;

  get first() { return this.requests.values().next().value ?? null; }
  add(request) { this.requests.set(request.permissionId, request); }
  remove(id) { this.requests.delete(id); }

  seed(requests, cursor) {
    const newer = this.duringLoad ?? [];
    this.requests = new Map(requests.map(request => [request.permissionId, request]));
    this.duringLoad = null;
    this.cursor = BigInt(cursor);
    for (const event of newer) this.apply(event);
  }

  apply(event) {
    const relevant = event.type.startsWith('permission.') || (event.type === 'run.state' && FINISHED.has(event.payload.state));
    if (!relevant || BigInt(event.eventSeq) <= this.cursor) return;
    if (this.duringLoad) this.duringLoad.push(event);
    this.cursor = BigInt(event.eventSeq);
    if (event.type === 'permission.requested') this.add(event.payload);
    else if (event.type === 'permission.resolved') this.remove(event.payload.permissionId);
    else for (const [id, request] of this.requests) if (request.runId === event.runId) this.remove(id);
  }
}
