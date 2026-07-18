# Lodówka

PWA do wspólnego zarządzania zawartością lodówki dla dwóch osób. Instalowana na
iPhone jako ikona na ekranie głównym (Safari → Udostępnij → Dodaj do ekranu
początkowego).

## Stack

- **Frontend**: czysty HTML/CSS/JS (bez frameworków), hostowany statycznie na GitHub Pages.
- **Backend danych**: Supabase (Postgres + Realtime + Auth przez magic link).
- **Backend do wywołań AI/push**: Cloudflare Worker — jedyne miejsce, gdzie żyje klucz Anthropic API.
- **AI**: Anthropic API (`claude-sonnet-5`) — odczyt paragonu ze zdjęcia i podpowiedzi kulinarne.
- **Powiadomienia**: Web Push (VAPID), wysyłane raz dziennie przez Cloudflare Cron Trigger.

## Struktura repo

```
index.html, style.css, app.js   – frontend PWA
manifest.json, sw.js, icons/    – konfiguracja PWA / service worker
config.example.js               – szablon konfiguracji klienta (config.js jest w .gitignore)
supabase/schema.sql             – schemat bazy (tabele, RLS, realtime)
worker/                         – Cloudflare Worker (proxy do Anthropic + wysyłka push)
.github/workflows/deploy-pages.yml – automatyczny deploy na GitHub Pages
```

---

## 1. Supabase — założenie projektu

1. Załóż konto / zaloguj się na https://supabase.com i kliknij **New project**.
2. Zapisz **Project URL** i klucz **anon public** (Project Settings → API) — będą potrzebne w kroku 5.
3. Otwórz **SQL Editor** → **New query**, wklej całą zawartość [`supabase/schema.sql`](supabase/schema.sql) i uruchom (**Run**).
4. Włącz magic-link auth: **Authentication → Providers → Email** — upewnij się, że "Confirm email" oraz "Email OTP" są włączone (domyślnie tak). Nie trzeba włączać haseł.
5. **Authentication → URL Configuration** → ustaw **Site URL** na docelowy adres GitHub Pages (np. `https://twoj-login.github.io/fridge/`) i dodaj go też do **Redirect URLs** — inaczej magic link nie wróci do appki.
6. Zapisz też **service_role key** (Project Settings → API → `service_role`, **sekretny**, tylko dla Workera) — potrzebny w kroku 3.
7. **Zablokuj rejestrację obcym osobom** — appka loguje się z `shouldCreateUser: false`, więc magic link dostają wyłącznie konta, które istnieją już w Supabase. Załóż ręcznie dokładnie dwa konta (Wasze e-maile):
   **Authentication → Users → Add user** → wpisz e-mail, ustaw dowolne (nieużywane) hasło, zaznacz **Auto Confirm User** → **Create user**. Powtórz dla drugiej osoby.
   Każdy inny e-mail przy próbie logowania dostanie komunikat "Ten adres e-mail nie ma dostępu do tej lodówki" — link nawet nie zostanie wysłany. Wasze adresy e-mail nigdzie nie trafiają do kodu/repo — żyją tylko w panelu Supabase.

Oboje z pary logujecie się e-mailem przez magic link (kliknięcie linku, bez
hasła — hasło ustawione w kroku 7 nigdy nie jest używane, istnieje tylko,
bo Supabase wymaga go przy ręcznym tworzeniu konta). Osoba, która loguje się
pierwsza, zakłada nową "lodówkę" (households) w appce i wysyła drugiej osobie
kod zaproszenia (widoczny pod ikoną 🔗 w appce) — druga osoba wpisuje go przy
pierwszym logowaniu.

---

## 2. VAPID — klucze do Web Push

```bash
npx web-push generate-vapid-keys
```

Wypisze `Public Key` i `Private Key`. Zapisz oba — trafią: publiczny do
`config.js`/`wrangler.toml` (bezpieczny do ujawnienia), prywatny **tylko** jako
sekret Cloudflare Workera (krok 3).

---

## 3. Cloudflare Worker — deploy

Worker jest jedynym miejscem z kluczem Anthropic API — nigdy nie trafia do
klienta ani do repo.

```bash
cd worker
npm install
npx wrangler login
```

Edytuj `wrangler.toml` — uzupełnij `[vars]`:
- `SUPABASE_URL` — z kroku 1
- `SUPABASE_ANON_KEY` — z kroku 1
- `VAPID_PUBLIC_KEY` — z kroku 2
- `ALLOWED_ORIGIN` — adres GitHub Pages, np. `https://twoj-login.github.io`

Ustaw sekrety (**nigdy** nie trafiają do repo ani do `wrangler.toml`) — `VAPID_SUBJECT`
jest tu też, bo to Twój e-mail, a `wrangler.toml` ląduje w publicznym repo:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
# wklej swój klucz z https://console.anthropic.com/settings/keys (pomiń, jeśli
# na razie rezygnujesz z funkcji AI — dopiszesz go później)

npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
# wklej "service_role" key z kroku 1.6

npx wrangler secret put VAPID_PRIVATE_KEY
# wklej Private Key z kroku 2

npx wrangler secret put VAPID_SUBJECT
# wpisz: mailto:twoj@email.pl
```

Deploy:

```bash
npx wrangler deploy
```

Wypisze adres Workera, np. `https://lodowka-worker.twoj-login.workers.dev` —
zapisz go, potrzebny w kroku 5.

Cron Trigger (`0 6 * * *` w `wrangler.toml`) wysyła powiadomienia push
automatycznie każdego dnia — nie wymaga dodatkowej konfiguracji poza
deployem.

---

## 4. Lokalne uruchomienie frontendu (opcjonalnie, przed deployem)

```bash
cp config.example.js config.js
```

Uzupełnij `config.js` wartościami z kroków 1–3 (Supabase URL/anon key, adres
Workera, VAPID public key), potem:

```bash
npx serve .
# albo: python -m http.server 8080
```

`config.js` jest w `.gitignore` — nigdy nie trafi do repo.

---

## 5. GitHub Pages — deploy frontendu

1. Utwórz **publiczne** repo na GitHubie i wypchnij ten kod:
   ```bash
   git remote add origin https://github.com/TWOJ-LOGIN/fridge.git
   git push -u origin main
   ```
2. **Settings → Pages** → Source: **GitHub Actions** (workflow `.github/workflows/deploy-pages.yml` już jest w repo).
3. **Settings → Secrets and variables → Actions → Variables** (zakładka *Variables*, nie *Secrets* — te wartości nie są tajne, trafiają jawnie do przeglądarki) dodaj:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `WORKER_URL` — adres Workera z kroku 3
   - `VAPID_PUBLIC_KEY` — z kroku 2
4. Wypchnij commit na `main` (albo uruchom workflow ręcznie: **Actions → Deploy to GitHub Pages → Run workflow**) — strona pojawi się pod `https://TWOJ-LOGIN.github.io/fridge/`.
5. Wróć do Supabase (krok 1.5) i upewnij się, że **Site URL** / **Redirect URLs** wskazują dokładnie na ten adres.

---

## Gdzie wstawiać klucze — podsumowanie

| Klucz | Gdzie | Czy tajny? |
|---|---|---|
| Anthropic API key | `wrangler secret put ANTHROPIC_API_KEY` (tylko Worker) | **Tak — nigdy do repo/klienta** |
| Supabase `service_role` | `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` (tylko Worker) | **Tak — nigdy do repo/klienta** |
| VAPID Private Key | `wrangler secret put VAPID_PRIVATE_KEY` (tylko Worker) | **Tak — nigdy do repo/klienta** |
| Supabase URL / anon key | GitHub Actions *Variables* → `config.js` (build) | Nie — chroni RLS |
| VAPID Public Key | GitHub Actions *Variables* + `wrangler.toml [vars]` | Nie |
| Worker URL | GitHub Actions *Variables* → `config.js` (build) | Nie |

---

## Instalacja na iPhone

Aplikacja pokazuje ekran onboardingowy z instrukcją przy pierwszym otwarciu w
Safari na iOS. Bez dodania do ekranu głównego (Safari → Udostępnij → Dodaj do
ekranu początkowego) **Web Push nie zadziała** — to ograniczenie iOS Safari,
nie appki.

---

## Kolejność budowy (zgodnie z założeniem projektu)

1.  Szkielet PWA (manifest, service worker, ikony) + Supabase (auth, households, RLS, realtime) + lista produktów z ręcznym dodawaniem.
2. Odczyt paragonu ze zdjęcia (Cloudflare Worker → Anthropic Vision).
3. Web Push (subskrypcja w appce + codzienny cron w Workerze).
4. Podpowiedzi kulinarne ("co ugotować").

Wszystko jest już zaimplementowane w tym repo — powyższe kroki 1–5 to
instrukcja wdrożenia na Twoje własne konta.
