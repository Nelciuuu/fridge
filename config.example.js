// Skopiuj ten plik do config.js (config.js jest w .gitignore) i uzupełnij
// wartościami ze swojego projektu Supabase / Workera. Klucz "anon" Supabase
// jest bezpieczny do umieszczenia w kliencie (dostęp ogranicza RLS) —
// klucz Anthropic NIGDY tu nie trafia, żyje wyłącznie w Cloudflare Workerze.
window.APP_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-SUPABASE-ANON-KEY",
  WORKER_URL: "https://lodowka-worker.YOUR-SUBDOMAIN.workers.dev",
  VAPID_PUBLIC_KEY: "YOUR-VAPID-PUBLIC-KEY",
};
