# Kierunek interfejsu

Aktualizacja 16.10.2026 po pierwszym podglądzie. Nazwa produktu nie została wybrana. W interfejsie i nazwie aplikacji używamy tymczasowo „Sesje”; identyfikatory pakietów, hosta i repozytorium pozostają bez migracji.

Punktem odniesienia jest czarny interfejs mobilnego ChatGPT oraz mobilne podglądy [Orca](https://www.onorca.dev/#mobile). Własna implementacja Expo / React Native, bez kopiowania ich kodu, logo czy zasobów.

- Tło `#0B0B0B`, powierzchnie `#191919`, dymki i zaznaczenia `#242424`. Biel dla głównych działań, szarości dla opisu. Kolor tylko dla informacji wymagającej uwagi, błędów i składni terminala.
- Systemowa typografia telefonu. Treść rozmowy 16/26, tytuły wierszy 16, opisy 14. Brak dekoracyjnych wersalików i kolorowych kart agentów.
- Główna lista jako płaskie wiersze: temat, ostatnia aktywność, agent i projekt. Wyszukiwanie oraz filtr wymagających uwagi.
- Menu boczne: sesje, komputery i ustawienia; skróty do ostatnich sesji. Przycisk tworzenia nowej sesji dostępny także na dole ekranu.
- Rozmowa: dymek użytkownika po prawej, odpowiedź na płaskim tle, zaokrąglone pole wiadomości i okrągłe wysyłanie.
- Terminal: zwarty nagłówek, duży obszar wyjścia, pasek klawiszy specjalnych i pole polecenia. Prawdziwe sesje nadal używają PTY hosta Rust.
- Parowanie: dwa krótkie kroki, główne działanie skanowania QR i możliwość wklejenia kodu.

Widok rozmowy jest demonstracyjny i jest tak opisany w aplikacji. Nie sugeruje działającej integracji z modelem AI. Zmiana wyglądu nie dodaje połączeń z API modeli ani nie zmienia sposobu logowania w oryginalnych CLI.

Podglądy i testy przeglądarkowe nie zastępują sprawdzenia klawiatury, obszarów bezpiecznych oraz kamery na fizycznym telefonie.
