import { lazy } from 'react'
import { downloadImageArtifact, downloadManifest } from './downloads'
export const artifactRenderers = Object.freeze({
  image: lazy(() => import('./ImageRenderer')),
  chart: lazy(() => import('./ChartRenderer')),
  react: lazy(() => import('./ReactRenderer')),
})

export const artifactDownloads = Object.freeze({ chart: downloadManifest, react: downloadManifest, image: downloadImageArtifact })
