export type DemoMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export const demoConversations: Record<string, DemoMessage[]> = {
  'demo-codex': [
    {
      role: 'system',
      content:
        'A fictional conversation that shows the interface. No agent is working in the background.',
    },
    { role: 'user', content: 'Prepare a readable session list for one-handed use.' },
    {
      role: 'assistant',
      content:
        'On this sample screen, questions that need you go to the top. Should finished tasks stay on the list?',
    },
  ],
  'demo-claude': [
    { role: 'system', content: 'Sample conversation. No commands ran and no files changed.' },
    { role: 'user', content: 'Summarize the changes to the terminal screen.' },
    {
      role: 'assistant',
      content:
        'Sample summary: the terminal has a special-key bar, and commands are easy to type in a larger field. Next step: test the keyboard on a phone.',
    },
  ],
  'demo-terminal': [
    {
      role: 'system',
      content:
        'This fictional terminal runs only in app memory. Type help to see the available commands.',
    },
  ],
};
