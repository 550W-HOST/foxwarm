export type FoxwarmProcessRole = 'main' | 'vector' | 'session';

export function formatFoxwarmProcessTitle(role: FoxwarmProcessRole, identity?: string): string {
  const normalizedIdentity = identity?.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return normalizedIdentity ? `foxwarm:${role} ${normalizedIdentity}` : `foxwarm:${role}`;
}

export function setFoxwarmProcessTitle(role: FoxwarmProcessRole, identity?: string): void {
  process.title = formatFoxwarmProcessTitle(role, identity);
}