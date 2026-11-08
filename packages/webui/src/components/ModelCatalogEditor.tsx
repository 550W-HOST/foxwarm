import { useMemo } from 'react'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { addCatalogRow, moveCatalogRow, readModelCatalog, writeModelCatalog, type ModelCatalogRow } from '../modelCatalog'
import { selectableModelKeys } from '../modelsYamlCompletions'

const inputClass = 'w-full rounded-lg border border-fw-border-strong bg-fw-surface px-3 py-2 text-sm text-fw-text-strong outline-none focus:border-fw-accent-border focus:ring-2 focus:ring-fw-focus-ring/20 dark:border-fw-border-strong dark:bg-fw-surface dark:text-fw-text-strong'
const iconButtonClass = 'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-fw-border text-fw-text hover:bg-fw-hover disabled:cursor-not-allowed disabled:opacity-40 dark:border-fw-border'

type ModelCatalogEditorProps = {
  /** The models YAML text, which stays the only storage. */
  yaml: string
  onChange: (yaml: string) => void
}

/**
 * Ordered recommendations that tell Agents which model suits which work. Rows are edited directly
 * in the models YAML, so the YAML view and this list always agree.
 */
export default function ModelCatalogEditor({ yaml, onChange }: ModelCatalogEditorProps) {
  const reading = useMemo(() => readModelCatalog(yaml), [yaml])
  const keys = useMemo(() => selectableModelKeys(yaml), [yaml])
  const rows = reading.ok ? reading.rows : []
  const commit = (next: ModelCatalogRow[]) => onChange(writeModelCatalog(yaml, next))
  const patchRow = (index: number, patch: Partial<ModelCatalogRow>) =>
    commit(rows.map((row, position) => position === index ? { ...row, ...patch } : row))
  const canAdd = reading.ok && keys.some((key) => !rows.some((row) => row.key === key))

  return (
    <section data-model-catalog className="mt-8 max-w-3xl" aria-labelledby="model-catalog-heading">
      <h2 id="model-catalog-heading" className="text-base font-semibold text-fw-text-strong">Recommended models</h2>
      <p className="mt-1 text-sm text-fw-text">Tell Agents which model suits which kind of work, so they can pick one when creating Sessions. Save models to apply changes.</p>
      {!reading.ok ? (
        <p data-model-catalog-unavailable className="mt-3 text-sm text-fw-text-muted">Fix the models YAML to edit recommendations here.</p>
      ) : (
        <>
          {rows.length === 0 && <p className="mt-3 text-sm text-fw-text-muted">No recommendations yet.</p>}
          <ol className="mt-3 space-y-3">
            {rows.map((row, index) => {
              const known = keys.includes(row.key)
              const options = keys.filter((key) => key === row.key || !rows.some((other) => other.key === key))
              return (
                <li key={index} data-model-catalog-row className="flex flex-wrap items-start gap-2 rounded-lg border border-fw-border-muted p-3">
                  <div className="min-w-48 flex-1 basis-56">
                    <select
                      aria-label={`Model for recommendation ${index + 1}`}
                      data-model-catalog-field="key"
                      value={row.key}
                      onChange={(event) => patchRow(index, { key: event.target.value })}
                      className={inputClass}
                    >
                      {!known && <option value={row.key}>{row.key} (not configured)</option>}
                      {options.map((key) => <option key={key} value={key}>{key}</option>)}
                    </select>
                  </div>
                  <div className="min-w-56 flex-[2] basis-72">
                    <textarea
                      aria-label={`Description for ${row.key}`}
                      data-model-catalog-field="description"
                      rows={2}
                      value={row.description}
                      placeholder="When to use this model"
                      onChange={(event) => patchRow(index, { description: event.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button type="button" aria-label={`Move ${row.key} up`} data-model-catalog-action="up" disabled={index === 0} onClick={() => commit(moveCatalogRow(rows, index, -1))} className={iconButtonClass}><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
                    <button type="button" aria-label={`Move ${row.key} down`} data-model-catalog-action="down" disabled={index === rows.length - 1} onClick={() => commit(moveCatalogRow(rows, index, 1))} className={iconButtonClass}><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
                    <button type="button" aria-label={`Remove ${row.key}`} data-model-catalog-action="remove" onClick={() => commit(rows.filter((_, position) => position !== index))} className={iconButtonClass}><X className="h-4 w-4" aria-hidden="true" /></button>
                  </div>
                </li>
              )
            })}
          </ol>
          <button
            type="button"
            data-model-catalog-action="add"
            disabled={!canAdd}
            onClick={() => commit(addCatalogRow(rows, keys))}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-fw-border px-3 py-2 text-sm font-medium text-fw-text hover:bg-fw-hover disabled:cursor-not-allowed disabled:opacity-50 dark:border-fw-border dark:text-fw-text-strong dark:hover:bg-fw-hover"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add recommendation
          </button>
        </>
      )}
    </section>
  )
}
