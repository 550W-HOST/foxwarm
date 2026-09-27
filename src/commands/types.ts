import { ChannelContext } from '../channel';
import type { Session } from '../types';
import type { SessionRuntimeSessionDto } from '../sessionRuntimeService';

export type CommandSession = Session | SessionRuntimeSessionDto;

export function commandSessionMessageCount(session: CommandSession): number {
  return 'messageCount' in session ? session.messageCount : session.history.length;
}

export type CommandDef = {
  description: string
  usage?: string
  requiresSession?: boolean
  showInTelegram?: boolean
  autocomplete?: CommandAutocomplete
  handler: (ctx: ChannelContext, args: string[], sessionId?: string, session?: CommandSession, rawArgs?: string) => Promise<void>
}

export type CommandAutocompleteNode = {
  value: string
  kind?: 'literal' | 'placeholder'
  description?: string
  usage?: string
  insertValue?: string
  children?: CommandAutocompleteNode[]
}

export type CommandAutocomplete = {
  children?: CommandAutocompleteNode[]
}

export function literalNode(value: string, description: string, extras: Partial<CommandAutocompleteNode> = {}): CommandAutocompleteNode {
  return {
    value,
    kind: 'literal',
    description,
    ...extras,
  }
}

export function placeholderNode(value: string, description: string, extras: Partial<CommandAutocompleteNode> = {}): CommandAutocompleteNode {
  return {
    value,
    kind: 'placeholder',
    description,
    ...extras,
  }
}
