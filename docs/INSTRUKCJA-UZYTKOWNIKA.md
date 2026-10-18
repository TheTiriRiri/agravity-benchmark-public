---
title: Instrukcja przeprowadzenia benchmarku agrav-bench
kicker: agrav-bench · Antigravity CLI
subtitle: Od pobrania repozytorium do opublikowania wyników na panelu — dla osoby prowadzącej benchmark bez przygotowania programistycznego.
scope: Etapy 1–8 · tor klasyczny, tor hard, tor brownfield
status: "!info Procedura obowiązująca — przed pierwszym pełnym przebiegiem"
lang: pl
meta:
  Odbiorca: osoba bez przygotowania programistycznego
  Zadanie: Meridian Maintenance Console
  Sędzia: claude-opus-5-5
  Obraz harnessu: agrav-bench/harness:2026-10-04
  Wersja agy: 1.2.7
footer: "docs/INSTRUKCJA-UZYTKOWNIKA.md"
---

## 1. Cel i zasada działania

agrav-bench mierzy, jak dobrze różne modele AI dostępne w narzędziu **Antigravity CLI** (`agy`) budują aplikację **Meridian Maintenance Console** na podstawie jednego, stałego polecenia (`prompt.md`). To niewielka aplikacja webowa, która planuje prace konserwacyjne techników w zakładach przemysłowych: backend w Pythonie (FastAPI) i frontend w React. Każdy model dostaje identyczne zadanie, a jego wynik jest oceniany według stałej listy kryteriów na **14 punktów**: 7 z ukrytych testów kontraktowych API, 1 za lokalną budowę, 3 z kryteriów ocenianych przez agenta-sędziego i 3 z kryteriów ocenianych przez człowieka; ewentualna kara (Penalty) jest odejmowana. Oceny trafiają na panel porównawczy. Dwa dodatkowe tory — **hard** (większy planista, 19 punktów) i **brownfield** (zmiana gotowej aplikacji, 12 punktów) — korzystają z tego samego procesu; opisuje je rozdział 13.

Przebieg składa się z ośmiu etapów wykonywanych po kolei:

| Etap | Co się dzieje | Kto wykonuje | Czas |
|---|---|---|---|
| 1 | Przygotowanie stanowiska | Człowiek | 30–60 min (jednorazowo) |
| 2 | Pobranie repozytorium i instalacja | Człowiek | 10 min |
| 3 | Zbudowanie środowiska uruchomieniowego (obraz Docker) | Automat | 5 min |
| 4 | Logowanie do Antigravity i test dymny | Człowiek | 15 min |
| 5 | Uruchomienie prób (model buduje aplikację) | Automat | do 32 min na próbę |
| 6 | Ocena każdej próby | Automat + człowiek (4 pytania) | 20–40 min na próbę |
| 7 | Przetworzenie wyników, zrzuty ekranu, podgląd panelu | Automat | 5–10 min |
| 8 | Zapis w repozytorium i publikacja | Człowiek | 10 min |

> [!WARNING]
> **Zasada nadrzędna: najpierw jedna próba jednego modelu przez cały proces, potem ten model × 5 prób, dopiero potem pełna macierz — z odczytem limitu przed każdym z tych kroków.** Pełna macierz toru klasycznego to 5 konfiguracji × 5 prób = 25 uruchomień po maksymalnie 30 minut, czyli do ok. 12,5 godziny pracy automatu i znaczna część tygodniowego limitu konta Antigravity. Nie wolno wydawać tego limitu na niezweryfikowany proces.

---

## 2. Słownik pojęć

| Pojęcie | Znaczenie |
|---|---|
| **Terminal** | Okno tekstowe, w którym wpisuje się polecenia. Linux/macOS: aplikacja „Terminal”. Windows: należy użyć WSL2 (Ubuntu) — instrukcja zakłada terminal linuksowy. |
| **Repozytorium** | Katalog projektu z pełną historią zmian, zarządzany przez Git. |
| **Konfiguracja** | Para (model, poziom wysiłku), np. `gemini-38-flash-high`. Każda ma własny wiersz w wynikach. |
| **Próba (attempt)** | Jedno uruchomienie modelu z zadaniem. Każda konfiguracja ma 5 prób: `<konfiguracja>-attempt-1` … `-attempt-5`. |
| **Obraz Docker** | Zamknięte, powtarzalne środowisko, w którym uruchamia się `agy`, a podczas oceny także backend każdej próby. Model pracuje wyłącznie wewnątrz niego. |
| **Wolumen `agy-creds`** | Trwały schowek Dockera z zapisanym logowaniem do Antigravity. Tworzy się raz. |
| **Limit (quota)** | Tygodniowy budżet konta Antigravity. Każda próba go zużywa. |
| **Ukryte testy kontraktowe** | 58 automatycznych testów API w `benchmark/contract-tests/`, których model nie widzi. Uruchamia je `contract-tests` na backendzie próby; dają 7 z 14 punktów. |
| **Reguła zatrzymania (stop rule)** | Gdy backendu lub frontendu próby nie da się zainstalować albo uruchomić, kryteria, których nie da się ocenić, dostają 0 (`benchmark/criteria.md`). |
| **Sędzia (judge)** | Model Claude, który ocenia próby (zapisany w `benchmark/runner.yaml` jako `judge: claude-opus-5-5`). |
| **Panel (dashboard)** | Strona internetowa z tabelą wyników; buduje się z plików w repozytorium. |

Konwencja zapisu w tym dokumencie: fragmenty w nawiasach `<…>` zastępuje się własną wartością; polecenia wpisuje się w terminalu w katalogu głównym repozytorium, o ile nie napisano inaczej.

---

## 3. Wymagania wstępne

### 3.1 Konta i uprawnienia

| Wymaganie | Uwagi |
|---|---|
| Konto Google z aktywnym dostępem do Antigravity | Potrzebne wyłącznie do uruchamiania prób (etap 4–5). Limit tygodniowy powinien wynosić co najmniej ~30% na każdym modelu przed pełną macierzą. |
| Dostęp do repozytorium (adres do sklonowania) | Do odczytu na start; do zapisu na etap 8. |
| Konto Claude z dostępem do Claude Code | Potrzebne do oceny prób (etap 6). |
| Konto Cloudflare z projektem Pages `agrav-bench` i sekretami w GitHub | Potrzebne wyłącznie do publikacji panelu w internecie (etap 8). Bez tego panel działa lokalnie. Konfiguracja opisana w `website/DEPLOYMENT.md`; wykonuje ją administrator. |

### 3.2 Oprogramowanie na komputerze

| Program | Wersja | Sprawdzenie w terminalu | Oczekiwany wynik |
|---|---|---|---|
| Git | dowolna aktualna | `git --version` | `git version 2.x` |
| Node.js | **24** | `node --version` | `v24.x.x` |
| npm | 11 (dostarczany z Node 24) | `npm --version` | `11.x.x` |
| Docker | aktualny | `docker run --rm hello-world` | komunikat `Hello from Docker!` |
| Claude Code | aktualny | `claude --version` | numer wersji |

Jeżeli `docker run` zgłasza `permission denied`, konto użytkownika musi zostać dodane do grupy `docker` (administrator) — bez tego etapy 3–7 nie działają.

### 3.3 Zasoby

- Stałe, nieograniczone połączenie z internetem — model podczas pracy instaluje pakiety npm i PyPI, a ocena instaluje zależności backendu (PyPI) i frontendu (npm).
- Ok. 10 GB wolnego miejsca (obraz Docker, zależności, wyniki).
- Wolne porty 5100 i 5173 podczas oceny (etap 6) i zrzutów ekranu (etap 7) — na nich działa oceniana aplikacja.
- Komputer nie może usypiać podczas etapu 5.

---

## 4. Etap 1 — Przygotowanie stanowiska

1. Zainstalować programy z tabeli 3.2 i potwierdzić każdą wersję wskazanym poleceniem.
2. Zalogować Claude Code: uruchomić `claude` w dowolnym katalogu, wykonać logowanie zgodnie z podpowiedziami, zakończyć poleceniem `/exit`.
3. Upewnić się, że konto Google przeznaczone do benchmarku jest zalogowane w przeglądarce, a **wszystkie karty z wcześniejszymi próbami logowania do Antigravity są zamknięte** (otwarta stara karta powoduje błąd `Invalid code verifier` w etapie 4).

---

## 5. Etap 2 — Pobranie repozytorium i instalacja

```bash
git clone <adres repozytorium> agrav-bench
cd agrav-bench
npm install
```

`npm install` instaluje zależności głównego projektu i panelu (`website/`). Trwa 1–3 minuty.

**Weryfikacja stanowiska** — trzy polecenia, każde musi zakończyć się bez błędu:

```bash
npm test          # oczekiwane: podsumowanie z "fail 0"
npm run typecheck # oczekiwane: brak komunikatów
npm run build     # oczekiwane: kończy się bez błędu, ostatnie linie to podsumowanie zbudowanych stron
```

Po `npm run build` polecenie `git status` pokazuje dwa zmienione pliki: `website/src/data/results.json` i `website/public/api/leaderboard.json`. `npm run build` uruchamia najpierw `process-results`, który zapisuje oba, każdy z nowym znacznikiem czasu (`generatedAt`) — przy braku nowych ocen to jedyna zmiana i nie ma ona znaczenia. Przywraca się je poleceniem:

```bash
git checkout website/src/data/results.json website/public/api/leaderboard.json
```

---

## 6. Etap 3 — Zbudowanie środowiska uruchomieniowego

Obraz zawiera program `agy` w ściśle określonej wersji (1.2.7), Pythona 3.11 (w nim podczas oceny działa backend każdej próby) oraz skrypt sterujący próbą. Nazwa obrazu musi być identyczna z wpisem `image:` w `benchmark/runner.yaml` (obecnie `agrav-bench/harness:2026-10-04`). Zawartość obrazu i sposób jego sprawdzenia opisuje `images/harness/IMAGE.md`.

```bash
docker build -t agrav-bench/harness:2026-10-04 images/harness
```

Oczekiwany rezultat: ostatnia linia zaczyna się od `Successfully tagged` lub `naming to docker.io/agrav-bench/harness:2026-10-04`.

**Jeżeli budowa kończy się błędem na etapie `sha512sum` lub `404`**, oznacza to, że dostawca przestał udostępniać przypiętą wersję `agy`. Nie należy niczego zmieniać samodzielnie — zmiana wersji `agy` unieważnia porównywalność wyników. Sytuację przekazuje się administratorowi projektu (procedura: `README.md`, sekcja „When the pinned agy release disappears”).

---

## 7. Etap 4 — Logowanie do Antigravity i test dymny

> [!STOP]
> **Logowanie musi odbyć się wewnątrz kontenera**, nigdy przez `agy` zainstalowane bezpośrednio na komputerze. Zalogowanie na komputerze zapisuje poświadczenia w miejscu, do którego benchmark nie ma dostępu, i każda próba uruchomi się jako niezalogowana.

Logowanie wykonuje się raz na wolumen `agy-creds`. Jeżeli wolumen już istnieje (logowanie wykonano wcześniej), pomija się 7.1 i zaczyna od 7.2 — krok 7.3 pokaże, czy zapisane logowanie nadal działa. Poza samym logowaniem wolumen nigdy nie jest podłączany jako katalog domowy `agy`, bo `agy` zapisuje w swoim katalogu domowym dzienniki i może odświeżyć token. Kroki 7.2–7.6 pracują na jednorazowej kopii poświadczeń, tak samo jak `run-matrix` przy każdej próbie.

Każde polecenie `docker run` obrazu harnessu w tej instrukcji zawiera `--pull never`: jeżeli obrazu nie ma na komputerze, polecenie kończy się błędem, zamiast pobrać obraz o tej nazwie z publicznego rejestru, w którym mógłby go umieścić ktokolwiek. Obraz buduje się w etapie 3.

### 7.1 Logowanie

```bash
docker run -it --pull never --user "$(id -u):$(id -g)" -e HOME=/home/agy -w /home/agy \
    -v agy-creds:/home/agy agrav-bench/harness:2026-10-04 --login
```

Przebieg:

1. W terminalu pojawia się pełnoekranowy interfejs `agy` z adresem do logowania (albo przeglądarka otwiera się sama).
2. Adres kopiuje się do przeglądarki, loguje kontem Google z dostępem do Antigravity i zatwierdza zgody.
3. Po komunikacie o powodzeniu wraca się do terminala i zamyka `agy` (Ctrl+C). Kontener kończy działanie — zapisane logowanie pozostaje na wolumenie `agy-creds`.

**Bez terminala (np. przez SSH bez `-t` albo z poziomu skryptu).** To samo polecenie zachowuje się różnie zależnie od jednej flagi Dockera — o tym, czy `agy` pokaże adres logowania, decyduje rodzaj wejścia kontenera:

| Masz | Użyj | Wynik |
|---|---|---|
| terminal | `-it … --login` (polecenie powyżej) | pełny interfejs logowania |
| pseudoterminal, ale nie terminal | `script -qec "docker run -it …" /dev/null` | adres logowania i miejsce na wklejenie kodu |
| ani jednego, ani drugiego | dowolne polecenie w trybie wydruku (np. `--usage`) **bez `-i`** | adres logowania i 60 sekund oczekiwania — ale wejście to `/dev/null`, więc kodu nie ma gdzie wkleić |
| — | `-i` bez `-t` | natychmiastowa odmowa `Error: authentication required. Run 'agy' to log in, then retry.` — to pułapka, wygląda jak zepsuta instalacja, a nią nie jest |

Gdy nie ma terminala, najpewniej jest zdobyć pseudoterminal (`script`, `ssh -t`). Polecenie `--models` nigdy nie zaczyna logowania — z `-i` czy bez, odpowiada od razu `Error: Please sign in to view available models.` — dlatego to ono służy do sprawdzenia logowania (7.3).

Obraz uruchamia zawsze `run-attempt`, nie `agy`: polecenie `docker run … <obraz> agy …` kończy się błędem `unknown arg: agy`. `run-attempt` ma cztery tryby — `--login`, `--models`, `--usage` i samą próbę.

To jedyne polecenie w rozdziale 7, które zapisuje na wolumenie `agy-creds`; kroki 7.2–7.6 montują go tylko do odczytu albo wcale. Flagi `-it` są obowiązkowe. Bez nich polecenie kończy się błędem `error opening TTY` **z zielonym statusem** — dlatego wynik logowania sprawdza się wyłącznie krokiem 7.3, nigdy brakiem komunikatu o błędzie. Wykonuje się **jedno** logowanie od początku do końca, bez przerw; przy komunikacie `Invalid code verifier` należy zamknąć wszystkie karty przeglądarki związane z Antigravity i powtórzyć krok od początku.

### 7.2 Jednorazowa kopia poświadczeń

Kroki 7.2–7.6 wykonuje się po kolei w **jednym oknie terminala**: poniższe polecenia zapamiętują nazwę obrazu i katalogu tymczasowego w zmiennych `IMAGE` i `SMOKE`, z których korzystają następne kroki.

```bash
IMAGE=agrav-bench/harness:2026-10-04
SMOKE=$(mktemp -d); mkdir -p "$SMOKE/home" "$SMOKE/work"
docker run --rm --pull never --user "$(id -u):$(id -g)" -w /src -v agy-creds:/src:ro -v "$SMOKE/home:/dst" \
    --entrypoint cp "$IMAGE" --parents \
    .gemini/antigravity-cli/antigravity-oauth-token .gemini/antigravity-cli/installation_id /dst/
```

Polecenie kopiuje z wolumenu, podłączonego tylko do odczytu, wyłącznie dwa pliki: token logowania i identyfikator instalacji — te same, które `run-matrix` kopiuje przed każdą próbą. **Katalog `$SMOKE` zawiera aktywny token konta** i jest usuwany w kroku 7.6. Jeżeli polecenie kończy się błędem `cp: cannot stat …`, na wolumenie nie ma logowania: wykonać 7.6, potem 7.1 i od nowa 7.2.

### 7.3 Weryfikacja logowania (obowiązkowa)

```bash
docker run --rm --pull never --user "$(id -u):$(id -g)" -e HOME=/home/agy -w /home/agy \
    -v "$SMOKE/home:/home/agy" "$IMAGE" --models
```

| Wynik | Znaczenie |
|---|---|
| Lista kilkunastu identyfikatorów modeli (`gemini-3.8-flash-high`, `claude-sonnet-4-6`, …) | **Logowanie udane.** Można przejść dalej. |
| `Error: Please sign in to view available models.` | Logowanie nie zostało ukończone lub wygasło. Wykonać 7.6, powtórzyć 7.1, potem od 7.2. |

### 7.4 Test dymny

Test sprawdza całą drogę, którą przechodzi każda próba: kopię poświadczeń, uruchomienie modelu w kontenerze z limitem czasu 30 minut i zapis wyników jako bieżący użytkownik. To jedno bardzo krótkie wywołanie modelu; zużywa niewielką część limitu.

```bash
printf 'Create hello.txt containing the word hello\n' > "$SMOKE/prompt.md"
docker run --rm --pull never --user "$(id -u):$(id -g)" -e HOME=/home/agy -e TIMEOUT=30m \
    -v "$SMOKE/work:/workspace" -v "$SMOKE/home:/home/agy" -v "$SMOKE/prompt.md:/prompt.md:ro" \
    "$IMAGE" --model gemini-3.8-flash-high --effort high --prompt-file /prompt.md \
    >"$SMOKE/stdout.json" 2>"$SMOKE/stderr.log"
```

Sprawdzenie wyniku — cztery polecenia:

```bash
ls -l "$SMOKE/work/hello.txt"
node -e 'const e = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log(e.status, e.usage.total_tokens > 0)' "$SMOKE/stdout.json"
grep -c soft-deny "$SMOKE/stderr.log"
docker run --rm --pull never --entrypoint agy "$IMAGE" --version
```

| Polecenie | Oczekiwany wynik |
|---|---|
| `ls -l …` | Plik `hello.txt` istnieje, a jego właścicielem jest bieżący użytkownik, nie `root`. |
| `node -e …` | `SUCCESS true`. Przy `TIMEOUT=30m` oznacza to także, że `agy` przyjął limit czasu 30 minut. |
| `grep -c soft-deny …` | `0` |
| `… --version` | Wersja zapisana w `images/harness/IMAGE.md` (obecnie 1.2.7). |

Jeżeli którykolwiek wynik jest inny, nie uruchamia się prób: wykonać 7.6 i przekazać wyniki administratorowi.

### 7.5 Odczyt limitu

```bash
docker run --rm --pull never --user "$(id -u):$(id -g)" -e HOME=/home/agy -w /home/agy \
    -v "$SMOKE/home:/home/agy" "$IMAGE" --usage
```

Wynik to tabela z procentem **pozostałego** limitu i czasem odnowienia dla każdego modelu. Kształt wiersza (wartości poglądowe, prawdziwe będą inne):

```
All Models	Gemini 3.8 Flash (High)	100%	<czas resetu>
All Models	Claude Opus 4.6 (Thinking)	100%	<czas resetu>
```

Wartość dla modelu, który ma zostać uruchomiony, zapisuje się w notatkach — po 5 próbach porównanie pokaże realny koszt jednej konfiguracji. Jeżeli zamiast tabeli pojawia się adres do logowania i 60-sekundowe oczekiwanie, logowanie nie zadziałało: przerwać (Ctrl+C), wykonać 7.6 i wrócić do 7.1.

### 7.6 Usunięcie kopii poświadczeń (obowiązkowe)

```bash
rm -rf "$SMOKE"
```

Katalog zawiera aktywny token konta, dlatego usuwa się go zawsze — także wtedy, gdy któryś krok zakończył się błędem. Razem z nim przepada token, który `agy` mógł odświeżyć podczas testu dymnego: w przeciwieństwie do próby uruchomionej przez `run-matrix` nic nie zapisuje go z powrotem na wolumen. Jeżeli więc zaraz po teście dymnym kolejne uruchomienie zgłosi błąd logowania, to najprawdopodobniej ta przyczyna — należy zalogować się ponownie (7.1).

Logowanie jest ważne do odwołania. Powtarza się je tylko wtedy, gdy krok 7.3 przestanie zwracać listę modeli. Limit można odczytać w dowolnym momencie krokami 7.2, 7.5 i 7.6, bez testu dymnego.

---

## 8. Etap 5 — Uruchomienie prób

### 8.1 Próba na sucho (bez zużycia limitu)

```bash
npm run run-matrix -- --only gemini-38-flash-high --attempts 5 --dry-run
```

Wypisuje polecenia Dockera, które zostałyby wykonane, i kończy się linią `dry run complete — nothing was written.` Nic nie zapisuje. Jeżeli kończy się błędem, przyczyna leży w konfiguracji stanowiska (etapy 2–4), nie w modelu.

### 8.2 Pierwsza konfiguracja — 1 próba, potem 5

Zalecana pierwsza konfiguracja: `gemini-38-flash-high` (najszybszy model w macierzy). Pełną listę identyfikatorów zawiera sekcja `matrix:` w `benchmark/runner.yaml`.

Najpierw **jedna** próba, która przechodzi cały proces — ocenę (etap 6), przetworzenie wyników, zrzut ekranu i podgląd panelu (etap 7) — zanim ruszy następna:

```bash
npm run run-matrix -- --only gemini-38-flash-high --attempts 1
```

Dopiero gdy ta próba przeszła etapy 6–7 bez uwag, odczytuje się limit (7.2, 7.5, 7.6) i uruchamia pozostałe cztery. Próba 1 jest już zakończona, więc zostanie pominięta:

```bash
npm run run-matrix -- --only gemini-38-flash-high --attempts 5
```

Co się dzieje:

- Próby wykonują się **jedna po drugiej**, nigdy równolegle. Każda trwa do 32 minut (model ma 30 minut; po tym czasie próba jest przerywana i liczy się jako niepowodzenie modelu).
- Przed każdą próbą program odczytuje limit (`/usage`) i wypisuje go w terminalu.
- Po każdej próbie pojawia się linia w rodzaju `[gemini-38-flash-high-attempt-1] ok: … (412s, exit 0)`.
- Całość kończy się linią `matrix complete.`

Wyniki:

- `eval-attempts/<konfiguracja>-attempt-<n>/` — aplikacja zbudowana przez model (katalogi `backend/` i `frontend/`). **Nie wolno tam niczego zmieniać ani dodawać** — to materiał podlegający ocenie.
- `eval-results/<konfiguracja>-attempt-<n>/run.json` — metryka próby (czas, tokeny, status).

### 8.3 Przerwanie i wznowienie

- **Przerwanie** — Ctrl+C w terminalu. Bezpieczne: bieżąca próba jest porzucana bez zapisu. Gdy przerwanie trafia w działający kontener próby (tak jest niemal zawsze), czyste zakończenie potwierdzają trzy kolejne linie: `SIGINT — <konfiguracja>-attempt-<n> was interrupted. No run.json was written, so it is not a data point and rerunning resumes from it.`, linia o usunięciu kontenera (`docker rm -f <nazwa kontenera> succeeded`) i `SIGINT — cleaning up before exiting; send it again to exit at once.`; dla `SIGTERM` i `SIGHUP` tak samo, z nazwą danego sygnału. W pierwszych sekundach próby, zanim kontener ruszy, w pierwszej linii po nazwie próby pojawia się `(seeding credentials)` albo `(quota gate)` — czyli `SIGINT — <konfiguracja>-attempt-<n> (quota gate) was interrupted. …` — i nie ma linii o kontenerze. Przerwanie w 60-sekundowej przerwie przed ponowieniem próby po przekroczeniu limitu (poprzedza ją komunikat `[<konfiguracja>-attempt-<n>] rate limited (<powód>); sleeping 60s and retrying once.`) daje dwie linie: `SIGINT — cleaning up before exiting; send it again to exit at once.`, a po niej `credential directory removed; rerun to resume.`. Katalog z kopią poświadczeń jest usuwany w każdym z tych przypadków; osobną linię o tym wypisuje tylko ostatni, w pozostałych nie należy jej szukać. Gdyby usunięcie się nie udało, pojawia się ostrzeżenie `could not remove the throwaway HOME … delete it by hand` ze ścieżką; postępowanie opisuje wiersz tabeli w rozdziale 14.
- **Sygnał wysłany samemu procesowi** (`kill <pid>`) działa inaczej niż Ctrl+C czy `kill %1`, które trafiają do całej grupy procesów pierwszego planu, a więc i do kontenera: skutek pojawia się dopiero na granicy prób — gdy bieżący kontener się zakończy, czyli nawet po ~30 minutach. Wypisywane są wtedy tylko dwie linie, `SIGINT — cleaning up before exiting; send it again to exit at once.` (albo `SIGTERM — …`) i `credential directory removed; rerun to resume.`, bez linii o przerwanej próbie. Próba, która w tym czasie się kończyła, jest zapisana normalnie; kolejne już nie ruszają.
- **Wznowienie** — to samo polecenie co w 8.2. Próby już zakończone są pomijane (komunikat `skipped: … already exists`), przerwana lub nieudana z winy infrastruktury wykonuje się ponownie.
- W tym samym czasie może działać **tylko jedno** uruchomienie `run-matrix` na całym komputerze — także wtedy, gdy drugie działa w innej kopii repozytorium. Drugie odmawia startu i podaje katalog główny tego pierwszego; to zachowanie zamierzone (jedno konto, jeden limit).

### 8.4 Trzy możliwe zakończenia próby

| Komunikat w terminalu | Znaczenie | Działanie |
|---|---|---|
| `ok: …` | Model ukończył zadanie. | Brak. |
| `model: …` (np. timeout, pusty katalog) | Model nie poradził sobie z zadaniem. To **prawidłowy wynik**, oceniany na 0. | Brak. Macierz idzie dalej. |
| `Stopping the matrix: … failed for infrastructure reasons` | Awaria po stronie narzędzi lub konta (logowanie, limit, przeciążenie dostawcy, Docker). **Nie jest wynikiem.** | Odczytać przyczynę pod `stderr tail:`, usunąć ją (tabela w rozdziale 14), uruchomić polecenie ponownie — próba zostanie powtórzona. |

---

## 9. Etap 6 — Ocena prób

Ocenę wykonuje umiejętność (skill) `agrav-score-attempt` uruchamiana w Claude Code. Ocenia się **jedną próbę na jedno wywołanie**. Skill po kolei:

1. czyta `run.json` próby: próbę z awarią infrastruktury odrzuca, a niepowodzenie modelu od razu ocenia na 0;
2. uruchamia `contract-tests` — ukryte testy kontraktowe API (58 testów w 4 plikach), które uruchamiają backend próby w obrazie harnessu i zapisują wynik w `eval-results/<konfiguracja>-attempt-<n>/contract-results.json`; to 7 z 14 punktów;
3. instaluje i buduje frontend (`npm install`, `npm run build` w `frontend/`) i stosuje reguły zatrzymania;
4. uruchamia aplikację przez `serve-attempt` — backend na porcie 5100, frontend na porcie 5173 — i zadaje człowiekowi 3 pytania o jej działanie i wygląd;
5. sam ocenia 3 kryteria (integrację frontendu z API, strukturę kodu, stos technologiczny i kontrakt uruchomienia), proponuje karę (Penalty) i prosi człowieka o jej potwierdzenie — to czwarte pytanie;
6. zatrzymuje aplikację (`serve-attempt --stop`) i zapisuje ocenę.

> [!WARNING]
> **Uwaga bezpieczeństwa.** Ocena instaluje i uruchamia kod wygenerowany przez model: frontend bezpośrednio na komputerze (`npm install`, `npm run build`, `npm run dev`), backend w kontenerze Docker z dostępem do internetu. Jest to świadomie przyjęte ryzyko benchmarku — bez tego kroku nie da się zmierzyć, czy aplikacja działa. Oceny należy prowadzić na stanowisku przeznaczonym do benchmarku, nie na komputerze z danymi wrażliwymi.

### 9.1 Uruchomienie oceny

1. W katalogu głównym repozytorium uruchomić `claude`.
2. Sprawdzić model sędziego: wpisać `/model` i wybrać model zgodny z wpisem `judge:` w `benchmark/runner.yaml` (obecnie Claude Opus). Oceny wykonane innym sędzią nie są porównywalne.
3. Wpisać:

   ```
   /agrav-score-attempt gemini-38-flash-high-attempt-1
   ```

4. Skill wykonuje automatyczne kroki: ukryte testy i budowę frontendu, potem uruchomienie aplikacji (do ok. 10 minut). Zwykle trwa to kilka minut. W najgorszym przypadku same ukryte testy zajmują 25 minut (5 minut na instalację zależności backendu i 20 minut na pliki testowe), a `npm install` frontendu kolejne 10 minut — razem ok. 35 minut; sama budowa frontendu nie ma limitu, więc gdy trwa dłużej niż 10 minut, skill pyta, czy czekać dalej. Następnie podaje adres aplikacji (zwykle `http://localhost:5173`), listę jej ekranów i pięć scenariuszy do sprawdzenia oraz prosi o otwarcie adresu w przeglądarce.

Jeżeli skill odmawia oceny z powodu `failureKind: "infra"`, próba musi zostać powtórzona (etap 5) — nie jest to wynik modelu. Jeżeli backendu lub frontendu modelu nie da się zainstalować albo uruchomić, skill stosuje reguły zatrzymania z `benchmark/criteria.md`: kryteria, których nie da się ocenić, dostają 0 z uzasadnieniem, a gdy nie działa ani backend, ani frontend — 0 we wszystkich kryteriach. To prawidłowe zachowanie. Awaria po stronie narzędzi (Docker, brak dostępu do PyPI lub rejestru npm, zajęty port) nie jest wynikiem: skill niczego nie zapisuje i opisuje problem.

### 9.2 Cztery pytania do człowieka

Przed odpowiedzią należy w przeglądarce przejść pięć scenariuszy, które wypisuje skill: nawigację po czterech ekranach; harmonogram (tydzień 2026-10-05, przycisk „Generate plan”); listę zleceń (filtry, formularz, komunikat błędu przy niepoprawnych danych); szczegóły zlecenia (wszystkie pola, dozwolona zmiana statusu); pulpit i magazyn części. Potem to samo przy szerokości telefonu (375 px; F12 → ikona telefonu) i komputera (1280 px lub więcej).

| Pytanie | 1 punkt | 0,5 punktu | 0 punktów |
|---|---|---|---|
| **Manual testing** — czy działa pięć scenariuszy? | Wszystkie pięć działa bez ręcznego przeładowania strony. | Dokładnie jeden nie działa lub go brakuje; albo wszystkie działają, ale świeże dane widać dopiero po ręcznym przeładowaniu. | Aplikacja się nie ładuje albo dwa lub więcej scenariuszy nie działa lub ich brakuje. |
| **Consistent UI** — czy cztery ekrany wyglądają spójnie? | Style aplikacji działają na każdym ekranie, a ekrany mają wspólną nawigację, układ, typografię, kolory, odstępy oraz style przycisków, tabel i formularzy. | Jak za 1 punkt, z kilkoma lokalnymi odstępstwami (np. jeden ekran z własnym stylem przycisków, formularz w domyślnym stylu przeglądarki). | Style zepsute lub nieobecne na którymkolwiek ekranie, ekrany wyglądają jak różne aplikacje albo odstępstwa są na większości ekranów. |
| **Responsive design** — czy aplikacja działa na telefonie i na komputerze? | Każdy ekran jest używalny w obu szerokościach: nawigacja dostępna, strona nie przewija się w bok (tabela lub oś czasu może przewijać się we własnym polu), formularze się mieszczą. | Nawigacja i treść każdego ekranu są dostępne w obu szerokościach, z drobnymi problemami na jednym lub dwóch ekranach (np. tabela przesuwająca stronę w bok). | Układ się nie dopasowuje: nawigacja lub treść jest ucięta albo niedostępna, większość ekranów przewija się w bok albo drobne problemy są na trzech lub więcej ekranach. |
| **Penalty** — czy potwierdzić karę zaproponowaną przez skill? | `0` = brak kary (typowy przypadek). | `0,5` = usterka spoza pozostałych kryteriów, którą zauważy użytkownik lub opiekun (np. niezwiązane z zadaniem pliki, README obiecujące coś, czego nie ma). | `1` = coś niebezpiecznego (np. skrypt instalacyjny robiący więcej niż budowę, zapisane w kodzie dane dostępowe). |

Jeżeli backend próby nie działa, skill pyta o Consistent UI i Responsive design — ocenia się wtedy frontend bez danych — a potem, w osobnym pytaniu, o potwierdzenie kary (Penalty). Jeżeli nie działa frontend, zostaje samo pytanie o karę. Gdy nie działa ani backend, ani frontend, skill nie pyta o nic i zapisuje same zera.

Zasady odpowiedzi:

- Ocenia się według definicji z tabeli (pełne brzmienie: `benchmark/criteria.md`), nie według ogólnego wrażenia.
- **Każda ocena poniżej 1 wymaga jednozdaniowego uzasadnienia** w polu odpowiedzi (np. „oś czasu wychodzi poza ekran poniżej 400 px”). Ocena bez uzasadnienia jest bezużyteczna przy późniejszym audycie.
- Nie pomija się żadnego pytania i nie przyjmuje oceny „domyślnie” — pytanie bez odpowiedzi skill zadaje ponownie.
- Ten sam standard stosuje się do każdej próby każdego modelu.

Po odpowiedziach skill zatrzymuje aplikację i zapisuje **jeden plik**: `eval-results/<konfiguracja>-attempt-<n>/eval-results.csv` (14 wierszy; obok leży `contract-results.json` z ukrytych testów). Kroki 9.1–9.2 powtarza się dla kolejnych prób.

---

## 10. Etap 7 — Przetworzenie wyników i podgląd panelu

### 10.1 Przeliczenie wyników

```bash
npm run process-results
```

Zbiera wszystkie pliki `eval-results.csv`, `contract-results.json` i `run.json` do `website/src/data/results.json` oraz `website/public/api/leaderboard.json`. Trwa sekundy. Kończy się błędem, jeżeli wiersze ukrytych testów w `eval-results.csv` nie zgadzają się z `contract-results.json` — wtedy próbę ocenia się ponownie (etap 6).

### 10.2 Zrzuty ekranu (jednorazowe przygotowanie przeglądarki)

```bash
npx playwright install chromium        # tylko raz na stanowisku
npm run screenshots -- --only gemini-38-flash-high
```

Uruchamia po kolei każdą próbę wskazanej konfiguracji (backend w obrazie harnessu na porcie 5100, frontend na porcie 5173) i fotografuje jej stronę główną (1280×720) do `website/public/screenshots/`, a także składa pasek zbiorczy konfiguracji. Trwa kilka minut na próbę. Próba, której nie da się uruchomić, otrzymuje kartę z błędem — to celowe, każdy wiersz panelu ma obraz.

Do powtórzenia zrzutów po poprawce dodaje się `--force`.

### 10.3 Podgląd panelu

```bash
npm run dev
```

Panel otwiera się pod adresem wypisanym w terminalu (zwykle `http://localhost:4321`). Sprawdza się: obecność konfiguracji w tabeli, 5 prób, zrzuty ekranu, sensowne wartości czasu i kosztu. Podgląd zatrzymuje się skrótem Ctrl+C.

---

## 11. Etap 8 — Zapis w repozytorium i publikacja

### 11.1 Zapis wyników

```bash
git status
```

Na liście powinny być wyłącznie: katalogi `eval-attempts/…` i `eval-results/…` ocenionej konfiguracji, `website/src/data/results.json`, `website/public/api/leaderboard.json`, `website/public/screenshots/…`, `website/src/data/screenshot-hashes.json`. Inne zmiany oznaczają przypadkową modyfikację i wymagają wyjaśnienia przed zapisem.

**Jeżeli w repozytorium nie mogą znaleźć się pewne nazwy** (np. klienta lub projektu), przed pierwszym `git push` tworzy się w katalogu głównym plik `.confidential-terms` — zastrzeżone nazwy, po jednej w wierszu; plik jest w `.gitignore` i nigdy nie trafia do repozytorium — i uruchamia `npm test`. Test poufności przegląda wtedy całą historię repozytorium, czyli to, co wysyła `git push`. Bez tego pliku test szuka wyłącznie sekretów (tokenów, kluczy). Sekret `CONFIDENTIAL_TERMS` w CI (11.2) jest drugą linią obrony i działa już po wysłaniu, nie przed.

```bash
git add eval-attempts eval-results website/src/data website/public/api website/public/screenshots
# tory hard i brownfield: dodatkowo tracks/console-hard/eval-attempts tracks/console-hard/eval-results
# albo tracks/brownfield/eval-attempts tracks/brownfield/eval-results
git commit -m "Record <konfiguracja> x 5 attempts"
git push
```

**Jeżeli `git add` wypisuje `warning: adding embedded git repository`** — model utworzył wewnątrz swojej aplikacji własne repozytorium, którego Git nie potrafi dołączyć. Nie kontynuować; ukryty katalog `.git` przenosi się poza materiał oceny, do katalogu `model-git/` obok wyników próby:

```bash
mkdir -p eval-results/<konfiguracja>-attempt-<n>/model-git
mv <ścieżka wskazana w ostrzeżeniu>/.git eval-results/<konfiguracja>-attempt-<n>/model-git/projekt
```

i powtarza się `git add`.

### 11.2 Publikacja panelu

Po `git push` do gałęzi `main` proces automatyczny (GitHub Actions, plik `.github/workflows/publish.yml`) uruchamia testy, buduje panel i — jeżeli publikacja jest skonfigurowana — publikuje go w Cloudflare Pages. Postęp widoczny jest w zakładce **Actions** repozytorium na GitHub.

Publikację konfiguruje administrator (`website/DEPLOYMENT.md`): tworzy własny projekt Cloudflare Pages, wpisuje jego nazwę w repozytorium i dodaje dwa sekrety, `CLOUDFLARE_API_TOKEN` i `CLOUDFLARE_ACCOUNT_ID`. Bez nich wszystkie kroki przechodzą, a krok „Deploy” jest pomijany — wyniki są zapisane w repozytorium, a panel dostępny lokalnie (10.3). Opcjonalny sekret `CONFIDENTIAL_TERMS` przekazuje do CI listę zastrzeżonych nazw; zmienna repozytorium `REQUIRE_CONFIDENTIAL_TERMS=true` sprawia, że krok „Test” kończy się błędem, gdy tej listy brakuje.

Jeżeli praca odbywa się na osobnej gałęzi, publikacja następuje po scaleniu jej do `main`.

---

## 12. Pełna macierz — po zwalidowaniu procesu

Do pełnej macierzy przechodzi się dopiero, gdy pierwsza konfiguracja przeszła etapy 5–8 bez uwag: najpierw jedna próba, potem pięć (8.2).

1. Odczytać limit (7.2, 7.5, 7.6). Pełna macierz wymaga znacznej rezerwy na każdym modelu; przy niskiej wartości dla któregoś modelu należy wykluczyć go z bieżącego przebiegu i wrócić po odnowieniu limitu.
2. Uruchomić pozostałe konfiguracje. Zaleca się pojedynczo, bo wtedy ocena (etap 6) może iść równolegle z kolejną konfiguracją. Ocena obciąża jednak komputer (instalacja pakietów, kontener z backendem, serwer frontendu) i może zawyżyć czas zapisany dla trwającej właśnie próby — gdy czasy mają być czyste, ocenia się dopiero po zakończeniu przebiegu:

   ```bash
   npm run run-matrix -- --only gemini-31-pro-high --attempts 5
   ```

   albo całość naraz (pozostałe 20 prób, do ok. 10,5 godziny, komputer nie może usypiać):

   ```bash
   npm run run-matrix
   ```

3. Oceniać każdą próbę tym samym sędzią i tym samym standardem (etap 6).
4. Po każdej konfiguracji: `npm run process-results`, zrzuty, podgląd, zapis (etapy 7–8). Zapis po każdej konfiguracji zabezpiecza wykonaną pracę.

Konfiguracje toru klasycznego i ich identyfikatory (sekcja `matrix:` w `benchmark/runner.yaml`; tory hard i brownfield mają te same konfiguracje oprócz `gemini-38-flash-med`):

| Identyfikator | Model | Poziom wysiłku |
|---|---|---|
| `gemini-38-flash-high` | Gemini 3.8 Flash | wysoki |
| `gemini-38-flash-med` | Gemini 3.8 Flash | średni |
| `gemini-31-pro-high` | Gemini 3.1 Pro | wysoki |
| `claude-sonnet-46-high` | Claude Sonnet 4.6 | brak wyboru |
| `claude-opus-46-high` | Claude Opus 4.6 (Thinking) | brak wyboru |

---

## 13. Tor hard i tor brownfield

Oba tory przechodzą te same etapy 5–8 co tor klasyczny, z tym samym obrazem, logowaniem i zasadami (rozdział 15). Różnią się poleceniami i miejscem wyników:

| | Tor klasyczny | Tor hard | Tor brownfield |
|---|---|---|---|
| Zadanie | `prompt.md` | `tracks/console-hard/prompt.md` — większy planista: brygady, dojazdy, dzielenie i wywłaszczanie zleceń | `tracks/brownfield/prompt.md` — zmiana gotowej aplikacji z `tracks/brownfield/base/` |
| Punkty | 14 | 19 | 12 |
| Macierz | `benchmark/runner.yaml` | `benchmark/runner-hard.yaml` | `tracks/brownfield/benchmark/runner.yaml` |
| Limit czasu modelu | 30 min | 45 min | 30 min |
| Próby i wyniki | `eval-attempts/`, `eval-results/` | `tracks/console-hard/eval-attempts/`, `…/eval-results/` | `tracks/brownfield/eval-attempts/`, `…/eval-results/` |
| Skill oceny | `agrav-score-attempt` | `agrav-score-hard` | `agrav-score-brownfield` |

**Uruchomienie prób** (najpierw `--dry-run`, potem 1 próba, potem 5 — jak w 8.1–8.2):

```bash
# tor hard
npm run run-matrix -- --root tracks/console-hard --config benchmark/runner-hard.yaml --only gemini-38-flash-high --attempts 1
# tor brownfield
npm run run-matrix -- --root tracks/brownfield --base tracks/brownfield/base --only gemini-38-flash-high --attempts 1
```

W torze brownfield każda próba zaczyna od kopii bazy, a model ją modyfikuje. Próba, w której model niczego nie zmienił względem bazy, jest niepowodzeniem modelu (w `run.json`: `"noDiffFromBase": true`) i dostaje 0.

**Ocena** — w Claude Code, jedna próba na wywołanie:

```
/agrav-score-hard gemini-38-flash-high-attempt-1
/agrav-score-brownfield gemini-38-flash-high-attempt-1
```

Skill toru hard sam uruchamia ukryte testy kontraktowe i testy E2E w przeglądarce (`scripts/score-hard.ts`), ocenia trzy kryteria agenta, a człowieka pyta o wygląd (Visual design) i potwierdzenie kary. Skill toru brownfield uruchamia testy regresji bazy, testy zmiany, sprawdzenie lokalności zmian i testy modelu, a człowieka pyta o wygląd (Visual design) i potwierdzenie kary.

**Przetworzenie wyników i zrzuty:**

```bash
npm run process-results:hard
npm run screenshots:hard -- --only gemini-38-flash-high
npm run process-results:brownfield
npm run screenshots:brownfield -- --only gemini-38-flash-high
```

Panel (`npm run dev`) ma przełącznik torów; każdy tor ma własną tabelę wyników.

---

## 14. Sytuacje nietypowe

| Objaw | Przyczyna | Działanie |
|---|---|---|
| `Cannot find package 'tsx'` przy dowolnym `npm run …` | Nie wykonano `npm install` w tym klonie. | `npm install`, powtórzyć. |
| `sh: 1: astro: not found` | Zależności panelu nie zainstalowane. | `npm install` w katalogu głównym (instaluje też `website/`). |
| `docker run … --pull never` zgłasza brak obrazu (np. `No such image`) | Obraz harnessu nie jest zbudowany na tym komputerze; `--pull never` celowo nie pobiera go z internetu. | Etap 3 (rozdział 6). |
| `cp: cannot stat …` w kroku 7.2 | Na wolumenie `agy-creds` nie ma logowania. | 7.6, następnie etap 4 od 7.1. |
| `--models` zwraca `Please sign in` | Logowanie nieukończone lub wygasło. | 7.6, następnie etap 4 od 7.1. |
| `--usage` pokazuje adres logowania i czeka 60 s | Jak wyżej. | Ctrl+C, 7.6, etap 4. |
| `Stopping the matrix … authentication` | Poświadczenia na wolumenie nieaktualne. | Etap 4, następnie ponowić `run-matrix`. |
| `Stopping the matrix … quota` / `rate limit` | Limit tygodniowy wyczerpany dla tego modelu. | Odczekać do odnowienia; uruchomić inne konfiguracje przez `--only`. |
| `Stopping the matrix … high traffic` | Przeciążenie po stronie dostawcy modelu. | Odczekać kilka minut, ponowić — próba powtórzy się automatycznie. |
| `Stopping the matrix … soft-deny` | Narzędzie zablokowane wewnątrz `agy`. | Zgłosić administratorowi; nie oceniać tej próby. |
| `run-matrix` odmawia startu: lock | Inne uruchomienie trwa (komunikat podaje jego `pid` i katalog główny — może to być inna kopia repozytorium) lub poprzednie zostało zabite bez sprzątania. | Sprawdzić, czy nie działa drugi terminal; jeśli nie — usunąć wskazany w komunikacie plik blokady, `agrav-bench-run-matrix-agy-creds.lock` w katalogu tymczasowym (`$TMPDIR`, a gdy nie jest ustawiony — `/tmp`), i ponowić. Blokada sięga tylko tego jednego katalogu: dwie powłoki z różnymi wartościami `$TMPDIR` mają dwie różne blokady i oba uruchomienia wystartują. Blokadę pozostawioną przez `SIGKILL` `run-matrix` przejmuje sam. |
| Ostrzeżenie `could not remove the throwaway HOME … delete it by hand` | Katalog tymczasowy z tokenem nie został usunięty. | Usunąć wskazany katalog natychmiast (`rm -rf <ścieżka>`); zawiera aktywny token konta. |
| Skill oceny: `port 5100 is already in use` lub `ports 5100 and 5173 are already in use` | Port zajmuje inny program. | Zamknąć program, który zajmuje port, i powiedzieć skillowi, że port jest wolny. |
| Skill oceny: frontend nie startuje przy pierwszym uruchomieniu | `serve-attempt` sam ponawia start serwera frontendu jeden raz; dopiero nieudane ponowienie jest regułą zatrzymania. | Brak — poczekać na wynik skilla. |
| `npm run process-results` kończy się błędem o wierszach ukrytych testów | `eval-results.csv` nie zgadza się z `contract-results.json` tej próby albo tego pliku brakuje. | Ocenić próbę ponownie (etap 6). |
| Budowa obrazu: błąd `sha512sum` / `404` | Dostawca wycofał przypiętą wersję `agy`. | Administrator (rozdział 6). |
| `git status` pokazuje zmienione `results.json` i `leaderboard.json` bez nowych ocen | Znaczniki czasu z ostatniego `npm run build`; `process-results` zapisuje oba pliki. | `git checkout website/src/data/results.json website/public/api/leaderboard.json`. |
| Terminal zamknięty między krokiem 7.2 a 7.6 (albo utracona zmienna `$SMOKE`) | Kopia poświadczeń z aktywnym tokenem została w systemowym katalogu tymczasowym (`$TMPDIR`, a gdy nie jest ustawiony — `/tmp`). | Odszukać ją i usunąć — blok pod tabelą. |

**Porzucona kopia poświadczeń.** Katalog z kroku 7.2 powstaje przez `mktemp -d`, więc leży pod losową nazwą w systemowym katalogu tymczasowym: `$TMPDIR`, a gdy ta zmienna nie jest ustawiona — `/tmp` (na macOS `$TMPDIR` jest ustawiony zawsze). Jeżeli terminal został zamknięty przed krokiem 7.6, katalog z aktywnym tokenem został na dysku. Poniższe polecenie przeszukuje właśnie ten katalog, wypisuje **same ścieżki** — nie pokazuje zawartości żadnego pliku — i szuka wyłącznie katalogów należących do bieżącego użytkownika:

```bash
find "${TMPDIR:-/tmp}" -maxdepth 4 -type d -user "$(id -un)" -path '*/home/.gemini/antigravity-cli' 2>/dev/null
```

Każda wypisana ścieżka kończy się na `tmp.XXXXXXXX/home/.gemini/antigravity-cli`. Do usunięcia jest jej część przed `/home/` — dalej `<katalog>`; na macOS nie leży ona pod `/tmp`, tylko w miejscu wskazanym przez `$TMPDIR`. Najpierw sprawdza się właściciela i czas utworzenia tego katalogu:

```bash
ls -ld "<katalog>"
```

Musi należeć do bieżącego użytkownika i pochodzić z jego własnej sesji. Dopiero po obejrzeniu wyniku usuwa się **ten jeden** katalog — nigdy całego katalogu tymczasowego ani ścieżki, której nie było na wypisanej liście:

```bash
rm -rf "<katalog>"
```

W obu poleceniach w miejsce `<katalog>` wstawia się ścieżkę wypisaną przez `find` bez końcówki `/home/.gemini/antigravity-cli`; polecenie wklejone bez podmiany niczego nie usuwa.

Brak wyników oznacza, że w przeszukanym katalogu tymczasowym nie ma żadnej kopii.

---

## 15. Zasady, których nie wolno naruszyć

```items
- **Z1** **Nie zmienia się zawartości `eval-attempts/`.** Żadnych poprawek kodu modelu, żadnych dodanych plików. Zmiana unieważnia próbę.
- **Z2** **Nie edytuje się `eval-results.csv` ani `contract-results.json` ręcznie.** Zmiana oceny wymaga ponownego uruchomienia skilla.
- **Z3** **Jedno `run-matrix` w danym czasie.** Jedno konto, jeden limit.
- **Z4** **Logowanie do Antigravity tylko wewnątrz kontenera (7.1).** Nigdy przez `agy` na komputerze, nigdy przez podłączanie katalogu `~/.gemini` z komputera.
- **Z5** **Ten sam sędzia i te same kryteria dla wszystkich prób.** Zmiana modelu sędziego, wersji `agy` lub identyfikatora rubryki (`rubric:` w `benchmark/runner.yaml`) oznacza nową, nieporównywalną serię.
- **Z6** **Awaria infrastruktury nie jest wynikiem.** Próba przerwana przez limit, logowanie lub dostawcę jest powtarzana, nie zapisywana jako 0.
- **Z7** **Najpierw jedna próba, potem jedna konfiguracja przez cały proces, potem reszta.** Przed każdym z tych kroków odczytuje się limit (7.2, 7.5, 7.6).
- **Z8** **Najwyżej 12 prób na konfigurację.** Ograniczenie paska zrzutów; standard to 5.
```

---

## 16. Lista kontrolna zakończenia

Konfiguracja jest zakończona, gdy każda pozycja jest spełniona:

- [ ] 5 katalogów `eval-attempts/<konfiguracja>-attempt-1…5/`
- [ ] 5 plików `eval-results/<konfiguracja>-attempt-<n>/run.json`, żaden z `"failureKind": "infra"`
- [ ] Plik `eval-results/<konfiguracja>-attempt-<n>/contract-results.json` przy każdej próbie, która nie jest niepowodzeniem modelu
- [ ] 5 plików `eval-results/<konfiguracja>-attempt-<n>/eval-results.csv`, każda ocena poniżej 1 ma uzasadnienie w kolumnie `Notes`
- [ ] `npm run process-results` wykonane; konfiguracja widoczna w podglądzie panelu z 5 próbami
- [ ] 5 zrzutów ekranu i pasek zbiorczy w `website/public/screenshots/`
- [ ] Zmiany zapisane (`git commit`) i wysłane (`git push`)
- [ ] Uruchomienie w zakładce Actions zakończone na zielono (o ile publikacja jest skonfigurowana)
- [ ] Odczyt limitu przed i po zapisany w notatkach

Tor jest zakończony, gdy lista jest spełniona dla wszystkich konfiguracji jego macierzy (`matrix:` w runnerze toru), a podgląd panelu pokazuje każdą z nich z 5 próbami.

---

## 17. Dokumenty źródłowe

| Dokument | Zawartość |
|---|---|
| `README.md` | Opis techniczny projektu, skrypty, procedura awaryjna dla `agy` |
| `prompt.md` | Zadanie, które dostaje każdy model |
| `benchmark/criteria.md` | Pełna definicja 14 wierszy oceny, reguł zatrzymania i progów punktacji |
| `tracks/console-hard/benchmark/criteria.md`, `tracks/brownfield/benchmark/criteria.md` | To samo dla torów hard i brownfield |
| `benchmark/runner.yaml` | Macierz konfiguracji, sędzia, identyfikator rubryki, limity czasu |
| `images/harness/IMAGE.md` | Zawartość obrazu harnessu i sposób jego sprawdzenia |
| `.claude/skills/agrav-score-attempt/SKILL.md` | Procedura sędziego krok po kroku (tory hard i brownfield: `agrav-score-hard`, `agrav-score-brownfield`) |
| `website/DEPLOYMENT.md` | Konfiguracja publikacji (administrator) |
