import { Icon } from './icon.jsx';

/** The quiet line an inactive pane shows while a run waits on the person: a permission request, or a question from Claude. */
export function PermissionNotice({ request, active, onReview, title = 'Approval needed', icon = 'shield' }) {
  // The active pane already presents the request in its dialog.
  if (!request || active) return null;
  return <div className="permission-notice">
    <div className="permission-notice-row compose-column">
      <div className="permission-notice-content" role="status">
        <Icon name={icon} size={15} />
        <strong>{title}</strong>
        <span className="permission-notice-summary" title={request.summary}>{request.summary}</span>
      </div>
      <button onClick={onReview} aria-label={`Review: ${title}`}>Review<Icon name="right" size={13} /></button>
    </div>
  </div>;
}
