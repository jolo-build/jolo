import { useEffect } from "react";
import { Icon } from "./icon.jsx";
import { useEngineConnection } from "../engine-context.jsx";

// What the app tells you while you are looking at it. The main process owns the OS
// notification for a window that is not focused; this is the same news for a window that is, so a task
// finishing in another project is never missed just because it was not the one on screen.
//
// A notice is small on purpose: what happened, to which project, and a way to go there. It never carries an
// action that changes anything on its own.

const LIFETIME_MS = 8_000;

function Notice({ notice, onOpen, onDismiss }) {
  useEffect(() => {
    // A notice that needs an answer stays until it is dealt with; the rest fade on their own.
    if (notice.tone === "needs") return undefined;
    const timer = setTimeout(() => onDismiss(notice.key), LIFETIME_MS);
    return () => clearTimeout(timer);
  }, [notice.key, notice.tone, onDismiss]);

  return (
    <li className={`notice ${notice.tone}`}>
      {/* Only news about a task can be opened; news about the app itself has nowhere to go. */}
      {notice.focus?.projectId ? (
        <button className="notice-open" onClick={() => onOpen(notice)} title="Open this task">
          <span className="notice-title">{notice.title}</span>
          <span className="notice-body">{notice.body}</span>
        </button>
      ) : (
        <div className="notice-open notice-plain">
          <span className="notice-title">{notice.title}</span>
          <span className="notice-body">{notice.body}</span>
        </div>
      )}
      <button className="notice-dismiss" onClick={() => onDismiss(notice.key)} aria-label="Dismiss"><Icon name="close" size={12} /></button>
    </li>
  );
}

export function Notices() {
  const { notices, dismissNotice, requestFocus } = useEngineConnection();
  if (!notices?.length) return null;
  return (
    <ul className="notices" aria-live="polite" aria-label="Recent task activity">
      {notices.map((notice) => (
        <Notice
          key={notice.key}
          notice={notice}
          onDismiss={dismissNotice}
          onOpen={(entry) => { requestFocus(entry.focus); dismissNotice(entry.key); }}
        />
      ))}
    </ul>
  );
}
