import { Icon } from './icon.jsx';

export function PermissionNotice({ request, active, onReview }) {
  // The active pane already presents the request in its permission dialog.
  if (!request || active) return null;
  return <div className="permission-notice">
    <div className="permission-notice-row compose-column">
      <div className="permission-notice-content" role="status">
        <Icon name="shield" size={15} />
        <strong>Approval needed</strong>
        <span className="permission-notice-summary" title={request.summary}>{request.summary}</span>
      </div>
      <button onClick={onReview} aria-label="Review permission request">Review<Icon name="right" size={13} /></button>
    </div>
  </div>;
}
