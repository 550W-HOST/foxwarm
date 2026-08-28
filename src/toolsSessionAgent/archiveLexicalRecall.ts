import { formatSubstantiveMessageSearchText } from '../utils/messageFormat';
import {
  locateEffectiveArchiveCandidatesBySubstring,
  type ArchiveLexicalCandidate,
} from '../session/archiveStore';

const MAX_QUERY_LENGTH = 2000;
const MAX_LOCATOR_LENGTH = 160;
const MAX_LOCATORS = 4;
const MAX_LEXICAL_RESULTS = 40;

const COMMON_TOKENS = new Set([
  'about', 'after', 'again', 'before', 'current', 'details', 'find', 'from', 'have', 'into', 'latest',
  'message', 'please', 'recall', 'search', 'session', 'show', 'that', 'this', 'tool', 'using', 'what', 'when',
  'where', 'which', 'with', 'would', 'your',
]);

export type StrongArchiveLocator = {
  value: string;
  normalized: string;
  strength: number;
  offset: number;
};

export type ArchiveLexicalHit = {
  id: string;
  kind: 'raw' | 'block';
  session_id: string;
  agent: string;
  source_family: string;
  lexical_score: number;
  lexical_locators: string[];
  start_seq?: number;
  end_seq?: number;
  raw_start_seq?: number;
  raw_end_seq?: number;
  block_id?: number;
  block_level?: number;
  chunk_text?: string;
};

function normalize(value: unknown): string {
  return String(value || '').normalize('NFKC').toLowerCase();
}

function trimLocator(value: string): string {
  return value.trim().replace(/^[`'"([{<]+|[`'"\])}>.,;!?]+$/g, '').trim();
}

function isExplicitLowerHyphenIdentifier(query: string, value: string, offset: number): boolean {
  const normalized = normalize(value);
  const exact = normalize(query.trim()) === normalized;
  const infrastructureSegments = new Set(['gpu', 'vm', 'docker', 'sandbox', 'node', 'worker', 'host']);
  if (exact && normalized.split('-').some(segment => infrastructureSegments.has(segment))) return true;
  const before = query.slice(Math.max(0, offset - 32), offset);
  if (/(?:node|session)(?:\s+id)?\s*[:=]?\s*$/i.test(before)) return true;
  const previous = offset > 0 ? query[offset - 1] : '';
  const next = query[offset + value.length] || '';
  return (previous === '`' && next === '`') || ((previous === '"' || previous === "'") && next === previous);
}

function isMeaningfulLocator(value: string, query: string, offset: number): boolean {
  if (value.length < 4 || value.length > MAX_LOCATOR_LENGTH) return false;
  const normalized = normalize(value);
  if (!normalized || COMMON_TOKENS.has(normalized)) return false;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value) && !isExplicitLowerHyphenIdentifier(query, value, offset)) return false;
  if (/^[a-z]+$/i.test(value) && !/[A-Z].*[A-Z]|[a-z][A-Z]/.test(value)) return false;
  return true;
}

export function extractStrongArchiveLocators(query: string): StrongArchiveLocator[] {
  const bounded = String(query || '').slice(0, MAX_QUERY_LENGTH);
  const candidates: StrongArchiveLocator[] = [];
  const addMatches = (regex: RegExp, strength: number) => {
    for (const match of bounded.matchAll(regex)) {
      const value = trimLocator(match[0]);
      const offset = match.index || 0;
      if (!isMeaningfulLocator(value, bounded, offset)) continue;
      candidates.push({ value, normalized: normalize(value), strength, offset });
    }
  };

  addMatches(/\b[0-9a-fA-F]{7,64}\b/g, 120);
  addMatches(/(?<![\p{L}\p{N}_.-])\/[A-Za-z][\w-]*\s+[A-Za-z][\w-]*/gu, 115);
  addMatches(/(?<![\p{L}\p{N}_.-])\/[A-Za-z][\w-]*/gu, 110);
  addMatches(/[\p{L}\p{N}][\p{L}\p{N}_:./#-]{3,159}/gu, 105);
  addMatches(/\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b/g, 95);
  addMatches(/\b[\p{L}][\p{L}\p{N}]*_[\p{L}\p{N}_]+\b/gu, 95);
  addMatches(/\b\d{4,}\b/g, 80);

  const bestByValue = new Map<string, StrongArchiveLocator>();
  for (const candidate of candidates) {
    const existing = bestByValue.get(candidate.normalized);
    if (!existing || candidate.strength > existing.strength || (candidate.strength === existing.strength && candidate.offset < existing.offset)) {
      bestByValue.set(candidate.normalized, candidate);
    }
  }
  return [...bestByValue.values()]
    .sort((a, b) => b.strength - a.strength || b.value.length - a.value.length || a.offset - b.offset || a.value.localeCompare(b.value))
    .slice(0, MAX_LOCATORS);
}

function queryOverlapTerms(query: string): string[] {
  const bounded = normalize(query).slice(0, MAX_QUERY_LENGTH);
  const terms = new Set<string>();
  for (const match of bounded.matchAll(/[\p{L}\p{N}]{3,}/gu)) {
    const term = match[0];
    if (!COMMON_TOKENS.has(term) && !/^\d{1,3}$/.test(term)) terms.add(term);
  }
  for (const match of bounded.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const run = match[0];
    terms.add(run);
    for (let index = 0; index < run.length - 1; index += 1) terms.add(run.slice(index, index + 2));
  }
  return [...terms].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 12);
}

function scoreCandidate(candidate: ArchiveLexicalCandidate, query: string, locators: StrongArchiveLocator[], terms: string[]): ArchiveLexicalHit | undefined {
  const isBlock = candidate.kind === 'block';
  const text = isBlock ? candidate.record.summary.trim() : formatSubstantiveMessageSearchText(candidate.record.message);
  if (!text) return undefined;
  const normalizedText = normalize(text);
  const matchedLocators = locators.filter(locator => normalizedText.includes(locator.normalized));
  if (matchedLocators.length === 0) return undefined;

  let score = isBlock ? 180 : 80;
  for (const locator of matchedLocators) score += locator.strength + Math.min(80, locator.value.length * 2);
  if (matchedLocators.length === locators.length && locators.length > 1) score += 100;
  const normalizedQuery = normalize(query).slice(0, 500);
  if (normalizedQuery.length >= 4 && normalizedText.includes(normalizedQuery)) score += 180;
  score += Math.min(96, terms.filter(term => normalizedText.includes(term)).length * 12);

  if (isBlock) {
    const record = candidate.record;
    return {
      id: `lex:block:${candidate.sourceSessionId}:${record.id}`,
      kind: 'block',
      session_id: candidate.sourceSessionId,
      agent: record.agent || 'main',
      source_family: `${candidate.sourceSessionId}:block:${record.id}`,
      lexical_score: score,
      lexical_locators: matchedLocators.map(locator => locator.value),
      block_id: record.id,
      block_level: record.level,
      raw_start_seq: record.rawStartSeq,
      raw_end_seq: record.rawEndSeq,
      chunk_text: text.slice(0, 2000),
    };
  }

  const record = candidate.record;
  return {
    id: `lex:raw:${candidate.sourceSessionId}:${record.seq}`,
    kind: 'raw',
    session_id: candidate.sourceSessionId,
    agent: record.agent || 'main',
    source_family: `${candidate.sourceSessionId}:raw:${record.seq}-${record.seq}`,
    lexical_score: score,
    lexical_locators: matchedLocators.map(locator => locator.value),
    start_seq: record.seq,
    end_seq: record.seq,
    raw_start_seq: record.seq,
    raw_end_seq: record.seq,
    chunk_text: text.slice(0, 2000),
  };
}

export async function searchArchiveLexicalSideChannel(sessionId: string, query: string, resultLimit: number = 20): Promise<ArchiveLexicalHit[]> {
  const locators = extractStrongArchiveLocators(query);
  if (locators.length === 0) return [];
  const candidates = await locateEffectiveArchiveCandidatesBySubstring(sessionId, locators.map(locator => locator.value));
  const terms = queryOverlapTerms(query);
  const hits = candidates
    .map(candidate => scoreCandidate(candidate, query, locators, terms))
    .filter((hit): hit is ArchiveLexicalHit => !!hit)
    .sort((a, b) => b.lexical_score - a.lexical_score
      || Number(b.kind === 'block') - Number(a.kind === 'block')
      || String(a.source_family).localeCompare(String(b.source_family)));
  const seen = new Set<string>();
  const result: ArchiveLexicalHit[] = [];
  const limit = Math.max(1, Math.min(MAX_LEXICAL_RESULTS, Math.floor(resultLimit) || 20));
  for (const hit of hits) {
    if (seen.has(hit.source_family)) continue;
    seen.add(hit.source_family);
    result.push(hit);
    if (result.length >= limit) break;
  }
  return result;
}

export function fuseDenseAndLexicalHits(denseHits: any[], lexicalHits: ArchiveLexicalHit[], limit: number): any[] {
  if (lexicalHits.length === 0) return denseHits.slice(0, limit);
  const families = new Map<string, {
    hit: any;
    denseRank?: number;
    lexicalRank?: number;
    lexicalScore?: number;
  }>();
  denseHits.forEach((hit, index) => {
    const family = String(hit.source_family || hit.id || `dense:${index}`);
    if (!families.has(family)) families.set(family, { hit, denseRank: index });
  });
  lexicalHits.forEach((hit, index) => {
    let family = hit.source_family;
    if (hit.kind === 'raw' && typeof hit.raw_start_seq === 'number') {
      const containingDense = denseHits
        .map((denseHit, denseRank) => ({ denseHit, denseRank }))
        .filter(({ denseHit }) => denseHit.kind === 'raw'
          && denseHit.session_id === hit.session_id
          && Number(denseHit.raw_start_seq ?? denseHit.start_seq) <= hit.raw_start_seq!
          && Number(denseHit.raw_end_seq ?? denseHit.end_seq) >= hit.raw_start_seq!)
        .sort((a, b) => {
          const aWidth = Number(a.denseHit.raw_end_seq ?? a.denseHit.end_seq) - Number(a.denseHit.raw_start_seq ?? a.denseHit.start_seq);
          const bWidth = Number(b.denseHit.raw_end_seq ?? b.denseHit.end_seq) - Number(b.denseHit.raw_start_seq ?? b.denseHit.start_seq);
          return aWidth - bWidth || a.denseRank - b.denseRank;
        })[0];
      if (containingDense) family = String(containingDense.denseHit.source_family || containingDense.denseHit.id);
    }
    const existing = families.get(family);
    if (existing) {
      if (existing.lexicalRank === undefined) {
        existing.lexicalRank = index;
        existing.lexicalScore = hit.lexical_score;
        existing.hit = { ...existing.hit, lexical_score: hit.lexical_score, lexical_locators: hit.lexical_locators };
      }
    } else {
      families.set(family, { hit, lexicalRank: index, lexicalScore: hit.lexical_score });
    }
  });

  return [...families.values()]
    .map(entry => {
      const denseContribution = entry.denseRank === undefined ? 0 : 1000 / (entry.denseRank + 1);
      const lexicalContribution = entry.lexicalRank === undefined ? 0 : 1400 / (entry.lexicalRank + 1);
      const sharedBoost = entry.denseRank !== undefined && entry.lexicalRank !== undefined ? 280 : 0;
      return { ...entry, fusedScore: denseContribution + lexicalContribution + sharedBoost };
    })
    .sort((a, b) => b.fusedScore - a.fusedScore
      || (b.lexicalScore || 0) - (a.lexicalScore || 0)
      || (a.denseRank ?? Number.MAX_SAFE_INTEGER) - (b.denseRank ?? Number.MAX_SAFE_INTEGER)
      || String(a.hit.source_family || a.hit.id).localeCompare(String(b.hit.source_family || b.hit.id)))
    .slice(0, Math.max(1, limit))
    .map(entry => entry.hit);
}
