import { databaseOptions } from "../server/config";
import { insertRows, truncateServing } from "../server/db/load";
import { type Param, type Sql, openDatabase } from "../server/db/sql";

/**
 * Synthetic demo serving data for running the app without the organizer dataset (team-generated, labeled as such
 * in `serving.meta`). Same contract as `serving.sqlite` from `bun run pipeline`, including the five demo personas
 * the curated build selects: normal, high_amount, fraud_suspect, repeat_complainer, suspended.
 * Deterministic: the same seed always produces the same rows.
 */

export const DEMO_CLOCK = "2026-06-17";
const WINDOW_DAYS = 180;
const LOAD_ID = "demo-seed";

/** mulberry32: tiny deterministic PRNG. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COUNTRIES = [
  { country: "México", currency: "MXN", usdRate: 1 / 17.2, cities: ["CDMX", "Guadalajara", "Monterrey", "Puebla"], accent: "mexican" },
  { country: "Colombia", currency: "COP", usdRate: 1 / 4100, cities: ["Bogotá", "Medellín", "Cali", "Barranquilla"], accent: "colombian" },
  { country: "Argentina", currency: "ARS", usdRate: 1 / 980, cities: ["Buenos Aires", "Córdoba", "Rosario", "Mendoza"], accent: "argentinian" },
] as const;

const FIRST = ["Ana", "Luis", "María", "Carlos", "Sofía", "Diego", "Valentina", "Javier", "Camila", "Andrés", "Lucía", "Mateo", "Paula", "Tomás", "Daniela"];
const LAST = ["López", "García", "Martínez", "Rodríguez", "Pérez", "Gómez", "Fernández", "Díaz", "Torres", "Ramírez", "Castro", "Romero"];
const SEGMENTS = ["Basic", "Plus", "Premium"];
const MERCHANTS: [name: string, category: string][] = [
  ["Super Ahorro", "Food"],
  ["Mercado Central", "Food"],
  ["Farmacia Salud", "Health"],
  ["Cine Estrella", "Entertainment"],
  ["Gasolinera Ruta 9", "Transport"],
  ["Viajes Andinos", "Travel"],
  ["Librería Letras", "Education"],
  ["Café Aroma", "Food"],
  ["StreamPlus", "Entertainment"],
  ["Electro Hogar", "Electronics"],
  ["Moto Rápida", "Transport"],
  ["Boutique Moda", "Clothing"],
];
const CHANNELS = ["POS", "Web", "App", "ATM"];

export interface DemoServing {
  customers: Param[][];
  products: Param[][];
  transactions: Param[][];
  complaints: Param[][];
  demoUsers: Param[][];
  meta: Param[][];
}

const id = (prefix: string, n: number, width = 12) => `${prefix}-${n.toString(36).toUpperCase().padStart(width, "0")}`;
const dayIso = (daysBack: number, hour: number, minute: number) => {
  const d = new Date(Date.parse(`${DEMO_CLOCK}T00:00:00Z`) - daysBack * 86_400_000);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildDemoServing(customers = 60, seed = 2026): DemoServing {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const out: DemoServing = { customers: [], products: [], transactions: [], complaints: [], demoUsers: [], meta: [] };
  let txN = 1;
  let cmpN = 1;

  const addTx = (
    customerId: string,
    productId: string,
    c: (typeof COUNTRIES)[number],
    t: { daysBack: number; usd: number; merchant?: [string, string]; status?: string; fraud?: number; type?: string; channel?: string; currency?: "USD" },
  ) => {
    const [merchant, category] = t.merchant ?? pick(MERCHANTS);
    const status = t.status ?? "Approved";
    const currency = t.currency ?? (r() < 0.25 ? "USD" : c.currency);
    const amount = currency === "USD" ? round2(t.usd) : round2(t.usd / c.usdRate);
    // Like the real data, ~2% of local-currency rows have no USD amount (policy escalates on null).
    const amountUsd = currency === "USD" ? amount : r() < 0.02 ? null : round2(t.usd);
    out.transactions.push([
      id("TRX", txN++, 18),
      dayIso(t.daysBack, 8 + Math.floor(r() * 13), Math.floor(r() * 60)),
      productId,
      customerId,
      t.type ?? "Purchase",
      category,
      amount,
      currency,
      amountUsd,
      t.channel ?? pick(CHANNELS),
      merchant,
      category,
      c.country,
      pick(c.cities),
      status,
      status === "Approved" ? "00" : status === "Declined" ? "05" : null,
      t.fraud ?? Math.floor(r() * 20),
      "demo.csv",
      LOAD_ID,
    ]);
  };

  for (let i = 0; i < customers; i++) {
    const c = COUNTRIES[i % COUNTRIES.length]!;
    const customerId = id("CLI", 1000 + i);
    // Persona slots first, so they are stable: 0 normal, 1 high_amount, 2 fraud_suspect, 3 repeat_complainer, 4 suspended.
    const persona = (["normal", "high_amount", "fraud_suspect", "repeat_complainer", "suspended"] as const)[i];
    const status = persona === "suspended" ? "Suspended" : i > 4 && r() < 0.04 ? "Closed" : "Active";
    out.customers.push([customerId, pick(FIRST), pick(LAST), c.country, pick(SEGMENTS), status, c.accent, "demo.csv", LOAD_ID]);
    if (persona) out.demoUsers.push([persona, customerId]);

    const card = id("PRD", 2000 + i * 2);
    const savings = id("PRD", 2001 + i * 2);
    const limit = pick([1500, 3000, 5000, 8000]);
    out.products.push([card, customerId, "Tarjeta Crédito", `****${String(1000 + Math.floor(r() * 9000))}`, "USD", round2(r() * limit * 0.6), limit, "Active", "demo.csv", LOAD_ID]);
    out.products.push([savings, customerId, "Cuenta Ahorro", `****${String(1000 + Math.floor(r() * 9000))}`, c.currency, round2((200 + r() * 4000) / c.usdRate), null, "Active", "demo.csv", LOAD_ID]);

    // Background activity over the window. Persona customers stay low-risk so only their scripted row triggers policy.
    const n = 12 + Math.floor(r() * 25);
    for (let k = 0; k < n; k++) {
      const daysBack = Math.floor(r() * WINDOW_DAYS);
      const usd = r() < 0.9 ? 5 + r() * 120 : 120 + r() * 200;
      const status = r() < 0.92 ? "Approved" : pick(["Declined", "Pending", "Reversed"]);
      const fraud = persona ? Math.floor(r() * 15) : r() < 0.03 ? 30 + Math.floor(r() * 70) : Math.floor(r() * 25);
      addTx(customerId, r() < 0.7 ? card : savings, c, { daysBack, usd, status, fraud });
    }

    // Scripted rows that make each persona demonstrate one policy path.
    if (persona === "normal" || persona === "repeat_complainer") {
      addTx(customerId, card, c, { daysBack: 7, usd: 45, merchant: ["Super Ahorro", "Food"], fraud: 4, channel: "POS", currency: "USD" });
      addTx(customerId, card, c, { daysBack: 4, usd: 20, merchant: ["Super Ahorro", "Food"], status: "Pending", fraud: 3, currency: "USD" });
    }
    if (persona === "high_amount") {
      addTx(customerId, card, c, { daysBack: 6, usd: 700, merchant: ["Boutique Moda", "Clothing"], fraud: 5, channel: "Web", currency: "USD" });
    }
    if (persona === "fraud_suspect") {
      addTx(customerId, card, c, { daysBack: 5, usd: 30, merchant: ["Moto Rápida", "Transport"], fraud: 88, channel: "App", currency: "USD" });
    }

    const complaints = persona === "repeat_complainer" ? 3 : persona ? 0 : r() < 0.15 ? 1 : 0;
    for (let k = 0; k < complaints; k++) {
      out.complaints.push([
        id("CMP", cmpN++),
        customerId,
        dayIso(20 + Math.floor(r() * 120), 10, 0),
        "Transactions",
        pick(["Cargo no reconocido", "Cobro indebido", "Transferencia fallida"]),
        pick(["Open", "Resolved", "In Progress"]),
        round2(10 + r() * 200),
        "USD",
        complaints > 1 ? 1 : 0,
        card,
        "demo.csv",
        LOAD_ID,
      ]);
    }
  }

  out.meta.push(["clock", DEMO_CLOCK], ["window_days", String(WINDOW_DAYS)], ["built_at", new Date().toISOString().slice(0, 19)], ["source", "synthetic-demo-seed"]);
  return out;
}

export const COLUMNS = {
  customers: ["customer_id", "first_name", "last_name", "country", "segment", "customer_status", "detected_accent", "source_file", "load_id"],
  products: ["product_id", "customer_id", "product_type", "product_number_masked", "currency", "current_balance", "credit_limit", "product_status", "source_file", "load_id"],
  transactions: [
    "transaction_id", "transaction_date", "product_id", "customer_id", "transaction_type", "transaction_category", "amount", "currency",
    "amount_usd", "channel", "merchant_name", "merchant_category", "transaction_country", "transaction_city", "transaction_status",
    "response_code", "fraud_score", "source_file", "load_id",
  ],
  complaints: [
    "complaint_id", "customer_id", "creation_date", "category", "subcategory", "status", "claimed_amount", "currency",
    "is_repeat_complainer", "affected_product_id", "source_file", "load_id",
  ],
  demo_users: ["persona", "customer_id"],
  meta: ["key", "value"],
} as const;

/** Replaces the serving schema with the demo data in one transaction. */
export async function seedDemo(sql: Sql, data = buildDemoServing()): Promise<Record<string, number>> {
  return sql.tx(async (tx) => {
    await truncateServing(tx);
    return {
      customers: await insertRows(tx, "serving.customers", COLUMNS.customers, data.customers),
      products: await insertRows(tx, "serving.products", COLUMNS.products, data.products),
      transactions: await insertRows(tx, "serving.transactions", COLUMNS.transactions, data.transactions),
      complaints: await insertRows(tx, "serving.complaints", COLUMNS.complaints, data.complaints),
      demo_users: await insertRows(tx, "serving.demo_users", COLUMNS.demo_users, data.demoUsers),
      meta: await insertRows(tx, "serving.meta", COLUMNS.meta, data.meta),
    };
  });
}

if (import.meta.main) {
  const opts = databaseOptions();
  const sql = await openDatabase(opts);
  try {
    const counts = await seedDemo(sql);
    console.log(`demo serving data → ${opts.databaseUrl ? "Postgres (DATABASE_URL)" : `PGlite ${opts.pgliteDir}`}`);
    console.log(counts);
  } finally {
    await sql.close();
  }
}
