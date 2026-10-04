import type { Database } from "bun:sqlite";
import type { Product, Transaction } from "../server/db/serving";
import { POLICY } from "../server/policy/config";

/** First day inside the 90-day dispute window, one day inside the boundary to avoid off-by-one gold. */
export const WINDOW_START = (() => {
  const d = new Date(`${POLICY.clock}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - POLICY.maxDisputeAgeDays + 1);
  return d.toISOString().slice(0, 10);
})();

export interface Pick {
  /** Stable key used for deterministic ordering. */
  key: string;
  customerId: string;
  tx?: Transaction;
  /** Another customer's transaction (cross-customer scenarios). */
  other?: Transaction;
  /** YYYY-MM with activity, and every transaction id of the customer in that month. */
  month?: string;
  monthTxIds?: string[];
  balances?: number[];
}

const TX = `t.transaction_id, t.transaction_date, t.product_id, t.customer_id, t.transaction_type, t.transaction_category,
  t.amount, t.currency, t.amount_usd, t.channel, t.merchant_name, t.merchant_category, t.transaction_country,
  t.transaction_city, t.transaction_status, t.response_code, t.fraud_score`;

const REPEATERS = "select customer_id from complaints where is_repeat_complainer = 1";
const CLEAN = `c.customer_status = 'Active' and c.customer_id not in (${REPEATERS})`;
const IN_WINDOW = `t.transaction_date >= '${WINDOW_START}' and t.transaction_date < '${POLICY.clock}T23:59:59.999'`;
const DISPUTABLE = `t.transaction_type in ('Purchase', 'Withdrawal', 'Adjustment') and t.transaction_status = 'Approved'`;
const UNIQUE_MERCHANT = `t.merchant_name is not null and (select count(*) from transactions u
  where u.customer_id = t.customer_id and u.merchant_name = t.merchant_name and u.transaction_date >= '${WINDOW_START}') = 1`;
const AUTO = `${DISPUTABLE} and t.amount_usd is not null and t.amount_usd <= ${POLICY.maxAutoUsd} and t.fraud_score is not null and t.fraud_score < ${POLICY.fraudScore}`;

const txPicks = (db: Database, where: string): Pick[] =>
  db
    .query<Transaction, []>(`select ${TX} from transactions t join customers c using (customer_id) where ${where}`)
    .all()
    .map((tx) => ({ key: tx.transaction_id, customerId: tx.customer_id, tx }));

const customers = (db: Database, where: string): Pick[] =>
  db
    .query<{ customer_id: string }, []>(`select c.customer_id from customers c where ${where}`)
    .all()
    .map((r) => ({ key: r.customer_id, customerId: r.customer_id }));

function withBalances(db: Database, picks: Pick[]): Pick[] {
  const q = db.query<Pick & Product, [string]>("select current_balance from products where customer_id = ?");
  return picks
    .map((p) => ({ ...p, balances: q.all(p.customerId).map((r) => (r as unknown as Product).current_balance) }))
    .filter((p) => (p.balances ?? []).length > 0);
}

/** Latest month with activity (May or June, the most recent data) and all of that month's transaction ids. */
function monthActivity(db: Database): Pick[] {
  const rows = db
    .query<{ customer_id: string; month: string }, []>(
      `select t.customer_id, substr(max(t.transaction_date), 1, 7) as month from transactions t join customers c using (customer_id)
       where ${CLEAN} and t.transaction_date >= '2026-05-01' group by t.customer_id`,
    )
    .all();
  const ids = db.query<{ transaction_id: string }, [string, string]>(
    "select transaction_id from transactions where customer_id = ? and substr(transaction_date, 1, 7) = ?",
  );
  return rows.map((r) => ({
    key: r.customer_id,
    customerId: r.customer_id,
    month: r.month,
    monthTxIds: ids.all(r.customer_id, r.month).map((x) => x.transaction_id),
  }));
}

function ambiguousMerchant(db: Database): Pick[] {
  return db
    .query<Transaction, []>(
      `select ${TX} from transactions t join customers c using (customer_id)
       where ${CLEAN} and ${IN_WINDOW} and t.merchant_name is not null
         and (select count(*) from transactions u where u.customer_id = t.customer_id and u.merchant_name = t.merchant_name
              and u.transaction_date >= '${WINDOW_START}') >= 2
         and t.transaction_id = (select min(v.transaction_id) from transactions v where v.customer_id = t.customer_id
              and v.merchant_name = t.merchant_name and v.transaction_date >= '${WINDOW_START}')`,
    )
    .all()
    .map((tx) => ({ key: tx.transaction_id, customerId: tx.customer_id, tx }));
}

function crossCustomer(db: Database): Pick[] {
  const own = customers(db, CLEAN);
  const others = txPicks(db, `${CLEAN} and ${IN_WINDOW} and t.transaction_status = 'Approved' and t.merchant_name is not null`);
  // Pair each customer with a transaction of a different customer, deterministically by position.
  return own.flatMap((p, i) => {
    const other = others[(i * 7919) % Math.max(1, others.length)]?.tx;
    return other && other.customer_id !== p.customerId ? [{ ...p, key: `${p.customerId}:${other.transaction_id}`, other }] : [];
  });
}

export const SELECTORS = {
  withProducts: (db: Database) => withBalances(db, customers(db, CLEAN)),
  anyActive: (db: Database) => customers(db, CLEAN),
  suspended: (db: Database) => customers(db, "c.customer_status = 'Suspended'"),
  monthActivity,
  explainable: (db: Database) => txPicks(db, `${CLEAN} and ${IN_WINDOW} and ${UNIQUE_MERCHANT}`),
  autoDisputable: (db: Database) => txPicks(db, `${CLEAN} and ${IN_WINDOW} and ${AUTO} and ${UNIQUE_MERCHANT}`),
  highAmount: (db: Database) =>
    txPicks(
      db,
      `${CLEAN} and ${IN_WINDOW} and ${DISPUTABLE} and t.transaction_type = 'Purchase' and t.amount_usd > ${POLICY.maxAutoUsd}
       and t.fraud_score is not null and t.fraud_score < ${POLICY.fraudScore} and ${UNIQUE_MERCHANT}`,
    ),
  fraudTx: (db: Database) => txPicks(db, `${CLEAN} and ${IN_WINDOW} and ${DISPUTABLE} and t.fraud_score >= ${POLICY.fraudScore}`),
  repeatTx: (db: Database) =>
    txPicks(db, `c.customer_status = 'Active' and c.customer_id in (${REPEATERS}) and ${IN_WINDOW} and ${AUTO}`),
  ambiguousMerchant,
  crossCustomer,
} satisfies Record<string, (db: Database) => Pick[]>;

export type SelectorId = keyof typeof SELECTORS;
