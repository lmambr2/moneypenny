/// <reference types="vite/client" />

// Vite's client types declare the asset modules the app imports for
// side effects (`*.scss`, `*.css`, images). TypeScript 6 rejects a
// side-effect import with no declaration (TS2882), so this reference is
// required for `import './styles/global.scss'` in main.ts to typecheck.
