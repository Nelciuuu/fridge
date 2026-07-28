import { buildPushPayload } from "@block65/webcrypto-web-push";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "string" },
          category: {
            type: "string",
            enum: ["nabiał", "mięso", "warzywa", "owoce", "pieczywo", "mrożonki", "inne"],
          },
        },
        required: ["name", "category"],
        additionalProperties: false,
      },
    },
  },
  required: ["products"],
  additionalProperties: false,
};

const RECEIPT_PROMPT = `Masz zdjęcie paragonu ze sklepu spożywczego. Wypisz wszystkie zakupione produkty spożywcze
(pomiń pozycje niebędące jedzeniem, np. torby, doładowania, opłaty). Dla każdego produktu podaj:
- name: nazwa produktu po polsku, krótka i czytelna (np. "Mleko 3.2%" zamiast pełnej nazwy z paragonu)
- quantity: ilość/waga jeśli widoczna na paragonie (np. "1 szt", "0.5 kg"), inaczej pomiń
- category: jedna z: nabiał, mięso, warzywa, owoce, pieczywo, mrożonki, inne

Zwróć wyłącznie dane zgodne ze schematem.`;

const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    recipes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          uses_products: { type: "array", items: { type: "string" } },
          instructions: { type: "string" },
        },
        required: ["title", "uses_products", "instructions"],
        additionalProperties: false,
      },
    },
  },
  required: ["recipes"],
  additionalProperties: false,
};

const WEEK_PLAN_SCHEMA = {
  type: "object",
  properties: {
    week_plan: {
      type: "array",
      items: {
        type: "object",
        properties: {
          day: { type: "string" },
          title: { type: "string" },
          uses_products: { type: "array", items: { type: "string" } },
          instructions: { type: "string" },
        },
        required: ["day", "title", "uses_products", "instructions"],
        additionalProperties: false,
      },
    },
    shopping_suggestions: { type: "array", items: { type: "string" } },
  },
  required: ["week_plan", "shopping_suggestions"],
  additionalProperties: false,
};

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(env) },
  });
}

async function verifyUser(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: env.SUPABASE_ANON_KEY },
  });
  if (!res.ok) return null;
  return res.json();
}

async function callAnthropic(env, { system, content, schema, maxTokens }) {
  if (!env.ANTHROPIC_API_KEY) {
    const err = new Error("Funkcje AI nie są jeszcze skonfigurowane (brak ANTHROPIC_API_KEY).");
    err.status = 503;
    throw err;
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
      max_tokens: maxTokens,
      system,
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  if (data.stop_reason === "refusal") {
    throw new Error("Model odmówił przetworzenia żądania");
  }
  const textBlock = data.content.find((b) => b.type === "text");
  return JSON.parse(textBlock.text);
}

async function handleReceipt(request, env) {
  const user = await verifyUser(request, env);
  if (!user) return json({ error: "Brak autoryzacji" }, env, 401);

  const body = await request.json();
  if (!body.image || !body.mime) {
    return json({ error: "Wymagane pola: image (base64), mime" }, env, 400);
  }

  const result = await callAnthropic(env, {
    maxTokens: 2048,
    schema: RECEIPT_SCHEMA,
    content: [
      { type: "image", source: { type: "base64", media_type: body.mime, data: body.image } },
      { type: "text", text: RECEIPT_PROMPT },
    ],
  });

  return json(result, env);
}

async function handleRecipes(request, env) {
  const user = await verifyUser(request, env);
  if (!user) return json({ error: "Brak autoryzacji" }, env, 401);

  const body = await request.json();
  const products = Array.isArray(body.products) ? body.products : [];
  if (products.length === 0) {
    return json({ error: "Wymagana niepusta lista produktów" }, env, 400);
  }

  const productList = products
    .map((p) => `- ${p.name}${p.quantity ? ` (${p.quantity})` : ""}, termin: ${p.expiry_date}`)
    .join("\n");

  const result = await callAnthropic(env, {
    maxTokens: 2000,
    schema: RECIPE_SCHEMA,
    content: [
      {
        type: "text",
        text: `Poniższe produkty w lodówce kończą się w ciągu najbliższych dni:\n${productList}\n\nZaproponuj 2-3 przepisy, które wykorzystują jak najwięcej z tych produktów. Dla każdego przepisu podaj tytuł, listę wykorzystanych produktów z powyższej listy (uses_products) oraz krótki, konkretny przepis krok po kroku (instructions) po polsku.`,
      },
    ],
  });

  return json(result, env);
}

async function handleWeekPlan(request, env) {
  const user = await verifyUser(request, env);
  if (!user) return json({ error: "Brak autoryzacji" }, env, 401);

  const body = await request.json();
  const products = Array.isArray(body.products) ? body.products : [];
  if (products.length === 0) {
    return json({ error: "Wymagana niepusta lista produktów" }, env, 400);
  }

  const productList = products
    .map((p) => {
      const soon = p.expiring_soon ? " [KOŃCZY SIĘ WKRÓTCE]" : "";
      return `- ${p.name}${p.quantity ? ` (${p.quantity})` : ""}, termin: ${p.expiry_date}${soon}`;
    })
    .join("\n");

  const result = await callAnthropic(env, {
    maxTokens: 4000,
    schema: WEEK_PLAN_SCHEMA,
    content: [
      {
        type: "text",
        text: `Oto wszystkie produkty aktualnie w lodówce:\n${productList}\n\nUłóż plan obiadów na 7 dni (poniedziałek-niedziela), maksymalnie wykorzystując te produkty. Produkty oznaczone [KOŃCZY SIĘ WKRÓTCE] potraktuj priorytetowo — zaplanuj dania z ich użyciem na najbliższe dni tygodnia. Możesz zakładać dostępność podstawowych składników spożywczych (sól, przyprawy, olej, mąka, ryż, makaron) nawet jeśli nie są na liście. Dla każdego dnia podaj: dzień tygodnia (day), tytuł dania (title), użyte produkty z listy (uses_products), krótki konkretny przepis krok po kroku (instructions) po polsku. Jeśli produktów z lodówki nie starczy na cały tydzień, w polu shopping_suggestions podaj krótką listę (może być pusta) dodatkowych podstawowych składników wartych dokupienia — inaczej zwróć pustą listę.`,
      },
    ],
  });

  return json(result, env);
}

// ---------------------------------------------------------------------------
// Codzienne powiadomienia push (Cron Trigger)
// ---------------------------------------------------------------------------

async function supabaseAdminFetch(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase REST error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function supabaseAdminDelete(env, path) {
  await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "DELETE",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
}

function tomorrowISO() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function sendDailyExpiryPush(env) {
  const cutoff = tomorrowISO();

  const products = await supabaseAdminFetch(
    env,
    `/products?consumed_at=is.null&expiry_date=lte.${cutoff}&select=household_id,name,expiry_date`
  );
  if (products.length === 0) return { sent: 0, households: 0 };

  const byHousehold = new Map();
  for (const p of products) {
    if (!byHousehold.has(p.household_id)) byHousehold.set(p.household_id, []);
    byHousehold.get(p.household_id).push(p);
  }

  let sent = 0;
  for (const [householdId, items] of byHousehold) {
    const profiles = await supabaseAdminFetch(
      env,
      `/profiles?household_id=eq.${householdId}&select=id`
    );
    const userIds = profiles.map((p) => p.id);
    if (userIds.length === 0) continue;

    const subs = await supabaseAdminFetch(
      env,
      `/push_subscriptions?user_id=in.(${userIds.join(",")})&select=id,endpoint,keys`
    );

    const names = items.map((i) => i.name).join(", ");
    const body = items.length === 1 ? `${names} — kończy się termin.` : `Kończy się termin: ${names}.`;

    for (const sub of subs) {
      try {
        const payload = await buildPushPayload(
          {
            data: JSON.stringify({ title: "Lodówka", body, url: "./" }),
            options: { ttl: 60 * 60 * 12 },
          },
          { endpoint: sub.endpoint, keys: sub.keys },
          {
            subject: env.VAPID_SUBJECT,
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
          }
        );
        const pushRes = await fetch(sub.endpoint, payload);
        if (pushRes.status === 404 || pushRes.status === 410) {
          await supabaseAdminDelete(env, `/push_subscriptions?id=eq.${sub.id}`);
        } else {
          sent += 1;
        }
      } catch (err) {
        console.error("push send failed", sub.id, err);
      }
    }
  }

  return { sent, households: byHousehold.size };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/receipt") {
        return await handleReceipt(request, env);
      }
      if (request.method === "POST" && url.pathname === "/recipes") {
        return await handleRecipes(request, env);
      }
      if (request.method === "POST" && url.pathname === "/week-plan") {
        return await handleWeekPlan(request, env);
      }
    } catch (err) {
      return json({ error: err.message || "Błąd serwera" }, env, err.status || 500);
    }

    return json({ error: "Not found" }, env, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyExpiryPush(env));
  },
};
