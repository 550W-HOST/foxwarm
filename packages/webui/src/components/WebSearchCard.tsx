import { memo, useMemo } from 'react'
import { handleMarkdownLinkClick } from './chatShared'
import ModelThreadCard from './ModelThreadCard'
import type { WebSearchAction } from '../webSearchAction'

const WebSearchCard = memo(function WebSearchCard({ action }: { action: WebSearchAction }) {
  const preview = action.type === 'search' ? action.query : `Open Page: ${action.url}`
  const body = useMemo(() => {
    if (action.type === 'open_page') {
      return (
        <div className="foxwarm-web-search-body min-w-0 max-w-full break-all text-[13px] leading-5">
          <span className="font-semibold">Open Page:</span>{' '}
          <a href={action.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300">
            {action.url}
          </a>
        </div>
      )
    }

    return (
      <div className="foxwarm-web-search-body min-w-0 max-w-full text-[13px] leading-5">
        {action.queries.length > 1 ? (
          <ul className="list-disc space-y-1 pl-5">
            {action.queries.map(query => <li key={query} className="break-words">{query}</li>)}
          </ul>
        ) : (
          <div className="break-words">{action.query}</div>
        )}
      </div>
    )
  }, [action])

  return (
    <ModelThreadCard kind="web-search" label="Web Search" preview={preview} tone="message" defaultExpanded={false}>
      <div onClick={handleMarkdownLinkClick}>{body}</div>
    </ModelThreadCard>
  )
})

export default WebSearchCard
