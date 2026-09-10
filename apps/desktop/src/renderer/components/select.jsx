import { Icon } from './icon.jsx';

/** Keep native selection and keyboard behavior with a consistently inset chevron. */
export function Select({ children, ...props }) {
  return <span className="select-field">
    <select {...props}>{children}</select>
    <Icon name="down" size={14} />
  </span>;
}
