# Pocket Sessions

Nazwa robocza repozytorium. W aplikacji używamy tymczasowo „Sesje”; docelowa nazwa zostanie wybrana później. [Kierunek nowego interfejsu](docs/design.md).

Terminal z Twojego komputera, dostępny z telefonu. Jeden klient Expo / React Native dla iOS, Androida i podglądu webowego oraz mały host w Rust, który uruchamia powłoki na komputerze.

To wczesny prototyp. Ekrany demonstracyjne są oznaczone jako **DEMO**; przykładowe rozmowy nie są odpowiedziami modeli. Pierwszym działającym przepływem jest połączenie z hostem i praca w prawdziwym terminalu.

[Architektura i diagram](docs/architecture.md) · [Wyniki i plan testów](docs/testing.md) · [Bezpieczeństwo](SECURITY.md)

## Co jest dostępne

- Lista wielu sesji terminalowych, tworzenie, dołączanie i kończenie sesji.
- Prawdziwe procesy powłoki przez PTY na komputerze; telefon przesyła wejście i wyświetla wyjście.
- Terminal xterm.js z obsługą sekwencji ANSI, klawiatury i zmiany rozmiaru. Kod renderera jest dołączony do aplikacji, bez CDN.
- Pasek klawiszy specjalnych oraz osobne pole do wpisania polecenia.
- Parowanie przez QR lub kod JSON i szyfrowane komunikaty WebSocket.
- Sesje pozostające na hoście po odłączeniu telefonu, dopóki działa proces hosta i komputer.
- Demo interfejsu, które można uruchomić bez hosta, konta AI i połączenia z modelem.

Zwykłe polecenia, takie jak `ls`, `pwd`, Git czy narzędzia developerskie, wykonują się na komputerze. Jeśli masz zainstalowane Claude Code lub Codex CLI, możesz uruchomić je w terminalu i skorzystać z oryginalnego logowania. Aplikacja nie potrzebuje klucza API do AI i nie wywołuje modeli w Twoim imieniu. Dostępność narzędzia i limity nadal wynikają z Twojego konta u dostawcy.

## Uruchomienie na Windowsie

Potrzebujesz Node.js z npm oraz stabilnego Rusta z Cargo. Kompilacja hosta na Windowsie wymaga także narzędzi C++ dla używanego toolchainu Rust. Android Studio i Xcode nie są potrzebne do podglądu webowego ani otwarcia aplikacji w Expo Go na fizycznym telefonie.

Z katalogu repozytorium:

```powershell
npm install
npm start
```

Na iPhonie zainstaluj Expo Go i zeskanuj kod wyświetlany przez Expo. Komputer oraz telefon powinny mieć łączność w sieci lokalnej. Projekt używa **Expo SDK 57**, zgodnego z Expo Go 57 dostępnym w App Store w chwili przygotowania podglądu (16.10.2026).

Na fizycznym iPhonie Expo Go wymaga też **tego samego konta Expo na telefonie i w CLI**. Zaloguj komputer poleceniem `npx expo login --browser` (obsługuje GitHub), a następnie zaloguj się do tego samego konta w Expo Go przez ikonę profilu. Sprawdź konto CLI przez `npx expo whoami`. Potem wybierz „Try again” na telefonie; po zmianie konta uruchom serwer podglądu ponownie. [Wymaganie logowania Expo](https://docs.expo.dev/troubleshooting/expo-go-sign-in-required/).

Jeżeli na Windowsie automatyczne otwarcie przeglądarki kończy się błędem `cmd /c start`, uruchom logowanie bez automatycznego otwierania i otwórz wypisany adres ręcznie **na tym samym komputerze**. Pozostaw terminal działający do zakończenia logowania:

```powershell
$env:BROWSER = 'none'
npx expo login --browser
Remove-Item Env:BROWSER
```

Logowanie i ewentualne 2FA odbywają się na stronie dostawcy. Nie wpisuj haseł, kodów 2FA ani tokenów do plików projektu.

Najnowsze SDK i najnowsza aplikacja Expo Go w sklepie mogą mieć różne wersje. [Informacja o wydaniu SDK 58](https://expo.dev/changelog/sdk-58#expo-go) zapowiada aktualizację sklepowej aplikacji dopiero w kolejnych tygodniach. Przed zmianą głównej wersji SDK sprawdź zgodność z wersją Expo Go na telefonie. Samo wpisanie starszego `sdkVersion` w konfiguracji nie zapewnia zgodności — cały zestaw natywnych zależności musi odpowiadać SDK.

Podgląd w przeglądarce na komputerze:

```powershell
npm run web
```

Podgląd webowy przydaje się do pracy nad ekranami i komunikacją. Nie potwierdza poprawnego działania klawiatury, schowka, aparatu ani WebView na iPhonie.

### Podłączenie prawdziwego terminala

W osobnym oknie PowerShell uruchom hosta. Podaj katalog, w którym chcesz rozpoczynać sesje:

```powershell
cargo run --manifest-path host/Cargo.toml -- --lan --workspace "C:\Users\Damian\dev"
```

Pierwsze uruchomienie kompiluje zależności Rusta, więc potrwa dłużej. `--lan` udostępnia host w sieci; telefon musi mieć dostęp do wskazanego adresu i portu, również przez zaporę Windows. Zobacz [instrukcję hosta](host/README.md), aby sprawdzić jego opcje.

W aplikacji otwórz parowanie, zeskanuj QR hosta lub wklej jego kod JSON. Następnie utwórz sesję terminalową i wpisz `pwd` albo `ls`.

**Są dwa różne kody QR:** kod Expo otwiera aplikację deweloperską, a kod Pocket Sessions daje jej dostęp do terminala komputera. Samo otwarcie aplikacji w Expo Go nie paruje hosta.

Wróć strzałką do listy, aby pozostawić sesję działającą. Zakończenie sesji zatrzymuje jej proces. Rozłączenie telefonu pozostawia procesy na hoście, lecz restart hosta lub komputera kończy tę ciągłość. Powrót odtwarza ograniczony fragment historii wyjścia; nie jest pełnym zapisem stanu każdego programu pełnoekranowego.

### Dostęp poza domem

Pierwsza ścieżka testowa to wspólna sieć LAN. Prywatny VPN, np. samodzielnie skonfigurowany Tailscale, może zapewnić osiągalność hosta poza tą siecią. Nie ma jeszcze automatycznej konfiguracji VPN ani własnego przekaźnika połączeń. Wydanie nie obejmuje zweryfikowanego scenariusza pracy przez LTE/5G.

## iPhone, development build i TestFlight

Pierwsze testy mają odbywać się w **Expo Go na fizycznym iPhonie**. Obecny renderer terminala wykorzystuje `react-native-webview`; dodanie własnego modułu natywnego będzie wymagało development buildu.

Samodzielny development build i wersję TestFlight można później kompilować w EAS na serwerach macOS, pracując na Windowsie. Dystrybucja przez TestFlight wymaga konta Apple Developer oraz konfiguracji podpisywania i App Store Connect. Projekt nie zawiera jeszcze potwierdzonego wydania TestFlight ani wyników testu na fizycznym iPhonie.

Szczegółowa [macierz testów](docs/testing.md) oddziela sprawdzenie w przeglądarce od testów na urządzeniu. Instrukcje dostawcy: [Expo Go](https://docs.expo.dev/get-started/start-developing/), [development builds](https://docs.expo.dev/develop/development-builds/introduction/), [przesyłanie iOS przez EAS](https://docs.expo.dev/submit/ios/).

## Granice prototypu

- Host tworzy własne sesje. Nie przejmuje dowolnego terminala uruchomionego wcześniej w innym programie.
- Brakuje jeszcze klienta SSH i katalogu połączeń z VPS-ami. Samodzielny host na zdalnej maszynie to odrębna konfiguracja.
- Widok rozmowy agenta jest demonstracją. Aktywny Claude Code lub Codex działa na razie w terminalu, bez natywnej historii rozmowy, zgód i przeglądu zmian.
- Nie ma lokalnego środowiska wykonywania Claude Code / Codex na iPhonie.
- Host nie uruchamia modeli, nie loguje użytkownika do ich usług i nie zarządza abonamentami.
- Komputer musi być włączony i aktywny. Sesje nie przetrwają restartu hosta.
- Nie ma jeszcze gotowych instalatorów i wydanych samodzielnych binarek hosta. Dzisiaj host buduje się przez Cargo.

## Parowanie i dane

Kod parowania zawiera współdzielony sekret dający dostęp do powłoki z uprawnieniami użytkownika hosta. To wielokrotnego użytku poświadczenie, nie jednorazowe zaproszenie. Nie dodawaj go do zgłoszeń, zrzutów ekranu ani repozytorium. Katalog `.local`, w którym host zapisuje lokalne dane parowania, jest pomijany przez Git.

Polecenia i wyjście są szyfrowane oraz uwierzytelniane mechanizmem secretbox. Wersja przeglądarkowa przechowuje parowanie wyłącznie w pamięci strony, a aplikacja natywna korzysta z SecureStore. To prototyp bez niezależnego audytu bezpieczeństwa i bez gotowej infrastruktury do publicznego wystawienia portu hosta; obecna ścieżka to sieć lokalna lub prywatny VPN.

`--workspace` wskazuje katalog początkowy powłoki. Nie tworzy sandboxa ograniczającego uprawnienia poleceń.

## Kod

```text
src/app/                trasy Expo Router: sesje, hosty, ustawienia i terminal
src/state/AppState.tsx   współdzielony stan i połączenie utrzymywane między trasami
src/AppRoot.tsx          wspólny wygląd ekranów i modale
src/                    pozostałe widoki, połączenie z hostem i jawne demo
src/terminal/           lokalny renderer xterm.js: WebView / iframe
scripts/build-terminal.mjs
                        generowanie zasobu HTML terminala
host/                   host Rust i procesy PTY przez portable-pty
docs/testing.md         plan weryfikacji, w tym fizyczny iPhone
```

Po zmianach w źródłach renderera odtwórz jego zasób:

```powershell
node scripts/build-terminal.mjs
```

Sprawdzenie typów klienta i testy hosta:

```powershell
npx tsc --noEmit
cargo test --manifest-path host/Cargo.toml
```

Zasady zmian: [CONTRIBUTING.md](CONTRIBUTING.md). Licencja: [MIT](LICENSE). Projekt korzysta także z bibliotek na ich własnych licencjach; źródła i noty bibliotek pozostają w zależnościach oraz wygenerowanym zasobie terminala.
