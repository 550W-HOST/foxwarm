export type LexicalFusionHit = {
  id: string;
  kind: 'raw' | 'block';
  session_id: string;
  agent: string;
  source_family: string;
  lexical_score?: number;
  lexical_locators?: string[];
  lexical_lane?: 'identifier' | 'prose';
  lexical_rank?: number;
  start_seq?: number;
  end_seq?: number;
  raw_start_seq?: number;
  raw_end_seq?: number;
  block_id?: number;
  block_level?: number;
};

function containingDenseFamily(denseHits: any[], hit: LexicalFusionHit): string | undefined {
  if (hit.kind !== 'raw' || typeof hit.raw_start_seq !== 'number') return undefined;
  const containing = denseHits
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
  return containing ? String(containing.denseHit.source_family || containing.denseHit.id) : undefined;
}

export function fuseDenseAndLexicalHits(denseHits: any[], lexicalHits: LexicalFusionHit[], limit: number): any[] {
  if (lexicalHits.length === 0) return denseHits.slice(0, limit);
  const families = new Map<string, {
    hit: any;
    denseRank?: number;
    lexicalRank?: number;
    lexicalScore?: number;
    lane?: 'identifier' | 'prose';
  }>();
  denseHits.forEach((hit, index) => {
    const family = String(hit.source_family || hit.id || `dense:${index}`);
    if (!families.has(family)) families.set(family, { hit, denseRank: index });
  });
  lexicalHits.forEach((hit, index) => {
    const family = containingDenseFamily(denseHits, hit) || hit.source_family;
    const existing = families.get(family);
    const lane = hit.lexical_lane || 'identifier';
    if (existing) {
      if (existing.lexicalRank === undefined) {
        existing.lexicalRank = hit.lexical_rank ?? index;
        existing.lexicalScore = hit.lexical_score;
        existing.lane = lane;
        existing.hit = {
          ...existing.hit,
          lexical_score: hit.lexical_score,
          lexical_locators: hit.lexical_locators,
          lexical_lane: lane,
        };
      }
    } else {
      families.set(family, { hit, lexicalRank: hit.lexical_rank ?? index, lexicalScore: hit.lexical_score, lane });
    }
  });

  const ranked = [...families.values()]
    .map(entry => {
      const denseContribution = entry.denseRank === undefined ? 0 : 1000 / (entry.denseRank + 1);
      const laneWeight = entry.lane === 'prose' ? 350 : 1200;
      const lexicalContribution = entry.lexicalRank === undefined ? 0 : laneWeight / (entry.lexicalRank + 1);
      const sharedBoost = entry.denseRank !== undefined && entry.lexicalRank !== undefined ? 180 : 0;
      return { ...entry, fusedScore: denseContribution + lexicalContribution + sharedBoost };
    })
    .sort((a, b) => b.fusedScore - a.fusedScore
      || (a.denseRank ?? Number.MAX_SAFE_INTEGER) - (b.denseRank ?? Number.MAX_SAFE_INTEGER)
      || (b.lexicalScore || 0) - (a.lexicalScore || 0)
      || String(a.hit.source_family || a.hit.id).localeCompare(String(b.hit.source_family || b.hit.id)))
    .map(entry => entry.hit);
  const selected: any[] = [];
  const deferred: any[] = [];
  const overlaps = (a: any, b: any): boolean => {
    if (a.session_id !== b.session_id) return false;
    const aStart = Number(a.raw_start_seq ?? a.start_seq);
    const aEnd = Number(a.raw_end_seq ?? a.end_seq);
    const bStart = Number(b.raw_start_seq ?? b.start_seq);
    const bEnd = Number(b.raw_end_seq ?? b.end_seq);
    if (![aStart, aEnd, bStart, bEnd].every(Number.isFinite)) return false;
    const intersection = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart) + 1);
    const smaller = Math.max(1, Math.min(aEnd - aStart + 1, bEnd - bStart + 1));
    return intersection / smaller >= 0.6;
  };
  for (const hit of ranked) {
    if (selected.some(existing => overlaps(existing, hit))) deferred.push(hit);
    else selected.push(hit);
  }
  return [...selected, ...deferred].slice(0, Math.max(1, limit));
}
