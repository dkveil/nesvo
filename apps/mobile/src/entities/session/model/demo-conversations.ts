export type DemoMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export const demoConversations: Record<string, DemoMessage[]> = {
  'demo-codex': [
    {
      role: 'system',
      content: 'Fikcyjna rozmowa pokazująca interfejs. Żaden agent nie pracuje w tle.',
    },
    { role: 'user', content: 'Przygotuj czytelną listę sesji do obsługi jedną ręką.' },
    {
      role: 'assistant',
      content:
        'Na tym przykładowym ekranie pytania wymagające Twojej uwagi trafiają na początek. Czy zakończone zadania mają pozostać na liście?',
    },
  ],
  'demo-claude': [
    { role: 'system', content: 'Przykładowa rozmowa. Nie wykonano poleceń ani zmian w plikach.' },
    { role: 'user', content: 'Podsumuj zmiany w ekranie terminala.' },
    {
      role: 'assistant',
      content:
        'Przykładowe podsumowanie: terminal ma pasek klawiszy specjalnych, a polecenia można wygodnie wpisać w większym polu. Następny krok to test klawiatury na telefonie.',
    },
  ],
  'demo-terminal': [
    {
      role: 'system',
      content:
        'Fikcyjny terminal działa tylko w pamięci aplikacji. Wpisz help, aby zobaczyć dostępne polecenia.',
    },
  ],
};
