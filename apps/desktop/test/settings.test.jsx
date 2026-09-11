import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEMO_PROVIDER_SETTINGS } from "@jolo/protocol";
import { SettingsPage } from "../src/renderer/components/settings.jsx";

test("desktop waits for the engine catalog instead of inventing selectable providers", () => {
  // The case stops at what the page shows before the engine's catalog arrives, so it passes the
  // settings and nothing else. The handlers it leaves off belong to paths no assertion here reaches,
  // hence the assertion instead of a row of stubs.
  const render = settings => renderToStaticMarkup(<SettingsPage {...(/** @type {import('react').ComponentProps<typeof SettingsPage>} */ ({ settings }))} />);
  for (const settings of [{ provider: null }, { provider: null, demoProviderEnabled: false }, { provider: DEMO_PROVIDER_SETTINGS, demoProviderEnabled: false }]) {
    const html = render(settings);
    expect(html).not.toContain('value="fake"');
    expect(html).not.toContain("Demo provider");
    expect(html).toContain("Loading providers");
    expect(html).toContain('fieldset class="settings-fields" disabled=""');
  }
  const development = render({ provider: null, demoProviderEnabled: true });
  expect(development).not.toContain("Demo provider");
  expect(development).toContain("Loading providers");
});
