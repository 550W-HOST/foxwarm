var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  FOXWARM_APP_SCHEMA_URI: () => FOXWARM_APP_SCHEMA_URI,
  FOXWARM_MODELS_SCHEMA_URI: () => FOXWARM_MODELS_SCHEMA_URI,
  activate: () => activate,
  buildFoxwarmNodeUriString: () => buildFoxwarmNodeUriString,
  deactivate: () => deactivate,
  getFoxwarmConfigSchemaContent: () => getFoxwarmConfigSchemaContent,
  getFoxwarmConfigSchemaUri: () => getFoxwarmConfigSchemaUri,
  isExactWorkspaceRoot: () => isExactWorkspaceRoot,
  normalizeConfigFilesResponse: () => normalizeConfigFilesResponse,
  normalizeFoxwarmOpenRequest: () => normalizeFoxwarmOpenRequest,
  normalizeWorkspaceRootsResponse: () => normalizeWorkspaceRootsResponse,
  parseFoxwarmUri: () => parseFoxwarmUri,
  registerFoxwarmConfigSchemas: () => registerFoxwarmConfigSchemas
});
module.exports = __toCommonJS(extension_exports);
var vscode3 = __toESM(require("vscode"));

// src/provider.ts
var vscode = __toESM(require("vscode"));

// src/foxwarmUri.ts
function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
function parseFoxwarmUri(uri) {
  if (uri.scheme !== "foxwarm") {
    throw new Error(`Unsupported URI scheme \`${uri.scheme}\`; expected \`foxwarm\`.`);
  }
  if (uri.authority.startsWith("node+")) {
    const nodeId2 = decodePathSegment(uri.authority.slice("node+".length));
    if (!nodeId2) {
      throw new Error(`Missing node id in foxwarm URI \`${uri.toString(true)}\`.`);
    }
    const realPathSegments2 = uri.path.split("/").filter(Boolean).map(decodePathSegment);
    return {
      namespace: "node",
      nodeId: nodeId2,
      realPath: `/${realPathSegments2.join("/")}`
    };
  }
  if (uri.authority !== "node") {
    throw new Error(`Unsupported foxwarm URI authority \`${uri.authority}\`; expected \`node+<nodeId>\`.`);
  }
  const rawSegments = uri.path.split("/").filter(Boolean);
  if (rawSegments.length === 0) {
    throw new Error(`Missing node id in foxwarm URI \`${uri.toString(true)}\`.`);
  }
  const nodeId = decodePathSegment(rawSegments[0]);
  if (!nodeId) {
    throw new Error(`Missing node id in foxwarm URI \`${uri.toString(true)}\`.`);
  }
  const realPathSegments = rawSegments.slice(1).map(decodePathSegment);
  const realPath = `/${realPathSegments.join("/")}`;
  return {
    namespace: "node",
    nodeId,
    realPath
  };
}
function buildFoxwarmNodeUriString(nodeId, realPath) {
  if (!nodeId || nodeId.includes("/")) {
    throw new Error("nodeId must be a non-empty single path segment.");
  }
  if (!realPath.startsWith("/")) {
    throw new Error("realPath must be absolute.");
  }
  const encodedNodeId = encodeURIComponent(nodeId);
  const encodedPath = realPath.split("/").map((segment, index) => index === 0 ? "" : encodeURIComponent(segment)).join("/");
  return `foxwarm://node+${encodedNodeId}${encodedPath}`;
}

// src/openRequest.ts
function normalizeFoxwarmAbsolutePath(value) {
  if (typeof value !== "string") {
    throw new Error("Foxwarm path must be a string.");
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("\0")) {
    throw new Error("Foxwarm path must be an absolute POSIX path.");
  }
  const segments = [];
  for (const segment of trimmed.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}
function normalizeLine(value, label) {
  if (value === void 0 || value === null) return void 0;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}
function normalizeFoxwarmOpenRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Foxwarm open request.");
  }
  const request = value;
  if (typeof request.nodeId !== "string" || !/^[A-Za-z0-9._-]+$/.test(request.nodeId)) {
    throw new Error("Foxwarm node id is invalid.");
  }
  const nodeId = request.nodeId;
  const path = normalizeFoxwarmAbsolutePath(request.path);
  if (request.kind === "addFolder") {
    return { kind: "addFolder", nodeId, path };
  }
  if (request.kind === "openFile") {
    const startLine = normalizeLine(request.startLine, "startLine");
    const startColumn = normalizeLine(request.startColumn, "startColumn");
    const endLine = normalizeLine(request.endLine, "endLine");
    if (startColumn !== void 0 && startLine === void 0) {
      throw new Error("startColumn requires startLine.");
    }
    if (startLine !== void 0 && endLine !== void 0 && endLine < startLine) {
      throw new Error("endLine must not be before startLine.");
    }
    return {
      kind: "openFile",
      nodeId,
      path,
      ...startLine !== void 0 ? { startLine } : {},
      ...startColumn !== void 0 ? { startColumn } : {},
      ...endLine !== void 0 ? { endLine } : {}
    };
  }
  throw new Error("Unsupported Foxwarm open request kind.");
}

// src/workspaceRoots.ts
function normalizeRoot(value, kind) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Foxwarm ${kind} workspace root is missing.`);
  }
  const root = value;
  if (root.nodeId !== "master") {
    throw new Error(`Foxwarm ${kind} workspace root must use the master node.`);
  }
  return {
    kind,
    nodeId: "master",
    path: normalizeFoxwarmAbsolutePath(root.path)
  };
}
function normalizeConfigFile(value, kind) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Foxwarm ${kind} config file is missing.`);
  }
  const file = value;
  if (file.nodeId !== "master") {
    throw new Error(`Foxwarm ${kind} config file must use the master node.`);
  }
  return {
    kind,
    nodeId: "master",
    path: normalizeFoxwarmAbsolutePath(file.path)
  };
}
function normalizeWorkspaceRootsResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Foxwarm workspace roots response.");
  }
  const response = value;
  if (response.version !== 1 || !response.roots || typeof response.roots !== "object" || Array.isArray(response.roots)) {
    throw new Error("Unsupported Foxwarm workspace roots response.");
  }
  const roots = response.roots;
  const app = normalizeRoot(roots.app, "app");
  const data = normalizeRoot(roots.data, "data");
  if (app.path === data.path) {
    const sharedName = "Foxwarm App & Data";
    return {
      app: { ...app, name: sharedName },
      data: { ...data, name: sharedName }
    };
  }
  return {
    app: { ...app, name: "Foxwarm App" },
    data: { ...data, name: "Foxwarm Data" }
  };
}
function normalizeConfigFilesResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Foxwarm workspace roots response.");
  }
  const response = value;
  if (response.version !== 1 || !response.configFiles || typeof response.configFiles !== "object" || Array.isArray(response.configFiles)) {
    throw new Error("Unsupported Foxwarm config files response.");
  }
  const files = response.configFiles;
  return {
    app: normalizeConfigFile(files.app, "app"),
    models: normalizeConfigFile(files.models, "models")
  };
}
function isExactWorkspaceRoot(uri, target) {
  try {
    const parsed = parseFoxwarmUri(uri);
    return parsed.nodeId === target.nodeId && normalizeFoxwarmAbsolutePath(parsed.realPath) === normalizeFoxwarmAbsolutePath(target.path);
  } catch {
    return false;
  }
}

// src/provider.ts
var API_PREFIX = "/api/vscode-web/fs";
function deriveApiBase(extensionUri) {
  if (extensionUri.scheme !== "http" && extensionUri.scheme !== "https") {
    return API_PREFIX;
  }
  const marker = "/vscode-web/extensions/foxwarm-fs";
  const markerIndex = extensionUri.path.indexOf(marker);
  const prefix = markerIndex >= 0 ? extensionUri.path.slice(0, markerIndex) : "";
  return `${extensionUri.scheme}://${extensionUri.authority}${prefix}${API_PREFIX}`;
}
function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== void 0) {
      search.set(key, String(value));
    }
  }
  return search.toString();
}
function mapFileSystemError(uri, status, code, message) {
  switch (code || status) {
    case "FileNotFound":
    case 404:
      return vscode.FileSystemError.FileNotFound(uri);
    case "FileExists":
    case 409:
      return vscode.FileSystemError.FileExists(uri);
    case "FileNotADirectory":
      return vscode.FileSystemError.FileNotADirectory(uri);
    case "FileIsADirectory":
      return vscode.FileSystemError.FileIsADirectory(uri);
    case "NoPermissions":
    case 401:
    case 403:
      return vscode.FileSystemError.NoPermissions(uri);
    case "Unavailable":
    case 503:
      return vscode.FileSystemError.Unavailable(uri);
    default:
      return new vscode.FileSystemError(message || `Foxwarm filesystem request failed (${status}).`);
  }
}
var FoxwarmFileSystemProvider = class _FoxwarmFileSystemProvider {
  constructor(apiBase) {
    this.apiBase = apiBase;
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeFile = this.changeEmitter.event;
  }
  static fromExtensionContext(context) {
    return new _FoxwarmFileSystemProvider(deriveApiBase(context.extensionUri));
  }
  watch(_uri, _options) {
    return new vscode.Disposable(() => void 0);
  }
  async stat(uri) {
    return this.fetchJson(uri, "stat");
  }
  async readDirectory(uri) {
    const payload = await this.fetchJson(uri, "read-directory");
    return payload.entries.map((entry) => [entry.name, entry.type]);
  }
  async readFile(uri) {
    const response = await this.fetch(uri, "read-file");
    return new Uint8Array(await response.arrayBuffer());
  }
  async writeFile(uri, content, options) {
    await this.fetch(uri, "write-file", {
      method: "PUT",
      query: { create: options.create ? 1 : 0, overwrite: options.overwrite ? 1 : 0 },
      body: content,
      headers: { "Content-Type": "application/octet-stream" }
    });
    this.fireSoon({ type: vscode.FileChangeType.Changed, uri });
  }
  async createDirectory(uri) {
    await this.postJson(uri, "create-directory", {});
    this.fireSoon({ type: vscode.FileChangeType.Created, uri });
  }
  async delete(uri, options) {
    await this.postJson(uri, "delete", { recursive: options.recursive });
    this.fireSoon({ type: vscode.FileChangeType.Deleted, uri });
  }
  async rename(oldUri, newUri, options) {
    const oldTarget = parseFoxwarmUri(oldUri);
    const newTarget = parseFoxwarmUri(newUri);
    if (oldTarget.nodeId !== newTarget.nodeId || oldTarget.namespace !== newTarget.namespace) {
      throw vscode.FileSystemError.NoPermissions(newUri);
    }
    const response = await fetch(`${this.apiBase}/rename`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeId: oldTarget.nodeId,
        oldPath: oldTarget.realPath,
        newPath: newTarget.realPath,
        overwrite: options.overwrite
      })
    });
    await this.ensureOk(newUri, response);
    this.fireSoon(
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri }
    );
  }
  notifyExternalChange(uri) {
    this.fireSoon({ type: vscode.FileChangeType.Changed, uri });
  }
  async getWorkspaceRoots() {
    return normalizeWorkspaceRootsResponse(await this.getWorkspaceMetadata());
  }
  async getConfigFiles() {
    return normalizeConfigFilesResponse(await this.getWorkspaceMetadata());
  }
  async getWorkspaceMetadata() {
    const response = await fetch(`${this.apiBase}/workspace-roots`, { credentials: "include" });
    if (!response.ok) {
      let message = `Foxwarm workspace root request failed (${response.status}).`;
      try {
        const payload = await response.json();
        if (typeof payload.error === "string" && payload.error) message = payload.error;
      } catch {
      }
      throw new Error(message);
    }
    return response.json();
  }
  async fetchJson(uri, operation) {
    const response = await this.fetch(uri, operation);
    return response.json();
  }
  async postJson(uri, operation, body) {
    await this.fetch(uri, operation, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }
  async fetch(uri, operation, init) {
    const target = parseFoxwarmUri(uri);
    const query = queryString({ nodeId: target.nodeId, path: target.realPath, ...init?.query });
    const response = await fetch(`${this.apiBase}/${operation}?${query}`, {
      ...init,
      credentials: "include"
    });
    await this.ensureOk(uri, response);
    return response;
  }
  async ensureOk(uri, response) {
    if (response.ok) {
      return;
    }
    let payload = {};
    try {
      payload = await response.json();
    } catch {
    }
    throw mapFileSystemError(uri, response.status, payload.code, payload.error);
  }
  fireSoon(...events) {
    this.changeEmitter.fire(events);
  }
};

// src/configSchemas.ts
var vscode2 = __toESM(require("vscode"));

// ../../shared/src/configSchemas.ts
var KNOWN_PROVIDER_TYPES = [
  "openai-completions",
  "openai-responses",
  "openai",
  "anthropic",
  "session-hash",
  "failover"
];
var knownProviderType = {
  anyOf: [
    { enum: KNOWN_PROVIDER_TYPES },
    { type: "string" }
  ],
  description: "Provider protocol or virtual routing strategy. Known Foxwarm values are suggested; custom provider types remain valid."
};
var effectiveProviderTypeIs = (providerType) => ({
  anyOf: [
    {
      required: ["providerType"],
      properties: { providerType: { const: providerType } }
    },
    {
      required: ["provider"],
      properties: { provider: { const: providerType } },
      anyOf: [
        { not: { required: ["providerType"] } },
        { properties: { providerType: { enum: ["", null, false] } } }
      ]
    }
  ]
});
var positiveInteger = {
  type: "integer",
  minimum: 1
};
var openaiWebSearchOptions = {
  type: "object",
  additionalProperties: true,
  description: "Opt-in OpenAI Responses hosted web search settings. Ignored by non-Responses providers.",
  properties: {
    enabled: { type: "boolean", description: "Enable the hosted web_search tool for eligible Responses requests." },
    toolChoice: { enum: ["auto", "required"], description: "Responses tool-selection mode when hosted search is enabled." },
    searchContextSize: { enum: ["low", "medium", "high"], description: "Amount of search context requested from OpenAI." },
    allowedDomains: { type: "array", items: { type: "string", minLength: 1 }, description: "Optional domain filter for web search." },
    userLocation: {
      type: "object",
      additionalProperties: true,
      properties: {
        type: { const: "approximate" },
        country: { type: "string" },
        city: { type: "string" },
        region: { type: "string" },
        timezone: { type: "string" }
      }
    }
  }
};
var openaiWebSearchConfig = {
  oneOf: [
    { type: "boolean" },
    openaiWebSearchOptions
  ],
  description: "Opt-in OpenAI Responses hosted web search settings. Use true/false for defaults or an object for tuning. Ignored by non-Responses providers."
};
var modelEffortConfig = {
  type: "object",
  additionalProperties: true,
  description: "First-class reasoning effort capabilities and default for this provider or model.",
  properties: {
    allowed: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { enum: ["none", "low", "medium", "high", "xhigh", "max"] },
      description: "Effort levels accepted for this provider/model. Model-level values replace the provider list."
    },
    default: {
      enum: ["none", "low", "medium", "high", "xhigh", "max"],
      description: "Effort used when a request does not select one. Defaults to high."
    }
  }
};
var modelOverrideProperties = {
  contextLimit: { type: "integer", minimum: 1, description: "Context window size in tokens." },
  effort: modelEffortConfig,
  historyReasoningField: {
    enum: ["reasoning_content", "reasoning"],
    description: "Assistant-history reasoning field used by this Chat Completions provider/model. Defaults to reasoning_content."
  },
  extraFields: { type: "object", additionalProperties: true, description: "Provider-specific request fields." },
  extraHeaders: { type: "object", additionalProperties: true, description: "Provider-specific HTTP headers. Values are passed through to the canonical backend loader." },
  webSearch: openaiWebSearchConfig
};
var modelItem = {
  anyOf: [
    { type: "string" },
    {
      type: "object",
      required: ["id"],
      additionalProperties: true,
      properties: {
        id: { type: "string", minLength: 1, description: "Provider model identifier." },
        ...modelOverrideProperties
      }
    }
  ]
};
var modelListContainsHistoryReasoningField = {
  type: "array",
  contains: {
    type: "object",
    required: ["historyReasoningField"]
  }
};
var providerObjectEntry = {
  type: "object",
  additionalProperties: true,
  properties: {
    providerType: knownProviderType,
    provider: { ...knownProviderType, deprecated: true, description: "Legacy spelling for providerType. Prefer providerType." },
    baseUrl: { type: "string", description: "Provider API base URL." },
    apiKey: { type: "string", description: "Provider credential. Keep this file private." },
    models: { type: "array", items: modelItem, description: "Preferred provider model list." },
    model: {
      deprecated: true,
      description: "Legacy spelling for models. Prefer models.",
      anyOf: [
        { type: "string" },
        { type: "array", items: modelItem }
      ]
    },
    contextLimit: modelOverrideProperties.contextLimit,
    effort: modelEffortConfig,
    historyReasoningField: modelOverrideProperties.historyReasoningField,
    asyncCompact: { type: "boolean", description: "Whether background compaction may use this provider." },
    requestCompression: { enum: ["gzip", "br"], description: "Optional request-body compression." },
    extraFields: modelOverrideProperties.extraFields,
    extraHeaders: modelOverrideProperties.extraHeaders,
    webSearch: modelOverrideProperties.webSearch,
    targets: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true, description: "Concrete model keys used by a virtual provider." },
    failureThreshold: { ...positiveInteger, description: "Consecutive failures before a non-final failover target cools down." },
    cooldownMs: { ...positiveInteger, description: "Failover cooldown duration in milliseconds." }
  },
  allOf: [
    {
      if: effectiveProviderTypeIs("session-hash"),
      then: {
        required: ["targets"],
        properties: { targets: { minItems: 1 } },
        not: { anyOf: ["models", "model", "baseUrl", "apiKey", "requestCompression", "extraFields", "extraHeaders", "webSearch", "contextLimit", "effort", "historyReasoningField", "asyncCompact", "failureThreshold", "cooldownMs"].map((field) => ({ required: [field] })) }
      }
    },
    {
      if: effectiveProviderTypeIs("failover"),
      then: {
        required: ["targets"],
        properties: { targets: { minItems: 2 } },
        not: { anyOf: ["models", "model", "baseUrl", "apiKey", "requestCompression", "extraFields", "extraHeaders", "webSearch", "contextLimit", "effort", "historyReasoningField", "asyncCompact"].map((field) => ({ required: [field] })) }
      }
    },
    {
      if: { not: { anyOf: [effectiveProviderTypeIs("session-hash"), effectiveProviderTypeIs("failover")] } },
      then: {
        not: { anyOf: ["targets", "failureThreshold", "cooldownMs"].map((field) => ({ required: [field] })) }
      }
    },
    {
      if: { not: effectiveProviderTypeIs("openai-completions") },
      then: {
        not: {
          anyOf: [
            { required: ["historyReasoningField"] },
            { required: ["models"], properties: { models: modelListContainsHistoryReasoningField } },
            { required: ["model"], properties: { model: modelListContainsHistoryReasoningField } }
          ]
        }
      }
    }
  ]
};
var providerEntry = {
  oneOf: [
    {
      type: "string",
      pattern: "\\S",
      description: "Alias shorthand for a single-target session-hash virtual provider."
    },
    providerObjectEntry
  ]
};
var MODELS_CONFIG_SCHEMA = {
  $id: "https://foxwarm.dev/schemas/models-config.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Foxwarm models configuration",
  type: "object",
  additionalProperties: true,
  properties: {
    default: { type: "string", minLength: 1, description: "Default concrete or virtual model key." },
    providers: {
      type: "object",
      minProperties: 1,
      additionalProperties: providerEntry,
      description: "Preferred provider map."
    },
    models: {
      type: "object",
      minProperties: 1,
      additionalProperties: providerEntry,
      deprecated: true,
      description: "Legacy root spelling for providers. Prefer providers."
    }
  },
  anyOf: [{ required: ["providers"] }, { required: ["models"] }]
};
var guestAgent = {
  type: "object",
  additionalProperties: true,
  required: ["agentId"],
  properties: {
    agentId: { type: "string" },
    mode: { enum: ["single", "inherited"] },
    isolated: { type: "boolean" },
    node: { type: "string" }
  }
};
var channelEntry = {
  type: "object",
  additionalProperties: true,
  properties: {
    type: {
      anyOf: [
        { enum: ["telegram", "matrix", "wework", "weixin", "qqbot"] },
        { type: "string" }
      ],
      description: "Known managed channel type or a custom channel type."
    },
    enabled: { type: "boolean" },
    appId: { type: "string" },
    clientSecret: { type: "string" },
    requireMention: { type: "boolean", description: "Require @mention in QQ groups; defaults to true." },
    groupContextLimit: { type: "integer", minimum: 0, maximum: 50, description: "Prior QQ group messages retained as untrusted context; defaults to 10." },
    groupBatchWindowMs: {
      anyOf: [
        { const: 0 },
        { type: "integer", minimum: 250, maximum: 3e4 }
      ],
      description: "Fixed non-sliding ordinary QQ group batch window in milliseconds; defaults to 5000 and 0 disables batching."
    },
    media: {
      type: "object",
      additionalProperties: true,
      properties: {
        imageMaxBytes: { type: "integer", minimum: 1, maximum: 20971520, description: "Safe inline-image threshold; larger images fall back to generic files." },
        fileMaxBytes: { type: "integer", minimum: 1, maximum: 209715200, description: "Bounded inbound/fallback generic-file cap; local QQ sends are additionally capped at 100 MiB." },
        maxTotalBytes: { type: "integer", minimum: 1, maximum: 209715200 },
        maxAttachments: { type: "integer", minimum: 1, maximum: 16 }
      }
    },
    allowedUsers: { type: "array", items: { type: "string" } },
    guestAgent,
    botToken: { type: "string" },
    mainAttachUser: { type: "string" },
    homeserver: { type: "string" },
    accessToken: { type: "string" },
    botUserId: { type: "string" },
    webhookUrl: { type: "string" },
    token: { type: "string" },
    encodingAESKey: { type: "string" },
    listenPort: { type: "integer", minimum: 1, maximum: 65535 },
    listenPath: { type: "string" },
    selfName: { type: "string" },
    baseUrl: { type: "string" },
    routeTag: { type: "string" },
    allowAllUsers: { type: "boolean" },
    longPollTimeoutMs: { type: "integer", minimum: 1 },
    loginBotType: { type: "string" },
    aibot: {
      type: "object",
      additionalProperties: true,
      properties: {
        stream: { type: "boolean" },
        streamMaxContentBytes: { type: "integer", minimum: 1 },
        websocket: {
          type: "object",
          additionalProperties: true,
          properties: {
            enabled: { type: "boolean" },
            botId: { type: "string" },
            secret: { type: "string" },
            url: { type: "string" },
            heartbeatMs: { type: "integer", minimum: 1 },
            reconnectMs: { type: "integer", minimum: 1 }
          }
        }
      }
    }
  }
};
var APP_CONFIG_SCHEMA = {
  $id: "https://foxwarm.dev/schemas/app-config.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Foxwarm application configuration",
  type: "object",
  additionalProperties: true,
  properties: {
    nodeProviders: {
      type: "object",
      propertyNames: { pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
      additionalProperties: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "command"],
            properties: {
              type: { const: "executable", description: "Trusted one-shot executable Node provider adapter." },
              command: { type: "string", minLength: 1, maxLength: 4096, pattern: "^\\S(?:.*\\S)?$" },
              args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4096 } },
              timeoutSeconds: { type: "integer", minimum: 1, maximum: 300, default: 90 }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "command", "image", "allowedWorktreeRoots"],
            properties: {
              type: { const: "docker-worktree", description: "Trusted resident Linux Docker provider for one existing Git worktree." },
              command: { type: "string", minLength: 1, maxLength: 4096, pattern: "^\\S(?:.*\\S)?$", description: "Fixed Docker launcher command, for example docker or sudo." },
              args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4096 }, description: 'Fixed launcher arguments, for example ["-n", "docker"].' },
              image: { type: "string", minLength: 1, maxLength: 4096 },
              allowedWorktreeRoots: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1, maxLength: 4096 } },
              networkModes: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["none", "bridge"] }, default: ["none"] },
              stateDir: { type: "string", minLength: 1, maxLength: 4096 },
              memory: { type: "string", pattern: "^[1-9]\\d*[kKmMgG]$", default: "2g" },
              cpus: { type: "number", exclusiveMinimum: 0, maximum: 64, default: 2 },
              pidsLimit: { type: "integer", minimum: 16, maximum: 65536, default: 256 },
              tmpfsSize: { type: "string", pattern: "^[1-9]\\d*[kKmMgG]$", default: "256m" }
            }
          }
        ]
      },
      description: "Startup-only trusted Node providers. Requires restart."
    },
    vector: {
      oneOf: [
        { const: false },
        {
          type: "object",
          additionalProperties: true,
          properties: {
            enabled: { type: "boolean" },
            baseUrl: { type: "string", pattern: "^https?://" },
            lexicalIndex: { type: "boolean", default: false },
            hybridSearch: { type: "boolean", default: false }
          }
        }
      ],
      description: "Optional semantic vector search. Omission or false disables it; an object enables it unless enabled is false and requires an OpenAI-compatible API base URL such as http://host:port/v1. Requires restart."
    },
    sessionWorkers: {
      oneOf: [
        { type: "boolean" },
        {
          type: "object",
          additionalProperties: true,
          properties: {
            enabled: { type: "boolean" },
            idleSeconds: { type: "integer", minimum: 1, maximum: 86400 }
          }
        }
      ],
      description: "Optional per-session process mode. Supplying an object enables it unless enabled is false. Requires restart."
    },
    dbWorkers: {
      type: "boolean",
      description: "Run the LanceDB/vector owner in a child process. Defaults to true and requires restart."
    },
    vectorMaintenance: {
      oneOf: [
        { type: "boolean" },
        {
          type: "object",
          additionalProperties: true,
          properties: {
            enabled: { type: "boolean" },
            retentionHours: { type: "integer", minimum: 1 }
          }
        }
      ],
      description: "Automatic LanceDB maintenance. Use true/false for default retention or an object to tune retentionHours. Requires restart."
    },
    bot: {
      type: "object",
      additionalProperties: true,
      properties: {
        name: { type: "string" },
        enableWebUI: { type: "boolean" },
        enableTrigger: { type: "boolean" },
        httpPort: { type: "integer", minimum: 1, maximum: 65535 },
        enableTUI: { type: "boolean" }
      }
    },
    llm: {
      type: "object",
      additionalProperties: true,
      properties: {
        ollamaBaseUrl: { type: "string", description: "Legacy vector endpoint root. Prefer top-level vector.baseUrl." },
        contextLimit: { type: "integer", minimum: 1 },
        compactKeepPercent: { type: "number", exclusiveMinimum: 0, maximum: 1, default: 0.3 },
        compactThresholdPercent: { type: "number", exclusiveMinimum: 0, maximum: 1, default: 0.85 },
        compactBlockLevelMinTokens: { type: "integer", minimum: 1 },
        compactBlockLevelForceTokens: { type: "integer", minimum: 1 },
        compactBlockCandidateFraction: { type: "number", minimum: 0, maximum: 1 },
        compactBlockForceCompactFraction: { type: "number", minimum: 0, maximum: 1 },
        compactMessageForceCompactFraction: { type: "number", minimum: 0, maximum: 1 },
        maxOutput: { type: "integer", minimum: 1, default: 32768, description: "Maximum provider output tokens. Defaults to 32768." },
        openaiBaseUrl: { type: "string" },
        openaiApiKey: { type: "string" },
        anthropicBaseUrl: { type: "string" },
        anthropicApiKey: { type: "string" }
      }
    },
    paths: {
      type: "object",
      additionalProperties: true,
      properties: {
        agentsDir: { type: "string" },
        skillsDir: { type: "string" },
        mcpConfigPath: { type: "string" }
      }
    },
    channels: {
      type: "object",
      additionalProperties: channelEntry
    },
    asrService: {
      type: "object",
      additionalProperties: true,
      properties: {
        enabled: { type: "boolean" },
        url: { type: "string" },
        key: { type: "string" }
      }
    }
  }
};

// src/configSchemas.ts
var FOXWARM_YAML_CONTRIBUTOR = "foxwarm-config";
var FOXWARM_MODELS_SCHEMA_URI = "foxwarm-config://schemas/models";
var FOXWARM_APP_SCHEMA_URI = "foxwarm-config://schemas/app";
function getFoxwarmConfigSchemaUri(resource, files) {
  try {
    const uri = vscode2.Uri.parse(resource);
    if (isExactWorkspaceRoot(uri, files.models)) return FOXWARM_MODELS_SCHEMA_URI;
    if (isExactWorkspaceRoot(uri, files.app)) return FOXWARM_APP_SCHEMA_URI;
    return void 0;
  } catch {
    return void 0;
  }
}
function getFoxwarmConfigSchemaContent(uri) {
  if (uri === FOXWARM_MODELS_SCHEMA_URI) return JSON.stringify(MODELS_CONFIG_SCHEMA);
  if (uri === FOXWARM_APP_SCHEMA_URI) return JSON.stringify(APP_CONFIG_SCHEMA);
  throw new Error(`Unknown Foxwarm config schema URI: ${uri}`);
}
async function registerFoxwarmConfigSchemas(files, extensions2 = vscode2.extensions) {
  const yamlExtension = extensions2?.getExtension("redhat.vscode-yaml");
  if (!yamlExtension) {
    console.info("Foxwarm config schema support is unavailable because redhat.vscode-yaml is not installed.");
    return false;
  }
  const api = await yamlExtension.activate();
  if (!api || typeof api.registerContributor !== "function") {
    console.info("Foxwarm config schema support is unavailable because redhat.vscode-yaml did not expose its contributor API.");
    return false;
  }
  const registered = api.registerContributor(
    FOXWARM_YAML_CONTRIBUTOR,
    ((resource) => getFoxwarmConfigSchemaUri(resource, files)),
    getFoxwarmConfigSchemaContent
  );
  if (!registered) console.info("Foxwarm config schema contributor was already registered.");
  return registered;
}

// src/extension.ts
async function waitForInitialWorkspaceFolders() {
  const deadline = Date.now() + 15e3;
  while (Date.now() < deadline) {
    const folders = vscode3.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Code workspace folders did not finish loading.");
}
function getCurrentNodeId() {
  const folder = vscode3.workspace.workspaceFolders?.[0];
  if (!folder) {
    return "master";
  }
  try {
    return parseFoxwarmUri(folder.uri).nodeId;
  } catch {
    return "master";
  }
}
function getCurrentPath() {
  const folder = vscode3.workspace.workspaceFolders?.[0];
  if (!folder) {
    return "/";
  }
  try {
    return parseFoxwarmUri(folder.uri).realPath;
  } catch {
    return "/";
  }
}
async function addFoxwarmFolder(request) {
  const normalized = normalizeFoxwarmOpenRequest(request);
  if (normalized.kind !== "addFolder") {
    throw new Error("Expected an addFolder request.");
  }
  const uri = vscode3.Uri.parse(buildFoxwarmNodeUriString(normalized.nodeId, normalized.path));
  const uriString = uri.toString(true);
  const workspaceFolders = await waitForInitialWorkspaceFolders();
  const existing = workspaceFolders.some((folder) => {
    try {
      const target = parseFoxwarmUri(folder.uri);
      return target.nodeId === normalized.nodeId && target.realPath === normalized.path;
    } catch {
      return false;
    }
  }) ?? false;
  if (existing) {
    return { status: "existing", uri: uriString };
  }
  let folderChangeListener;
  let folderChangeTimeout;
  const folderAdded = new Promise((resolve, reject) => {
    folderChangeTimeout = setTimeout(() => {
      folderChangeListener?.dispose();
      reject(new Error(`Timed out while adding ${normalized.path} to the current workspace.`));
    }, 15e3);
    folderChangeListener = vscode3.workspace.onDidChangeWorkspaceFolders((event) => {
      if (!event.added.some((folder) => folder.uri.toString(true) === uriString)) return;
      if (folderChangeTimeout) clearTimeout(folderChangeTimeout);
      folderChangeListener?.dispose();
      resolve();
    });
  });
  const accepted = vscode3.workspace.updateWorkspaceFolders(
    workspaceFolders.length,
    0,
    { uri }
  );
  if (!accepted) {
    if (folderChangeTimeout) clearTimeout(folderChangeTimeout);
    folderChangeListener?.dispose();
    throw new Error(`Could not add ${normalized.path} to the current workspace.`);
  }
  await folderAdded;
  return { status: "added", uri: uriString };
}
async function waitForManagedWorkspaceUpdate(context, target, start, deleteCount, uri) {
  let settled = false;
  let listener;
  let finish = () => {
  };
  const changed = new Promise((resolve) => {
    finish = (value) => {
      if (settled) return;
      settled = true;
      listener?.dispose();
      resolve(value);
    };
    listener = vscode3.workspace.onDidChangeWorkspaceFolders(() => {
      const folder = vscode3.workspace.workspaceFolders?.find((candidate) => candidate.name === target.name && isExactWorkspaceRoot(candidate.uri, target));
      if (folder) finish(folder.uri);
    });
  });
  context.subscriptions.push(listener, { dispose: () => finish(void 0) });
  const accepted = vscode3.workspace.updateWorkspaceFolders(start, deleteCount, { uri, name: target.name });
  if (!accepted) {
    finish(void 0);
    throw new Error(`Could not update ${target.name} in the current workspace.`);
  }
  return changed;
}
async function revealWorkspaceRoot(uri) {
  await vscode3.commands.executeCommand("workbench.view.explorer");
  await vscode3.commands.executeCommand("revealInExplorer", uri);
}
async function openManagedWorkspaceRoot(kind, provider, context) {
  const target = (await provider.getWorkspaceRoots())[kind];
  const uri = vscode3.Uri.parse(buildFoxwarmNodeUriString(target.nodeId, target.path));
  const stat = await vscode3.workspace.fs.stat(uri);
  if ((stat.type & vscode3.FileType.Directory) === 0) {
    throw new Error(`${target.name} is not a directory: ${target.path}`);
  }
  const folders = vscode3.workspace.workspaceFolders ?? [];
  const existingIndex = folders.findIndex((folder) => isExactWorkspaceRoot(folder.uri, target));
  const existing = existingIndex >= 0 ? folders[existingIndex] : void 0;
  let finalUri = existing?.uri ?? uri;
  if (existing?.name !== target.name) {
    finalUri = await waitForManagedWorkspaceUpdate(
      context,
      target,
      existing ? existingIndex : folders.length,
      existing ? 1 : 0,
      existing?.uri ?? uri
    );
  }
  if (finalUri) await revealWorkspaceRoot(finalUri);
  return {
    status: existing ? "existing" : "added",
    uri: (finalUri ?? existing?.uri ?? uri).toString(true)
  };
}
async function openFoxwarmFolder() {
  const value = await vscode3.window.showInputBox({
    title: "Open Foxwarm Folder",
    prompt: "Absolute path on the current Foxwarm node.",
    value: getCurrentPath(),
    validateInput: (input) => input.startsWith("/") ? void 0 : "Use an absolute path, for example /app."
  });
  if (!value) {
    return;
  }
  await addFoxwarmFolder({ kind: "addFolder", nodeId: getCurrentNodeId(), path: value });
}
async function addExplorerFolderToWorkspace(uri) {
  const target = parseFoxwarmUri(uri);
  const stat = await vscode3.workspace.fs.stat(uri);
  if ((stat.type & vscode3.FileType.Directory) === 0) throw new Error(`${target.realPath} is not a directory.`);
  await addFoxwarmFolder({ kind: "addFolder", nodeId: target.nodeId, path: target.realPath });
}
async function openFoxwarmFile(request, provider) {
  const normalized = normalizeFoxwarmOpenRequest(request);
  if (normalized.kind !== "openFile") throw new Error("Expected an openFile request.");
  const uri = vscode3.Uri.parse(buildFoxwarmNodeUriString(normalized.nodeId, normalized.path));
  const stat = await vscode3.workspace.fs.stat(uri);
  if ((stat.type & vscode3.FileType.Directory) !== 0) {
    throw new Error(`${normalized.path} is a directory, not a file.`);
  }
  const existing = vscode3.workspace.textDocuments.find((document2) => document2.uri.toString(true) === uri.toString(true));
  if (!existing?.isDirty) provider.notifyExternalChange(uri);
  const document = existing ?? await vscode3.workspace.openTextDocument(uri);
  let selection;
  if (normalized.startLine !== void 0) {
    if (normalized.startLine > document.lineCount) {
      throw new Error(`Line ${normalized.startLine} is beyond the end of ${normalized.path}.`);
    }
    if (normalized.startColumn !== void 0) {
      const line = document.lineAt(normalized.startLine - 1);
      const position = new vscode3.Position(normalized.startLine - 1, Math.min(normalized.startColumn - 1, line.text.length));
      selection = new vscode3.Range(position, position);
    } else {
      const endLine = Math.min(normalized.endLine ?? normalized.startLine, document.lineCount);
      selection = new vscode3.Range(
        new vscode3.Position(normalized.startLine - 1, 0),
        document.lineAt(endLine - 1).range.end
      );
    }
  }
  await vscode3.window.showTextDocument(document, { preview: true, selection });
  if (existing?.isDirty) {
    void vscode3.window.showWarningMessage(`${normalized.path} has unsaved Code changes; the external file was not reloaded.`);
  }
  return { status: "opened", uri: uri.toString(true) };
}
async function handleOpenRequest(request, provider) {
  const normalized = normalizeFoxwarmOpenRequest(request);
  if (normalized.kind === "addFolder") {
    return addFoxwarmFolder(normalized);
  }
  return openFoxwarmFile(normalized, provider);
}
function activate(context) {
  const provider = FoxwarmFileSystemProvider.fromExtensionContext(context);
  context.subscriptions.push(
    vscode3.workspace.registerFileSystemProvider("foxwarm", provider, {
      isCaseSensitive: true,
      isReadonly: false
    }),
    vscode3.commands.registerCommand("foxwarm-fs.openFolder", openFoxwarmFolder),
    vscode3.commands.registerCommand("foxwarm-fs.openAppFolder", () => openManagedWorkspaceRoot("app", provider, context)),
    vscode3.commands.registerCommand("foxwarm-fs.openDataFolder", () => openManagedWorkspaceRoot("data", provider, context)),
    vscode3.commands.registerCommand("foxwarm-fs.addFolderToWorkspace", addExplorerFolderToWorkspace),
    vscode3.commands.registerCommand("foxwarm-fs.handleOpenRequest", (request) => handleOpenRequest(request, provider))
  );
  void provider.getConfigFiles().then((files) => registerFoxwarmConfigSchemas(files)).catch((error) => console.warn(`Foxwarm config schema support could not start: ${error instanceof Error ? error.message : String(error)}`));
  console.log("Foxwarm filesystem provider registered for foxwarm://node+<nodeId>/<absolute-path>.");
}
function deactivate() {
}
//# sourceMappingURL=extension.js.map
