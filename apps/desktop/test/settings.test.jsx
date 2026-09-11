import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEMO_PROVIDER_SETTINGS } from "@jolo/protocol";
import { SettingsPage } from "../src/renderer/components/settings.jsx";

test("desktop waits for the engine catalog instead of inventing selectable providers", () => {
  const render = settings => renderToStaticMarkup(<SettingsPage settings={settings} />);
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
