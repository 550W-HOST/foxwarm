// Advisory Draft-07 schema of the global tool authorization policy (state/tool-authorization.yaml),
// written from the Main server's parser: ToolAuthorizationYaml, ToolAuthorizationPolicy.Normalize
// and OperationRules. The parser rejects unknown fields, so these objects do too. The server
// remains authoritative; rules it checks across fields (which selectors an operation declares,
// session-target resolver families, byte limits of non-ASCII text) are left to it.

// The operation catalog (OperationDeclarations.Operations). A Main server test keeps it in parity.
export const TOOL_AUTHORIZATION_OPERATIONS = [
  'env.read',
  'env.write',
  'env.exec',
  'env.browser',
  'env.tool',
  'node.list',
  'node.view',
  'node.select',
  'node.lifecycle',
  'node.trust',
  'session.list',
  'session.view',
  'session.send',
  'session.deliver',
  'session.create',
  'session.control',
  'session.manage',
  'history.read',
  'history.search',
  'agent.list',
  'agent.view',
  'agent.create',
  'agent.manage',
  'task.create',
  'task.list',
  'task.read',
  'task.update',
  'task.complete',
  'task.cancel',
  'task.assign',
  'timer.manage',
  'channel.send',
  'user.ask',
  'config.read',
  'config.write',
  'secret.use',
  'secret.manage',
  'secret.list',
  'mcp.call',
  'mcp.list',
  'mcp.manage',
  'mcp.subscribe',
  'image.generate',
  'model.request',
] as const

const operationFamilies = [...new Set(TOOL_AUTHORIZATION_OPERATIONS.map((op) => op.slice(0, op.indexOf('.')) + '.*'))]

const nonBlank = { type: 'string', minLength: 1, pattern: '\\S' }
const scalar = { type: ['string', 'number', 'boolean', 'null'] }
const scalarList = { type: 'array', minItems: 1, maxItems: 64, items: scalar }
const nameList = { type: 'array', minItems: 1, maxItems: 64, items: nonBlank }

const scalarMatcherObject = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    equals: { ...scalar, description: 'Matches this exact value.' },
    oneOf: { ...scalarList, description: 'Matches any of these values.' },
    exists: { type: 'boolean', description: 'Whether the value must be present (true) or absent (false).' },
  },
}

// ToolAuthorizationPolicy.Matcher: a scalar, a list of alternatives, or an operator object.
const matcher = { anyOf: [scalar, scalarList, scalarMatcherObject] }

// IdentityPattern: identity characters and `*`, one or a list of alternatives.
const identity = { type: 'string', pattern: '^\\s*[A-Za-z0-9._:/*-]+\\s*$' }
const identityPattern = {
  anyOf: [identity, { type: 'array', minItems: 1, maxItems: 64, items: identity }],
}

const nodeMatcher = {
  description: 'Node of the call\'s effect: an ID pattern (covering descendants), or exactly one of current, provider or exact.',
  anyOf: [
    identityPattern,
    {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 1,
      properties: {
        current: { const: true, description: 'The caller\'s current Node.' },
        provider: { ...identityPattern, description: 'Exact Provider IDs, without `*` or `/`.' },
        exact: { ...identityPattern, description: 'Literal Node IDs, without their descendants.' },
      },
    },
  ],
}

const secretName = { type: 'string', pattern: '^\\s*[a-z0-9._*-]+\\s*$' }
const secretsMatcher = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    anyOf: {
      description: 'Secret name patterns using `*`.',
      anyOf: [secretName, { type: 'array', minItems: 1, maxItems: 64, items: secretName }],
    },
    owned: { const: true, description: 'Secrets owned by the caller\'s Agent.' },
  },
}

// Only ${agent.dir}, ${agent.memoryDir} and ${workspace} are path variables.
const policyPath = {
  type: 'string',
  minLength: 1,
  pattern: '^(?:[^$]|\\$(?!\\{[^}]+\\})|\\$\\{(?:agent\\.dir|agent\\.memoryDir|workspace)\\})*$',
}

const pathMatcher = {
  type: 'object',
  additionalProperties: false,
  anyOf: [{ required: ['allWithin'] }, { required: ['anyNotWithin'] }],
  properties: {
    arg: { description: 'Path argument names; omitted selects every path of the call.', anyOf: [nonBlank, nameList] },
    allWithin: { ...policyPath, description: 'Matches when every selected path is inside this directory.' },
    anyNotWithin: { ...policyPath, description: 'Matches when any selected path is outside this directory.' },
  },
}

const sourceValue = { enum: ['builtin', 'mcp', 'node'] }
const toolSelector = {
  description: 'Tool name, list of names, or a source/server/name selector.',
  anyOf: [
    nonBlank,
    nameList,
    {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        source: {
          anyOf: [
            sourceValue,
            { type: 'array', minItems: 1, maxItems: 64, items: sourceValue },
            {
              type: 'object',
              additionalProperties: false,
              minProperties: 1,
              properties: {
                equals: sourceValue,
                oneOf: { type: 'array', minItems: 1, maxItems: 64, items: sourceValue },
                exists: { type: 'boolean' },
              },
            },
          ],
        },
        server: { ...matcher, description: 'MCP server name.' },
        name: { ...matcher, description: 'Tool name.' },
      },
    },
  ],
}

const sessionRelation = { enum: ['parent', 'child'] }
const sessionCondition = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    self: { const: true, description: 'The calling Session.' },
    sameAgent: { const: true, description: 'A Session of the caller\'s Agent.' },
    relation: {
      anyOf: [sessionRelation, { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: sessionRelation }],
    },
  },
}

const argumentMatcher = {
  anyOf: [
    scalar,
    scalarList,
    scalarMatcherObject,
    { type: 'object', additionalProperties: false, required: ['session'], properties: { session: sessionCondition } },
    {
      type: 'object',
      additionalProperties: false,
      required: ['agent'],
      properties: {
        agent: {
          type: 'object',
          additionalProperties: false,
          required: ['sameAgent'],
          properties: { sameAgent: { type: 'boolean' } },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['task'],
      properties: {
        task: { type: 'object', additionalProperties: false, required: ['owned'], properties: { owned: { const: true } } },
      },
    },
  ],
}

const argsMatcher = {
  type: 'object',
  maxProperties: 64,
  description: 'Dotted argument names mapped to value matchers.',
  propertyNames: { pattern: '^(?!(?:.*\\.)?(?:__proto__|prototype|constructor)(?:\\.|$))[^.]+(?:\\.[^.]+)*$' },
  additionalProperties: argumentMatcher,
}

const approval = {
  type: 'object',
  additionalProperties: false,
  description: 'Approval options of an ask rule.',
  properties: {
    timeoutSeconds: { type: 'integer', minimum: 30, maximum: 604800, description: 'Seconds before an unanswered request expires.' },
    approvers: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      description: 'Access identity IDs that may decide, in addition to the administrator.',
      items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
    },
  },
}

const action = { enum: ['allow', 'ask', 'deny'] }

// Fields shared by both rule kinds.
const ruleCommon = {
  id: { ...nonBlank, description: 'Unique rule ID. Omitted IDs are numbered by position.' },
  enabled: { type: 'boolean', default: true },
  action: { ...action, description: 'Decision when this rule is the first enabled match.' },
  reason: { type: 'string', description: 'Shown when the rule denies or asks.' },
  approval,
}

const approvalRequiresAsk = {
  if: { required: ['approval'] },
  then: { properties: { action: { const: 'ask' } } },
}

const actionIs = (value: string) => ({ required: ['action'], properties: { action: { const: value } } })

const shorthandSelectors = ['agent', 'session', 'externalId', 'tool', 'node', 'secrets', 'args', 'path']

const toolRule = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    ...ruleCommon,
    agent: { ...matcher, description: 'Caller\'s Agent.' },
    session: { ...identityPattern, description: 'Caller\'s Session ID pattern.' },
    externalId: { ...matcher, description: 'Verified inbound identity ID.' },
    tool: toolSelector,
    node: nodeMatcher,
    secrets: { ...secretsMatcher, description: 'Decides only the stored secrets a call would use.' },
    args: argsMatcher,
    path: pathMatcher,
    match: {
      type: 'object',
      additionalProperties: false,
      description: 'Selectors in the original form. Not combined with top-level selectors.',
      properties: {
        agent: matcher,
        session: matcher,
        externalId: matcher,
        tool: toolSelector,
        targetNode: matcher,
        args: argsMatcher,
        path: pathMatcher,
      },
    },
  },
  allOf: [
    approvalRequiresAsk,
    { not: { required: ['match'], anyOf: shorthandSelectors.map((key) => ({ required: [key] })) } },
    {
      not: {
        ...actionIs('ask'),
        anyOf: [{ required: ['externalId'] }, { required: ['match'], properties: { match: { required: ['externalId'] } } }],
      },
    },
    { not: { required: ['secrets', 'externalId'] } },
  ],
}

const opName = { enum: ['*', ...operationFamilies, ...TOOL_AUTHORIZATION_OPERATIONS] }

const sessionTarget = {
  anyOf: [
    { type: 'object', additionalProperties: false, required: ['session'], properties: { session: sessionCondition } },
    { type: 'object', additionalProperties: false, required: ['id'], properties: { id: identityPattern } },
  ],
}

const operationRule = {
  type: 'object',
  additionalProperties: false,
  required: ['op', 'action'],
  properties: {
    ...ruleCommon,
    op: {
      description: 'Operation, list of operations, family such as `env.*`, or `*`.',
      anyOf: [opName, { type: 'array', minItems: 1, maxItems: 64, items: opName }],
    },
    agent: { ...matcher, description: 'Caller\'s Agent.' },
    session: { ...identityPattern, description: 'Caller\'s Session ID pattern.' },
    externalId: { ...matcher, description: 'Verified inbound identity ID.' },
    node: nodeMatcher,
    path: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        within: { ...policyPath, description: 'The path is on master inside this directory.' },
        notWithin: { ...policyPath, description: 'The path is not on master inside this directory.' },
      },
    },
    targetSession: sessionTarget,
    parent: sessionTarget,
    targetAgent: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 1,
      properties: { self: { const: true }, descendant: { const: true }, id: identityPattern },
    },
    task: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 1,
      properties: { owned: { const: true }, created: { const: true } },
    },
    channel: identityPattern,
    secret: secretsMatcher,
    mcp: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: { server: identityPattern, tool: identityPattern },
    },
    nodeTool: identityPattern,
    model: identityPattern,
    with: {
      type: 'object',
      minProperties: 1,
      maxProperties: 16,
      description: 'Operation attributes mapped to value matchers.',
      additionalProperties: matcher,
    },
  },
  allOf: [
    approvalRequiresAsk,
    { not: { ...actionIs('ask'), required: ['action', 'externalId'] } },
  ],
}

export const TOOL_AUTHORIZATION_POLICY_SCHEMA = {
  $id: 'https://foxwarm.dev/schemas/tool-authorization.json',
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Foxwarm tool authorization policy',
  type: 'object',
  additionalProperties: false,
  required: ['version'],
  properties: {
    version: { const: 1 },
    defaultAction: { ...action, default: 'allow', description: 'Decision for internal calls no rule matches. Unmatched external calls are always denied.' },
    rules: {
      type: 'array',
      maxItems: 256,
      description: 'Ordered rules; the first enabled match decides.',
      items: {
        if: { type: 'object', required: ['op'] },
        then: operationRule,
        else: toolRule,
      },
    },
  },
}
