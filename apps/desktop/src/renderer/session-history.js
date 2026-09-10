// Older pages extend the transcript without advancing the live event cursor.
export class SessionHistory {
  constructor({ sessionId, projection, call, onChange, isCurrent }) {
    Object.assign(this, { sessionId, projection, call, onChange, isCurrent });
    this.hasOlder = false;
    this.beforeOrdinal = null;
    this.loading = false;
    this.error = null;
  }

  seed(page) {
    this.hasOlder = page.hasOlder;
    this.beforeOrdinal = page.messages[0]?.ordinal ?? null;
    this.onChange();
  }

  async loadOlder() {
    if (this.loading || !this.hasOlder || this.beforeOrdinal === null || !this.isCurrent()) return;
    this.loading = true;
    this.error = null;
    this.onChange();
    try {
      const page = await this.call('session.page', { sessionId: this.sessionId, beforeOrdinal: this.beforeOrdinal });
      if (!this.isCurrent()) return;
      // This snapshot can include events still travelling to the renderer. Only
      // merge older messages; do not skip those events or replace current runs.
      this.projection.seed({ messages: page.messages, cursor: page.cursor, advanceCursor: false });
      this.seed(page);
      await Promise.allSettled(page.messages.filter(message => message.committedBytes > 0).map(message => this.projection.fill(message.id)));
    } catch (error) {
      if (this.isCurrent()) this.error = error.message;
    } finally {
      this.loading = false;
      if (this.isCurrent()) this.onChange();
    }
  }
}
