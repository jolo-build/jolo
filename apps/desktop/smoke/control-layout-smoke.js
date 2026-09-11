// Geometry checks for controls that can look correct in one theme while clipping in another.
export async function checkSettingsLayout(evaluate) {
  const layout = await evaluate(`(() => {
    const page = document.querySelector('.settings-page');
    const bounds = page.getBoundingClientRect();
    const overflow = [...page.querySelectorAll('input, select, button')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width && (r.left < bounds.left || r.right > bounds.right);
    }).map(el => el.getAttribute('aria-label') || el.textContent || el.type);
    const arrows = [...page.querySelectorAll('.select-field, .combobox')].filter(el => el.getBoundingClientRect().width).map(el => {
      const select = el.querySelector('select, input').getBoundingClientRect();
      const icon = el.querySelector('.icon').getBoundingClientRect();
      return { inset: select.right - icon.right, offset: Math.abs((select.top + select.bottom - icon.top - icon.bottom) / 2) };
    });
    const footer = page.querySelector('.settings-savebar').getBoundingClientRect();
    return { overflow, arrows, footerVisible: footer.bottom <= bounds.bottom + 1 && footer.top >= bounds.top, horizontalOverflow: page.scrollWidth - page.clientWidth };
  })()`);
  if (layout.overflow.length || layout.horizontalOverflow > 1 || !layout.footerVisible || layout.arrows.some(a => a.inset < 8 || a.offset > 1)) {
    throw new Error(`settings control alignment: ${JSON.stringify(layout)}`);
  }
  return layout;
}
