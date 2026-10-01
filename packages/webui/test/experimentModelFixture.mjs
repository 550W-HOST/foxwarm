import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Test-only migration into the one runtime YAML reader. JSON text is valid YAML.
export async function writeModelFixture(dataRoot, config, secrets = process.env) {
  const migrated = structuredClone(config)
  for (const provider of Object.values(migrated.providers ?? migrated.models ?? {})) {
    if (provider && typeof provider === 'object' && provider.apiKeyEnv) {
      provider.apiKey = secrets[provider.apiKeyEnv] ?? ''
      delete provider.apiKeyEnv
    }
  }
  await mkdir(join(dataRoot, 'state'), { recursive: true })
  await writeFile(join(dataRoot, 'state', 'models.yaml'), JSON.stringify(migrated, null, 2) + '\n')
}
export async function migrateModelFixture(dataRoot, sourcePath, secrets) {
  await writeModelFixture(dataRoot, JSON.parse(await readFile(sourcePath, 'utf8')), secrets)
}
