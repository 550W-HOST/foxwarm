import { fileURLToPath } from 'node:url'

// Fixture entries can live outside this package; resolve every React import here
// so the root CLI's separate React installation cannot enter browser bundles.
export const webuiReactAliases = {
  react: fileURLToPath(import.meta.resolve('react')),
  'react/jsx-runtime': fileURLToPath(import.meta.resolve('react/jsx-runtime')),
  'react-dom': fileURLToPath(import.meta.resolve('react-dom')),
  'react-dom/client': fileURLToPath(import.meta.resolve('react-dom/client')),
}
