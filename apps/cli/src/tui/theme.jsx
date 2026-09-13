import React, { createContext, useContext, useEffect, useState } from 'react';
import { Box as InkBox, Text as InkText } from 'ink';
import { builtinTheme, themeColor } from '../themes/palettes.js';

const fallback = builtinTheme('terminal');
const ThemeContext = createContext({ theme: fallback, store: null, error: '', refresh: () => {}, choose: (_id) => {} });
const TextContext = createContext(false);
const SurfaceContext = createContext(undefined);
export const useTheme = () => useContext(ThemeContext);

/** A bad edit keeps the last valid palette; the next valid save recovers automatically. */
export function ThemeProvider({ store, initialId, children, onChange = (_theme) => {} }) {
  const [override, setOverride] = useState(initialId);
  const [state, setState] = useState(() => {
    try { return { theme: store.load(initialId ?? store.selected()), error: '' }; }
    catch (error) { return { theme: fallback, error: error.message }; }
  });
  const refresh = () => {
    try {
      const theme = store.load(override ?? store.selected());
      setState((old) => JSON.stringify(old.theme) === JSON.stringify(theme) && !old.error ? old : { theme, error: '' });
    } catch (error) {
      setState((old) => old.error === error.message ? old : { ...old, error: error.message });
    }
  };
  useEffect(() => { onChange(state.theme); }, [state.theme, onChange]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [store, override]);
  const choose = (id) => {
    const theme = store.select(id);
    setOverride(undefined);
    setState({ theme, error: '' });
  };
  return <ThemeContext.Provider value={{ ...state, store, refresh, choose }}>{children}</ThemeContext.Provider>;
}

/** @param {import('ink').TextProps & { children?: React.ReactNode }} props */
export function Text({ color, dimColor, backgroundColor, children, ...props }) {
  const { theme } = useTheme();
  const nested = useContext(TextContext);
  const surface = useContext(SurfaceContext);
  const themed = theme.id !== 'terminal';
  // Ordinary text and unpainted cells use the terminal's dynamic colors. Baking
  // a theme into each printed line leaves stale colors in native scrollback.
  const foreground = color ? themeColor(theme, color) : dimColor && themed ? theme.colors.muted : undefined;
  return <TextContext.Provider value={true}><InkText {...props} color={foreground} dimColor={themed ? false : dimColor} backgroundColor={backgroundColor ? themeColor(theme, backgroundColor) : nested ? undefined : surface}>{children}</InkText></TextContext.Provider>;
}

/** @param {import('ink').BoxProps & { children?: React.ReactNode }} props */
export function Box({ borderColor, backgroundColor, ...props }) {
  const { theme } = useTheme();
  const parent = useContext(SurfaceContext);
  const surface = backgroundColor ? themeColor(theme, backgroundColor) : parent;
  return <SurfaceContext.Provider value={surface}><InkBox {...props} borderColor={borderColor ? themeColor(theme, borderColor === 'gray' ? 'border' : borderColor) : undefined} backgroundColor={surface} /></SurfaceContext.Provider>;
}
