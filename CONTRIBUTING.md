# Współtworzenie Pocket Sessions

Projekt jest na etapie prototypu. Najbardziej przydatne zmiany poprawiają prawdziwą pracę w terminalu: klawiaturę na telefonie, ciągłość sesji, poprawną komunikację z hostem i czytelne stany połączenia.

## Środowisko

Przeczytaj [README](README.md) i lokalne [AGENTS.md](AGENTS.md). Klient używa Expo 57 / React Native, a host jest osobnym programem w Rust. Zacznij od `npm install`; host kompiluj przez Cargo z katalogu `host/`.

Biblioteki związane z Expo instaluj przez `npx expo install`, aby zachować zgodność z SDK. Przed zmianą API sprawdzaj dokumentację odpowiedniej wersji. Nie dopisuj ręcznie wygenerowanych projektów `ios/` i `android/`; konfiguracja natywna należy do konfiguracji Expo i odpowiednich pluginów.

## Zakres zmian

- Oddziel kod klienta, protokół połączenia i wykonanie poleceń na hoście.
- Zachowaj jasny podział między demonstracją a rzeczywistą sesją. Przykładowe rozmowy muszą mieć oznaczenie demo.
- Nie wprowadzaj wymaganego klucza API do AI. Uruchamiane CLI zachowują własny mechanizm logowania użytkownika.
- Nie zapisuj kodów parowania, kluczy ani prywatnego wyjścia terminala w repozytorium, logach diagnostycznych i zgłoszeniach.
- Przy zmianie protokołu aktualizuj obie strony i sprawdź odrzucanie nieprawidłowych komunikatów.
- Nie ponawiaj automatycznie wejścia terminala po zerwaniu połączenia. Podwójne wykonanie polecenia jest zmianą zachowania, nie niewinnym retry.
- Nie edytuj ręcznie `src/terminal/generated.ts`. Zmień źródła renderera i uruchom `node scripts/build-terminal.mjs`.

## Sprawdzenie przed PR

Uruchom sprawdzenie typów i testy odpowiednie dla zmiany:

```powershell
npx tsc --noEmit
cargo test --manifest-path host/Cargo.toml
```

Uruchom także lint klienta zgodnie ze skryptami repozytorium; komenda Expo to `npx expo lint`. Jeśli narzędzie proponuje instalację lub konfigurację, potraktuj ją jako osobną zmianę w zależnościach i sprawdź powstały diff.

Zmiany w terminalu sprawdzaj z rzeczywistym hostem. Zmiany klawiatury, WebView, schowka, aparatu i układu przy otwartej klawiaturze wymagają fizycznego telefonu. Skorzystaj z [macierzy testów](docs/testing.md) i podaj, które przypadki rzeczywiście wykonano. Nie opisuj testu webowego jako testu iOS.

## Commity i pull requesty

Używaj tematów conventional commit, np. `fix: preserve terminal input after resize`. Opis PR powinien krótko wyjaśniać problem, efekt zmiany i wykonaną weryfikację. Wskaż również testy na urządzeniu, które pozostały do wykonania.

Commity i opisy PR nie zawierają podpisów AI, dopisków `Co-Authored-By: Codex`, stopki „Generated with Codex” ani linków `Codex-Session`.

## Zgłoszenia

Przy błędzie podaj wersję aplikacji, system hosta, model telefonu, wersję systemu oraz krótkie kroki odtworzenia. Usuwaj z załączników klucze parowania i prywatne dane. W przypadku problemu z bezpieczeństwem nie publikuj działającego klucza ani danych umożliwiających dostęp do hosta; najpierw skontaktuj się prywatnie z opiekunem projektu.

Wkład w projekt jest udostępniany na jego [licencji MIT](LICENSE).
