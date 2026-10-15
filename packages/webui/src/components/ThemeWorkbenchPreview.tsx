import type { CSSProperties } from 'react'
import { ArrowUp, Bot, Check, ChevronDown, Code2, FileText, GitBranch, MessageSquare, Plus, Search, Settings, SquareTerminal } from 'lucide-react'
import { themeVariantCssVariables, type ThemeVariant } from '../theme/manifest'
import './ThemeWorkbenchPreview.css'

/** A static, locally scoped sample: no Session data, runtime mutation, or live controls. */
export default function ThemeWorkbenchPreview({ variant }: { variant: ThemeVariant }) {
  return <div className="theme-scene" data-theme-workbench-preview data-card={variant.composition.card} data-header={variant.composition.header} data-density={variant.composition.density} data-treatment={variant.componentTreatment} style={themeVariantCssVariables(variant) as CSSProperties} role="img" aria-label="Theme preview showing navigation, a conversation, tool output, code, and the composer">
    <aside className="theme-scene-sidebar">
      <div className="theme-scene-brand"><span aria-hidden="true">🦊</span><strong>Foxwarm</strong><span className="theme-scene-brand-settings"><Settings /></span></div>
      <div className="theme-scene-launchers">
        <div><Bot /><span>Agents</span><Plus /></div>
        <div><Code2 /><span>Code</span><ChevronDown /></div>
        <div><SquareTerminal /><span>Terminal</span><ChevronDown /></div>
      </div>
      <div className="theme-scene-search"><Search /><span>Search sessions</span></div>
      <div className="theme-scene-section-label">Sessions</div>
      <div className="theme-scene-session theme-scene-session-selected"><MessageSquare /><span>Workspace review</span></div>
      <div className="theme-scene-session"><MessageSquare /><span>Implementation</span></div>
      <div className="theme-scene-session theme-scene-session-child"><GitBranch /><span>Design notes</span></div>
      <div className="theme-scene-sidebar-footer"><FileText /><span>Tasks</span><Settings /></div>
    </aside>
    <main className="theme-scene-main">
      <div className="theme-scene-tabs"><span className="theme-scene-tab-active"><MessageSquare />Workspace review<span>×</span></span><span><FileText />Notes</span><Plus /></div>
      <header className="theme-scene-heading"><MessageSquare /><div><strong>Workspace review</strong><span>Local session</span></div><Search /><Code2 /></header>
      <div className="theme-scene-conversation">
        <div className="theme-scene-user">Review the palette and spacing.</div>
        <section className="theme-scene-assistant"><div className="theme-scene-card-header"><Bot /><span>Foxwarm</span><span>1.2s</span></div><div className="theme-scene-card-body"><p>The layout is ready. Clear surfaces keep navigation and content easy to scan.</p><pre><span className="theme-scene-keyword">const</span> theme = {'{'}<br />{'  '}accent: <span className="theme-scene-string">'auto'</span>,<br />{'  '}spacing: <span className="theme-scene-number">12</span><br />{'}'}</pre></div></section>
        <section className="theme-scene-tool"><div className="theme-scene-tool-header"><SquareTerminal /><strong>exec</strong><span>0.8s</span><Check /></div><div className="theme-scene-tool-body"><code>npm run check</code><span>All checks passed.</span></div></section>
      </div>
      <div className="theme-scene-composer"><span>Ask Foxwarm anything…</span><div><Plus /><span>Model</span><ChevronDown /><span className="theme-scene-send"><ArrowUp /></span></div></div>
      <footer className="theme-scene-status"><SquareTerminal /><span>Terminal</span><span className="theme-scene-status-spacer" /><GitBranch /><span>Ready</span></footer>
    </main>
  </div>
}
