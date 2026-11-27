import { TOOL_AUTHORIZATION_POLICY_SCHEMA } from './toolAuthorizationPolicySchema'

// An Agent-local rule layer is an ordered list of v1 policy rules. The Main server parses it as
// `{version: 1, defaultAction: allow, rules}` after rejecting caller selectors (`agent`, `session`,
// `sessionPattern`, `externalId`), at the top level and inside `match`, because a local layer
// always applies to its own Agent's subtree (AgentRulePolicy.Parse).
const CALLER_SELECTORS = ['agent', 'session', 'sessionPattern', 'externalId']

type JsonSchema = { [key: string]: unknown }

function withoutCallerSelectors(rule: JsonSchema): JsonSchema {
  const copy = structuredClone(rule)
  const properties = copy.properties as JsonSchema
  for (const key of CALLER_SELECTORS) delete properties[key]
  const match = properties.match as JsonSchema | undefined
  if (match?.properties) for (const key of CALLER_SELECTORS) delete (match.properties as JsonSchema)[key]
  return copy
}

const policyRule = TOOL_AUTHORIZATION_POLICY_SCHEMA.properties.rules.items as unknown as { if: JsonSchema; then: JsonSchema; else: JsonSchema }

export const AGENT_RULES_SCHEMA = {
  $id: 'https://foxwarm.dev/schemas/agent-rules.json',
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Foxwarm Agent rule layer',
  description: 'Ordered rules every tool call of this Agent and the Agents it creates must pass; a final rule with only `action: deny` makes the layer an allowlist.',
  type: 'array',
  maxItems: TOOL_AUTHORIZATION_POLICY_SCHEMA.properties.rules.maxItems,
  items: {
    if: policyRule.if,
    then: withoutCallerSelectors(policyRule.then),
    else: withoutCallerSelectors(policyRule.else),
  },
}
