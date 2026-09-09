import type { ConversationSummary } from '@mr-robot/shared';
export type ConversationSpace = 'personal' | 'discord';
export const inConversationSpace = (c: Pick<ConversationSummary, 'origin'>, space: ConversationSpace) => (c.origin === 'discord') === (space === 'discord');
export const selectConversationInSpace = (list: ConversationSummary[], space: ConversationSpace, preferred?: string | null) => {
  const visible = list.filter(c => inConversationSpace(c, space));
  return visible.find(c => c.id === preferred)?.id ?? visible[0]?.id;
};
