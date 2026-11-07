import type { PreviewSession } from '@/entities/session';

export const demoSessions: PreviewSession[] = [
  {
    id: 'contact-plan',
    title: 'Formularz zgłoszeń',
    provider: 'Claude Code',
    model: 'Opus',
    role: 'orchestrator',
    status: 'review',
    directory: '~/projects/contact-app',
    messages: [
      {
        id: 'request',
        author: 'operator',
        body: 'Przygotuj formularz zgłoszeń z walidacją adresu e-mail. Podziel pracę na implementację i przegląd dostępności. Chcę odebrać każdy wynik przed zakończeniem zadania.',
      },
      {
        id: 'plan',
        author: 'agent',
        body: 'Podzieliłem zakres na dwa zadania:\n\n1. Formularz i walidacja: pola, komunikaty błędów i stan wysyłania.\n2. Przegląd dostępności: etykiety, obsługa klawiaturą i kolejność fokusu.\n\nKażdy worker ma osobną sesję. Ich rozmowy i zakres pracy znajdziesz w drzewie delegacji.',
      },
      {
        id: 'result',
        author: 'agent',
        body: 'Pierwszy wynik czeka na Twój odbiór. Drugi worker prosi o zgodę przed uruchomieniem sprawdzenia. Możesz otworzyć każdą sesję i zobaczyć jej kontekst.',
      },
    ],
  },
  {
    id: 'contact-form',
    parentId: 'contact-plan',
    title: 'Formularz i walidacja',
    provider: 'Codex',
    model: 'Codex',
    role: 'worker',
    status: 'review',
    directory: '~/projects/contact-app',
    messages: [
      {
        id: 'scope',
        author: 'operator',
        body: 'Zaimplementuj formularz zgłoszeń. Zakres: pola imię, e-mail i treść, walidacja oraz czytelne komunikaty. Nie zmieniaj pozostałych ekranów.',
      },
      {
        id: 'delivered',
        author: 'agent',
        body: 'Formularz jest gotowy do przeglądu. Dodałem etykiety pól, walidację e-mail i komunikat po wysłaniu. Podsumowanie i przykładowe zmiany znajdują się w skrzynce do odbioru.',
      },
    ],
  },
  {
    id: 'accessibility',
    parentId: 'contact-plan',
    title: 'Przegląd dostępności',
    provider: 'Claude Code',
    model: 'Sonnet',
    role: 'worker',
    status: 'approval',
    directory: '~/projects/contact-app',
    messages: [
      {
        id: 'scope',
        author: 'operator',
        body: 'Sprawdź etykiety, komunikaty błędów i obsługę formularza samą klawiaturą. Najpierw przedstaw plan sprawdzenia.',
      },
      {
        id: 'permission',
        author: 'agent',
        body: 'Sprawdzę kolejność fokusu oraz powiązanie etykiet i błędów z polami. Przed uruchomieniem lokalnego podglądu potrzebuję Twojej zgody.',
      },
    ],
  },
  {
    id: 'project-plan',
    title: 'Plan strony projektu',
    provider: 'Codex',
    model: 'Domyślny model',
    role: 'standalone',
    status: 'planning',
    directory: '',
    messages: [
      {
        id: 'request',
        author: 'operator',
        body: 'Pomóż mi zaplanować prostą stronę projektu. Na razie pracujemy nad zakresem, bez plików i repozytorium.',
      },
      {
        id: 'plan',
        author: 'agent',
        body: 'Proponuję zacząć od odbiorcy, głównego komunikatu i jednej akcji, którą użytkownik ma wykonać. Następnie ułożymy strukturę strony.',
      },
    ],
  },
];

export const demoReview = {
  id: 'form-result',
  sessionId: 'contact-form',
  title: 'Formularz zgłoszeń z walidacją',
  summary:
    'Trzy pola formularza, walidacja adresu e-mail oraz komunikaty błędów powiązane z polami.',
  files: [
    'src/features/contact/contact-form.tsx',
    'src/features/contact/validation.ts',
  ],
  diff: [
    ' src/features/contact/contact-form.tsx',
    ' ',
    '+ <Label htmlFor="email">Adres e-mail</Label>',
    '+ <Input',
    '+   id="email"',
    '+   type="email"',
    '+   required',
    '+   aria-describedby="email-error"',
    '+ />',
    '+ <p id="email-error" role="alert">{error}</p>',
  ].join('\n'),
};
