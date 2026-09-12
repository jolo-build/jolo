import { escapeHTML } from './pages.js';

export function advertisingConfig(env) {
  const pixel = env.X_PIXEL_ID;
  const event = env.X_REGISTRATION_EVENT_ID;
  if (typeof pixel !== 'string' || !/^[a-z0-9]{3,16}$/.test(pixel) ||
      typeof event !== 'string' || !new RegExp(`^tw-${pixel}-[a-z0-9]{3,16}$`).test(event)) return null;
  return { pixel, event };
}

// Only insert this on the public landing page and generic welcome page. Never
// give advertising scripts access to account details, tasks, chats, or OAuth URLs.
export function advertisingScript(config, conversionID = null) {
  if (!config) return '';
  const event = conversionID ? ` data-event="${escapeHTML(config.event)}" data-conversion-id="${escapeHTML(conversionID)}"` : '';
  return `<script src="/x-pixel.js" data-pixel="${escapeHTML(config.pixel)}"${event} defer></script>`;
}
