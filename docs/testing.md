# Testowanie Pocket Sessions

Ten dokument jest planem testów prototypu. Niezaznaczone przypadki pozostają do wykonania. Działanie w Chromium ani poprawna kompilacja nie oznaczają, że aplikację sprawdzono na fizycznym iPhonie.

## Stan weryfikacji

Sprawdzono osobno lokalny renderer terminala w Chromium: uruchomienie w sandboxowanym iframe, renderowanie wyjścia i ANSI, wejście `pwd` + Enter bez powielania znaków, zmianę rozmiaru, bracketed paste oraz traktowanie ciągu przypominającego HTML jako tekstu.

Sprawdzono osobno silnik demonstracyjny: polecenia, Ctrl+C, backspace, CRLF przekazane w osobnych porcjach, pomijanie sekwencji nawigacji, czyszczenie widoku oraz jawne oznaczenie demo. Te kontrole nie potwierdzają integracji z Rustem ani zachowania natywnego WebView.

| Środowisko                        | Stan                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Renderer w Chromium               | Ograniczony smoke test wykonany                                                                                       |
| Silnik fikcyjnej powłoki          | Smoke test wykonany                                                                                                   |
| Cała aplikacja webowa + host Rust | PASS na Windows / Chromium, 16.10.2026: polecenie w PowerShell, reconnect, odtworzenie, kolejne polecenie, zamknięcie |
| Fizyczny iPhone + Expo Go         | SDK 58 odrzucone przez sklepową wersję Expo Go; ponowna próba po dopasowaniu do SDK 57 do potwierdzenia                  |
| Fizyczny Android + Expo Go        | Do wykonania                                                                                                          |
| iOS development build             | Do wykonania po zbudowaniu                                                                                            |
| TestFlight                        | Brak potwierdzonego wydania                                                                                           |
| LTE/5G przez prywatny VPN         | Do wykonania po konfiguracji                                                                                          |

W pierwszej wersji wykonano także TypeScript, ESLint, Expo Doctor (20/20) i eksport kodu klienta dla iOS, Androida oraz web. Eksport nie jest kompilacją podpisanej aplikacji natywnej. Test autoryzacji klienta odrzuca nagrane uzgadnianie połączenia. Test przeciążenia renderera wysyła 8 MiB przy zatrzymanym potwierdzeniu przetworzenia: najwyżej jeden fragment pozostaje w locie, a ograniczony bufor sygnalizuje pominięcie starych danych.

Po zmianie wyglądu ponownie sprawdzono listę, filtrowanie, wyszukiwanie, demo rozmowy, tworzenie sesji, wejście terminala, menu boczne i walidację parowania w Chromium przy szerokości 390 px. Ponowny test prawdziwego hosta Rust na Windowsie przeszedł wykonanie polecenia, rozłączenie i ponowne połączenie, odtworzenie wyjścia oraz zamknięcie. Eksport klienta iOS i Android również przeszedł. Wyniki nie potwierdzają jeszcze zachowania na fizycznym telefonie.

Po zgłoszeniu niezgodności Expo Go dopasowano cały klient do SDK 57, zgodnego z wersją 57.0.9 dostępną w polskim App Store 16.10.2026. Sprawdzono `expo install --check`, Expo Doctor (21/21), TypeScript, ESLint, testy przeglądarkowe i połączenie z prawdziwym hostem Rust. Manifest serwera dla iOS zwraca `sdkVersion: 57.0.0` oraz `runtimeVersion: exposdk:57.0.0`, a wskazany pakiet startowy iOS jest dostępny (HTTP 200). To potwierdza naprawę konfiguracji serwera, ale uruchomienie na telefonie nadal wymaga ponownego testu użytkownika.

Powtarzalne testy przeglądarkowe (najpierw uruchom `npm run web` w drugim terminalu):

```powershell
npx playwright install chromium
npm run test:web
npm run test:terminal
cargo build --manifest-path host/Cargo.toml
npm run test:live
```

`APP_URL` zmienia domyślny adres `http://localhost:8081`. Opcjonalne `PLAYWRIGHT_CHROMIUM_EXECUTABLE` wskazuje istniejący plik wykonywalny Chrome/Chromium. Test live uruchamia własny host na losowym porcie, tworzy testowe powłoki i zamyka je po teście. Pliki parowania i zrzuty trafiają do ignorowanego `artifacts/`.

Testy protokołu:

```powershell
npm run test:client
cargo test --manifest-path host/Cargo.toml
npm run test:host
```

## Przygotowanie

1. Zapisz commit lub datę testowanej wersji, model telefonu, wersję systemu, wersję Expo Go i system hosta.
2. Zainstaluj zależności klienta: `npm install`.
3. Uruchom `npx tsc --noEmit` oraz `cargo test --manifest-path host/Cargo.toml`. Zapisz rzeczywiste wyniki; obecność tej instrukcji nie oznacza ich zaliczenia.
4. W jednym terminalu uruchom `npm start`. Na iPhonie otwórz aplikację z kodu Expo.
5. W drugim terminalu uruchom `cargo run --manifest-path host/Cargo.toml -- --lan --workspace "C:\Users\Damian\dev"`, używając istniejącego katalogu własnego komputera.
6. Zapewnij dostęp telefonu do adresu hosta. Na pierwszą próbę użyj tego samego Wi-Fi i aktywnego komputera.
7. W aplikacji zeskanuj kod **hosta Pocket Sessions**. To inny kod niż QR Expo.

Nie umieszczaj kodu parowania ani jego klucza w nagraniu lub raporcie. Wystarczy wynik połączenia oraz adres hosta bez sekretu.

## Podstawowy test na fizycznym iPhonie

| Przypadek            | Czynność                                                  | Oczekiwany wynik                                                             | Wynik |
| -------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- | ----- |
| Uruchomienie         | Otwórz projekt w Expo Go                                  | Ekran nie jest przycięty przez wycięcie i dolny obszar systemu               | ☐     |
| Demo                 | Otwórz przykładową rozmowę i terminal                     | Demo jest wyraźnie oznaczone; nic nie sugeruje aktywnego połączenia z AI     | ☐     |
| Aparat               | Otwórz skaner i przyznaj dostęp                           | QR hosta prowadzi do połączenia bez wielokrotnych prób dla jednego skanu     | ☐     |
| Brak aparatu         | Odmów dostępu, wróć do formularza                         | Dostępna jest czytelna informacja i ręczne wklejenie kodu                    | ☐     |
| Błędne parowanie     | Wklej niepełny JSON lub niewłaściwy klucz                 | Aplikacja pokazuje błąd; nie tworzy sesji                                    | ☐     |
| Nowa sesja           | Utwórz sesję po podłączeniu                               | Pojawia się prawdziwa powłoka hosta i katalog zgodny z workspace             | ☐     |
| Pole polecenia       | Wyślij `echo POCKET_PHONE_1` osobnym polem                | Polecenie wykonuje się dokładnie raz                                         | ☐     |
| Klawiatura terminala | Dotknij terminala i wpisz `pwd` + Enter                   | Klawiatura się otwiera; brak pomijania albo powielania znaków                | ☐     |
| Edycja               | Wpisz omyłkę, użyj backspace i popraw ją                  | Ostateczna treść zgadza się z wpisaną komendą                                | ☐     |
| Polskie znaki        | Wpisz `echo Zażółć gęślą jaźń`                            | Unicode jest czytelny i nie uszkadza kolejnych wierszy                       | ☐     |
| Klawisze pomocnicze  | Sprawdź strzałki historii i Tab w obsługującej je powłoce | Klawisze trafiają do powłoki jako sterowanie                                 | ☐     |
| Ctrl+C               | Przerwij nieszkodliwe dłuższe polecenie, np. lokalny ping | Polecenie się zatrzymuje; powłoka pozostaje dostępna                         | ☐     |
| Schowanie klawiatury | Zamknij i otwórz klawiaturę kilka razy                    | Terminal zmienia rozmiar; pole wejścia pozostaje osiągalne                   | ☐     |
| Obrót                | Obróć telefon podczas pracy                               | Terminal otrzymuje nowy rozmiar; można dalej wpisywać                        | ☐     |
| Schowek              | Wklej krótki tekst, następnie tekst wielowierszowy        | Tekst zachowuje treść; zachowanie Entera zależy od aktywnej powłoki/programu | ☐     |
| Zaznaczanie          | Zaznacz fragment wyjścia i spróbuj skopiować              | Można skopiować właściwy tekst bez przypadkowego wysłania polecenia          | ☐     |
| Historia             | Wygeneruj wiele nieszkodliwych wierszy i przewiń          | Przewijanie jest płynne, a widok pozwala wrócić do bieżącego wyjścia         | ☐     |
| VoiceOver            | Otwórz listę i terminal z aktywnym VoiceOver              | Przyciski mają etykiety; można znaleźć pole wejścia i wrócić do listy        | ☐     |

Wynik „wymaga poprawki” dla zaznaczania, klawiatury czy przewijania jest ważnym wynikiem prototypu. To kryteria oceny renderera WebView, nie funkcje uznane za gotowe bez testu na urządzeniu.

## Wiele sesji i powrót do pracy

| Przypadek             | Czynność                                                        | Oczekiwany wynik                                                               | Wynik |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----- |
| Dwie sesje            | Utwórz A i B; w każdej wypisz inne oznaczenie                   | Każda ma własny proces i wyjście                                               | ☐     |
| Przełączanie          | Wróć do listy i kilka razy przełącz A / B                       | Wyjście i polecenia nie trafiają do niewłaściwej sesji                         | ☐     |
| Powrót po rozłączeniu | Rozłącz klienta, zostaw host aktywny, połącz ponownie           | Istniejące sesje pozostają na liście i można do nich dołączyć                  | ☐     |
| Praca w tle           | Uruchom nieszkodliwe polecenie, zablokuj telefon na minutę      | Host może kontynuować pracę; po powrocie odtwarza się dostępna historia        | ☐     |
| Brak sieci            | Wyłącz Wi-Fi przy braku alternatywnej trasy                     | Aplikacja sygnalizuje rozłączenie; nie obiecuje wysłania komendy               | ☐     |
| Bez powtórzeń         | Podczas braku sieci spróbuj wysłać oznaczenie, następnie połącz | Niewysłane wejście nie wykonuje się automatycznie po powrocie                  | ☐     |
| Zakończenie           | Zamknij A przez potwierdzenie zakończenia                       | A kończy proces; B pozostaje aktywna                                           | ☐     |
| Wyjście powłoki       | Wpisz `exit` w jednej sesji                                     | Stan sesji wskazuje zakończenie; reszta aplikacji działa                       | ☐     |
| Restart hosta         | Zatrzymaj host, uruchom ponownie                                | Poprzednie procesy nie są przedstawiane jako nadal aktywne                     | ☐     |
| Uśpienie komputera    | Uśpij host i spróbuj się połączyć                               | Brak dostępnego hosta jest czytelny; aplikacja nie deklaruje kontynuacji pracy | ☐     |

Powrót do terminala odtwarza ograniczoną historię tekstową, a nie pełny snapshot programu. Osobno odnotuj potrzebę odświeżenia ekranu w aplikacjach pełnoekranowych.

## Narzędzia agentowe

- [ ] Uruchom wcześniej zainstalowane `codex` lub `claude` z terminala hosta.
- [ ] Sprawdź istniejące logowanie użytkownika albo przejdź oryginalny proces logowania danego narzędzia.
- [ ] Wyślij małe zadanie i sprawdź czytelność wyjścia oraz obsługę pytań w terminalu.
- [ ] Przejdź do drugiej sesji, wróć i sprawdź ciągłość pracy.
- [ ] Potwierdź, że Pocket Sessions nie wymaga klucza API i nie wyświetla fikcyjnej rozmowy jako wyniku aktywnego agenta.

Test wykorzystuje rzeczywiste limity własnego konta. Nie zakłada automatyzacji logowania ani zgodności każdej wersji CLI.

## Osobne testy platformowe

- [ ] Android: powtórz parowanie, klawiaturę, wklejanie, przycisk systemowy Wstecz, obrót i reconnect.
- [ ] Przeglądarka: sprawdź ręczne wklejenie kodu, zmianę rozmiaru i brak zachowania parowania po przeładowaniu strony.
- [ ] Natywny klient: po ponownym otwarciu sprawdź odczyt parowania z SecureStore oraz możliwość usunięcia połączenia.
- [ ] Mac/Linux jako host: osobno zweryfikuj tworzenie i zamykanie procesów, Unicode, sygnały i resize PTY.
- [ ] Prywatny VPN: dopiero po jego konfiguracji przetestuj iPhone na LTE/5G oraz powrót na Wi-Fi. Brak tego testu oznacza niezweryfikowany dostęp spoza LAN.
- [ ] Development build / TestFlight: powtórz podstawową macierz na zbudowanej aplikacji; wynik Expo Go nie obejmuje podpisywania, instalacji ani konfiguracji wydania.

## Raport z testu

```text
Wersja / commit:
Data:
Telefon i system:
Expo Go / development build / TestFlight:
System hosta:
Sieć: LAN / VPN / inne
Przypadek:
Kroki:
Oczekiwany wynik:
Wynik rzeczywisty:
Czy problem się powtarza:
Załącznik bez kodu parowania i prywatnej treści terminala:
```
