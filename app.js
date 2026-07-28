import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function showBootError(message) {
  document.querySelectorAll(".screen, .modal").forEach((el) => el.classList.add("hidden"));
  const el = document.getElementById("boot-error");
  el.textContent = message;
  el.classList.remove("hidden");
}

if (location.protocol === "file:") {
  showBootError(
    "Ta appka nie działa otwarta bezpośrednio z dysku (file://) — moduły JS wymagają serwera HTTP. " +
      "Uruchom lokalnie np. `npx serve .` albo `python -m http.server 8080` i otwórz http://localhost:..."
  );
  throw new Error("Uruchomiono przez file:// — wymagany serwer HTTP.");
}

const CFG = window.APP_CONFIG;
// Defends against stray whitespace/newlines pasted into a config value (e.g.
// GitHub repo Variables) — a trailing "\n" in a URL silently breaks fetch().
if (CFG) {
  for (const key of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "WORKER_URL", "VAPID_PUBLIC_KEY"]) {
    if (typeof CFG[key] === "string") CFG[key] = CFG[key].trim();
  }
}
if (!CFG || !CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes("YOUR-PROJECT")) {
  showBootError(
    "Brak konfiguracji: skopiuj config.example.js do config.js i uzupełnij danymi swojego projektu Supabase " +
      "(patrz README.md, sekcja 4 „Lokalne uruchomienie frontendu”)."
  );
  throw new Error("Brak config.js / niepełny window.APP_CONFIG.");
}

const supabase = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

// Domyślnie włączone — ustaw AI_ENABLED: false w config.js, jeśli w Cloudflare
// Workerze nie masz jeszcze skonfigurowanego ANTHROPIC_API_KEY.
const AI_ENABLED = CFG.AI_ENABLED !== false;

function applyFeatureFlags() {
  if (AI_ENABLED) return;
  $("btn-cook").classList.add("hidden");
  $("tab-btn-receipt").classList.add("hidden");
}

// Domyślne terminy przydatności (dni) wg kategorii z paragonu.
const CATEGORY_DAYS = {
  "nabiał": 7,
  "mięso": 3,
  "warzywa": 5,
  "owoce": 6,
  "pieczywo": 4,
  "mrożonki": 90,
  "inne": 7,
};

const state = {
  user: null,
  householdId: null,
  inviteCode: null,
  foodPreferences: "",
  products: [],
  channel: null,
  receiptItems: [],
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Ekrany / modale / toast
// ---------------------------------------------------------------------------

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.add("hidden"));
  $(id).classList.remove("hidden");
}

function openModal(id) {
  $(id).classList.remove("hidden");
}

function closeModal(id) {
  $(id).classList.add("hidden");
}

let toastTimer = null;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

document.querySelectorAll(".modal-close").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.close));
});
document.querySelectorAll(".modal").forEach((modal) => {
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
  });
});

// ---------------------------------------------------------------------------
// iOS onboarding
// ---------------------------------------------------------------------------

function isIOS() {
  return (
    /iP(hone|od|ad)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function shouldShowOnboarding() {
  return isIOS() && !isStandalone() && !localStorage.getItem("lodowka-onboarding-dismissed");
}

$("btn-onboarding-continue").addEventListener("click", () => {
  localStorage.setItem("lodowka-onboarding-dismissed", "1");
  bootAuth();
});
$("btn-onboarding-skip").addEventListener("click", () => {
  localStorage.setItem("lodowka-onboarding-dismissed", "1");
  bootAuth();
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

$("form-auth").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("input-email").value.trim();
  $("auth-status").textContent = "Wysyłanie linku...";
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      // shouldCreateUser: false — logowanie działa TYLKO dla kont, które
      // zostały wcześniej ręcznie założone w Supabase Dashboard (patrz
      // README, sekcja 1). Każdy inny e-mail dostaje odmowę już tutaj —
      // nikt obcy nie może się zarejestrować.
      shouldCreateUser: false,
      emailRedirectTo: window.location.origin + window.location.pathname,
    },
  });
  if (error) {
    const denied = /not allowed|not found|signup/i.test(error.message);
    $("auth-status").textContent = denied
      ? "Ten adres e-mail nie ma dostępu do tej lodówki."
      : `Błąd: ${error.message}`;
    return;
  }
  $("auth-status").textContent = "Link wysłany! Sprawdź skrzynkę e-mail.";
});

$("btn-logout").addEventListener("click", async () => {
  if (state.channel) supabase.removeChannel(state.channel);
  await supabase.auth.signOut();
});

async function fetchOrCreateProfile(userId, email) {
  const { data } = await supabase
    .from("profiles")
    .select("id, household_id")
    .eq("id", userId)
    .maybeSingle();
  if (data) return data;

  const { data: inserted, error } = await supabase
    .from("profiles")
    .insert({ id: userId, email })
    .select()
    .single();
  if (error) throw error;
  return inserted;
}

async function enterAfterLogin(user) {
  state.user = user;
  const profile = await fetchOrCreateProfile(user.id, user.email);
  if (!profile.household_id) {
    showScreen("screen-household");
    return;
  }
  state.householdId = profile.household_id;
  await enterApp();
}

async function bootAuth() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session) {
    await enterAfterLogin(session.user);
  } else {
    showScreen("screen-auth");
  }

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" && session) enterAfterLogin(session.user);
    if (event === "SIGNED_OUT") {
      state.user = null;
      state.householdId = null;
      showScreen("screen-auth");
    }
  });
}

// ---------------------------------------------------------------------------
// Household (join / create)
// ---------------------------------------------------------------------------

$("form-join-household").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("input-invite-code").value.trim();
  if (!code) return;
  $("household-status").textContent = "Dołączanie...";
  const { data, error } = await supabase.rpc("join_household_by_code", { code });
  if (error) {
    $("household-status").textContent = `Błąd: ${error.message}`;
    return;
  }
  state.householdId = data;
  await enterApp();
});

$("btn-create-household").addEventListener("click", async () => {
  $("household-status").textContent = "Tworzenie...";
  const { data, error } = await supabase.rpc("create_household_for_self", {
    household_name: "Nasza lodówka",
  });
  if (error) {
    $("household-status").textContent = `Błąd: ${error.message}`;
    return;
  }
  state.householdId = data;
  await enterApp();
});

$("btn-invite").addEventListener("click", () => {
  $("invite-code-display").textContent = state.inviteCode || "…";
  openModal("modal-invite");
});

async function loadHouseholdDetails() {
  const { data } = await supabase
    .from("households")
    .select("invite_code, food_preferences")
    .eq("id", state.householdId)
    .single();
  state.inviteCode = data?.invite_code || null;
  state.foodPreferences = data?.food_preferences || "";
}

$("btn-preferences").addEventListener("click", () => {
  $("input-preferences").value = state.foodPreferences || "";
  openModal("modal-preferences");
});

$("form-preferences").addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = $("input-preferences").value.trim();
  const { error } = await supabase
    .from("households")
    .update({ food_preferences: value })
    .eq("id", state.householdId);
  if (error) {
    toast(`Błąd: ${error.message}`);
    return;
  }
  state.foodPreferences = value;
  closeModal("modal-preferences");
  toast("Zapisano preferencje");
});

// ---------------------------------------------------------------------------
// Produkty — pobieranie, renderowanie, CRUD, realtime
// ---------------------------------------------------------------------------

function computeExpiryDate(category, purchaseDateStr) {
  const days = CATEGORY_DAYS[category] ?? CATEGORY_DAYS["inne"];
  const d = new Date(purchaseDateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + "T00:00:00");
  return Math.round((target - today) / 86400000);
}

function expiryClass(days) {
  if (days <= 1) return "expiry-red";
  if (days <= 3) return "expiry-orange";
  return "expiry-green";
}

async function fetchProducts() {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("household_id", state.householdId)
    .is("consumed_at", null)
    .order("expiry_date", { ascending: true });
  if (error) {
    toast(`Błąd wczytywania: ${error.message}`);
    return;
  }
  state.products = data;
  renderProducts();
}

function renderProducts() {
  const list = $("product-list");
  list.innerHTML = "";
  $("empty-state").classList.toggle("hidden", state.products.length > 0);

  for (const p of state.products) {
    const days = daysUntil(p.expiry_date);
    const li = document.createElement("li");
    li.className = `product-item ${expiryClass(days)}`;

    const main = document.createElement("div");
    main.className = "product-main";

    const name = document.createElement("div");
    name.className = "product-name";
    name.textContent = p.name;

    const meta = document.createElement("div");
    meta.className = "product-meta";

    const catSpan = document.createElement("span");
    catSpan.textContent = p.category + (p.quantity ? ` · ${p.quantity}` : "");
    meta.appendChild(catSpan);

    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.className = "product-expiry-input";
    dateInput.value = p.expiry_date;
    dateInput.addEventListener("change", () => updateExpiryDate(p.id, dateInput.value));
    meta.appendChild(dateInput);

    const daysLabel = document.createElement("span");
    daysLabel.textContent = days < 0 ? `${Math.abs(days)} dni po terminie` : days === 0 ? "dziś" : `za ${days} dni`;
    meta.appendChild(daysLabel);

    main.appendChild(name);
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "product-actions";
    const consumeBtn = document.createElement("button");
    consumeBtn.className = "btn-icon";
    consumeBtn.title = "Zjedzone / wyrzucone";
    consumeBtn.textContent = "✔";
    consumeBtn.addEventListener("click", () => markConsumed(p.id));
    actions.appendChild(consumeBtn);

    li.appendChild(main);
    li.appendChild(actions);
    list.appendChild(li);
  }
}

async function updateExpiryDate(id, newDate) {
  const { error } = await supabase.from("products").update({ expiry_date: newDate }).eq("id", id);
  if (error) toast(`Błąd: ${error.message}`);
}

async function markConsumed(id) {
  const { error } = await supabase
    .from("products")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) toast(`Błąd: ${error.message}`);
}

async function insertProducts(items) {
  const rows = items.map((it) => ({
    household_id: state.householdId,
    name: it.name,
    category: it.category,
    quantity: it.quantity || null,
    purchase_date: it.purchase_date,
    expiry_date: it.expiry_date,
    added_by: state.user.id,
  }));
  const { error } = await supabase.from("products").insert(rows);
  if (error) toast(`Błąd zapisu: ${error.message}`);
  return !error;
}

function subscribeRealtime() {
  if (state.channel) supabase.removeChannel(state.channel);
  state.channel = supabase
    .channel(`products-${state.householdId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "products",
        filter: `household_id=eq.${state.householdId}`,
      },
      () => fetchProducts()
    )
    .subscribe();
}

async function enterApp() {
  showScreen("screen-app");
  await loadHouseholdDetails();
  await fetchProducts();
  subscribeRealtime();
}

// ---------------------------------------------------------------------------
// Modal "Dodaj" — zakładki, formularz ręczny
// ---------------------------------------------------------------------------

$("btn-add").addEventListener("click", () => {
  const today = new Date().toISOString().slice(0, 10);
  $("input-purchase-date").value = today;
  $("input-expiry-date").value = computeExpiryDate($("input-category").value, today);
  $("input-name").value = "";
  $("input-quantity").value = "";
  $("receipt-review").classList.add("hidden");
  $("receipt-status").textContent = "";
  $("input-receipt-file").value = "";
  openModal("modal-add");
});

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(btn.dataset.tab).classList.add("active");
  });
});

function recomputeManualExpiry() {
  const purchase = $("input-purchase-date").value;
  const category = $("input-category").value;
  if (purchase) $("input-expiry-date").value = computeExpiryDate(category, purchase);
}
$("input-category").addEventListener("change", recomputeManualExpiry);
$("input-purchase-date").addEventListener("change", recomputeManualExpiry);

$("form-add-product").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ok = await insertProducts([
    {
      name: $("input-name").value.trim(),
      category: $("input-category").value,
      quantity: $("input-quantity").value.trim(),
      purchase_date: $("input-purchase-date").value,
      expiry_date: $("input-expiry-date").value,
    },
  ]);
  if (ok) {
    closeModal("modal-add");
    toast("Dodano produkt");
  }
});

// ---------------------------------------------------------------------------
// Paragon — wysyłka zdjęcia do Workera, przegląd, potwierdzenie
// ---------------------------------------------------------------------------

// Redraws any browser-renderable image (including iPhone HEIC/HEIF photos,
// which Anthropic's API rejects) onto a canvas and re-exports as JPEG. Also
// downscales oversized photos to keep upload size and AI cost reasonable.
function fileToJpegBase64(file, maxDim = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", quality).split(",")[1]);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Nie udało się wczytać zdjęcia. Spróbuj innego pliku (JPG/PNG)."));
    };
    img.src = url;
  });
}

$("input-receipt-file").addEventListener("change", async () => {
  const file = $("input-receipt-file").files[0];
  if (!file) return;

  $("receipt-status").textContent = "Analizuję zdjęcie...";
  $("receipt-review").classList.add("hidden");

  try {
    const base64 = await fileToJpegBase64(file);
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const res = await fetch(`${CFG.WORKER_URL}/receipt`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ image: base64, mime: "image/jpeg" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Błąd odczytu paragonu");

    const today = new Date().toISOString().slice(0, 10);
    state.receiptItems = (data.products || []).map((p) => {
      const category = CATEGORY_DAYS[p.category] ? p.category : "inne";
      return {
        name: p.name,
        category,
        quantity: p.quantity || "",
        purchase_date: today,
        expiry_date: computeExpiryDate(category, today),
      };
    });

    if (state.receiptItems.length === 0) {
      $("receipt-status").textContent = "Nie rozpoznano żadnych produktów. Spróbuj innego zdjęcia.";
      return;
    }

    $("receipt-status").textContent = "";
    renderReceiptReview();
    $("receipt-review").classList.remove("hidden");
  } catch (err) {
    $("receipt-status").textContent = `Błąd: ${err.message}`;
  }
});

function renderReceiptReview() {
  const list = $("receipt-review-list");
  list.innerHTML = "";
  state.receiptItems.forEach((item, idx) => {
    const li = document.createElement("li");
    li.className = "receipt-review-item";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = item.name;
    nameInput.addEventListener("input", () => (state.receiptItems[idx].name = nameInput.value));

    const catSelect = document.createElement("select");
    Object.keys(CATEGORY_DAYS).forEach((cat) => {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      if (cat === item.category) opt.selected = true;
      catSelect.appendChild(opt);
    });
    catSelect.addEventListener("change", () => {
      state.receiptItems[idx].category = catSelect.value;
      state.receiptItems[idx].expiry_date = computeExpiryDate(catSelect.value, item.purchase_date);
      dateInput.value = state.receiptItems[idx].expiry_date;
    });

    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.value = item.expiry_date;
    dateInput.addEventListener("change", () => (state.receiptItems[idx].expiry_date = dateInput.value));

    li.appendChild(nameInput);
    li.appendChild(catSelect);
    li.appendChild(dateInput);
    list.appendChild(li);
  });
}

$("btn-receipt-confirm").addEventListener("click", async () => {
  const ok = await insertProducts(state.receiptItems);
  if (ok) {
    closeModal("modal-add");
    toast(`Dodano ${state.receiptItems.length} produktów`);
    state.receiptItems = [];
  }
});

// ---------------------------------------------------------------------------
// Co ugotować?
// ---------------------------------------------------------------------------

$("btn-cook").addEventListener("click", () => {
  $("cook-recipes").innerHTML = "";
  $("cook-status").textContent = "";
  openModal("modal-cook");
});

function renderRecipeCard(wrap, { day, title, uses_products, instructions }) {
  const card = document.createElement("div");
  card.className = "recipe-card";
  if (day) {
    const dayLabel = document.createElement("div");
    dayLabel.className = "recipe-day";
    dayLabel.textContent = day;
    card.appendChild(dayLabel);
  }
  const h3 = document.createElement("h3");
  h3.textContent = title;
  const uses = document.createElement("div");
  uses.className = "recipe-uses";
  uses.textContent = "Wykorzystuje: " + (uses_products || []).join(", ");
  const p = document.createElement("p");
  p.textContent = instructions;
  card.appendChild(h3);
  card.appendChild(uses);
  card.appendChild(p);
  wrap.appendChild(card);
}

$("btn-cook-generate").addEventListener("click", async () => {
  const soon = state.products.filter((p) => daysUntil(p.expiry_date) <= 3);
  if (soon.length === 0) {
    $("cook-status").textContent = "Brak produktów z bliskim terminem ważności.";
    return;
  }

  $("cook-status").textContent = "Szukam przepisów...";
  $("cook-recipes").innerHTML = "";

  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const res = await fetch(`${CFG.WORKER_URL}/recipes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        products: soon.map((p) => ({ name: p.name, quantity: p.quantity, expiry_date: p.expiry_date })),
        preferences: state.foodPreferences || "",
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Błąd generowania przepisów");

    $("cook-status").textContent = "";
    const wrap = $("cook-recipes");
    (data.recipes || []).forEach((r) => renderRecipeCard(wrap, r));
  } catch (err) {
    $("cook-status").textContent = `Błąd: ${err.message}`;
  }
});

$("btn-cook-week").addEventListener("click", async () => {
  if (state.products.length === 0) {
    $("cook-status").textContent = "Lodówka jest pusta — brak produktów do zaplanowania.";
    return;
  }

  $("cook-status").textContent = "Układam plan na tydzień...";
  $("cook-recipes").innerHTML = "";

  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const res = await fetch(`${CFG.WORKER_URL}/week-plan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        products: state.products.map((p) => ({
          name: p.name,
          quantity: p.quantity,
          expiry_date: p.expiry_date,
          expiring_soon: daysUntil(p.expiry_date) <= 3,
        })),
        preferences: state.foodPreferences || "",
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Błąd generowania planu");

    $("cook-status").textContent = "";
    const wrap = $("cook-recipes");
    (data.week_plan || []).forEach((r) => renderRecipeCard(wrap, r));

    if ((data.shopping_suggestions || []).length > 0) {
      const note = document.createElement("div");
      note.className = "recipe-shopping-note";
      note.textContent = "Warto dokupić: " + data.shopping_suggestions.join(", ");
      wrap.appendChild(note);
    }
  } catch (err) {
    $("cook-status").textContent = `Błąd: ${err.message}`;
  }
});

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

$("btn-push").addEventListener("click", async () => {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    toast("Powiadomienia push nie są wspierane w tej przeglądarce.");
    return;
  }
  if (isIOS() && !isStandalone()) {
    toast("Na iPhone dodaj najpierw appkę do ekranu głównego (Udostępnij → Dodaj do ekranu początkowego).");
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    toast("Brak zgody na powiadomienia.");
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(CFG.VAPID_PUBLIC_KEY),
      });
    }
    const json = subscription.toJSON();
    const { error } = await supabase
      .from("push_subscriptions")
      .upsert(
        { user_id: state.user.id, endpoint: json.endpoint, keys: json.keys },
        { onConflict: "endpoint" }
      );
    if (error) throw error;
    toast("Powiadomienia włączone!");
  } catch (err) {
    toast(`Błąd: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.error("SW register failed", err));
  });
}

applyFeatureFlags();

if (shouldShowOnboarding()) {
  showScreen("screen-onboarding");
} else {
  bootAuth();
}
