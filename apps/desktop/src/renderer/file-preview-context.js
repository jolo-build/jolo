import { createContext } from 'react';

/** @type {import('react').Context<((file: any) => void) | null>} */
export const FilePreviewContext = createContext(null);
