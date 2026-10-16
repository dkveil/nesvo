# Bezpieczeństwo prototypu

Host daje dostęp do powłoki z uprawnieniami użytkownika, który go uruchomił. `--workspace` ustawia katalog początkowy, nie jest sandboxem. Używaj prototypu w zaufanej sieci lokalnej lub prywatnej sieci VPN. Nie udostępniaj publicznie portu hosta.

Kod QR / JSON zawiera współdzielony klucz dostępu do terminala. Nie publikuj go, plików `.local/`, zrzutów kodu ani nagrań ekranu parowania. „Zapomnij host” usuwa zapis w aplikacji; nie unieważnia kodu na komputerze. Zasady generowania i wymiany klucza opisuje `host/README.md`.

Treść poleceń i wyjścia jest szyfrowana za pomocą XSalsa20-Poly1305 (secretbox). Protokół obejmuje losowe wyzwanie połączenia, kierunek wiadomości i sekwencję. Nie zapewnia ukrycia adresów, rozmiarów i czasu ruchu ani forward secrecy. Nie przeszedł niezależnego audytu. Skanujący musi zweryfikować, że kod pochodzi z jego komputera.

Transport prototypu to WebSocket z szyfrowaniem treści. Android dopuszcza `ws://` przez `usesCleartextTraffic`; iOS ma wyjątek dla sieci lokalnej. Renderer terminala nie łączy się z hostem bezpośrednio, nie ładuje CDN i ma osobną restrykcyjną politykę CSP. Przed publiczną usługą potrzebne są TLS, cykl życia urządzeń i kluczy, limity nadużyć oraz audyt protokołu.

Na telefonie sekret trafia do SecureStore. W przeglądarce pozostaje tylko w pamięci. Nie umieszczamy go w URL, localStorage ani logach. Wyjście terminala może zawierać wrażliwe dane; jego ograniczony bufor pozostaje w pamięci hosta.

## Stan zależności

Kontrola npm z 16 października 2026 nadal wykrywa zgłoszenia w przechodnich zależnościach narzędzi Expo: `braces`, `node-forge` i `uuid`. Samo przejście testów nie oznacza zerowego wyniku audytu. W momencie kontroli proponowana przez npm automatyczna naprawa obejmowała niezgodną zmianę do Expo 44; nie zastosowano jej. `ws` używany przez testy ma aktualizację do 8.22.0. Host wykonawczy jest oddzielnym programem Rust.

Przed publikacją binarek i dystrybucją produkcyjną ponów `npm audit` oraz sprawdzenie zależności Cargo. Zgłoszenia bezpieczeństwa nie powinny zawierać kluczy parowania ani wyjścia prywatnych sesji.
