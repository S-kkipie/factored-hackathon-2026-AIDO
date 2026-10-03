import { callCenterInteractions } from "./call_center_interactions";
import { complaints } from "./complaints";
import { customers } from "./customers";
import { products } from "./products";
import { transactions } from "./transactions";
import type { Contract } from "./types";

/** Load order: parents before children. */
export const CONTRACTS: readonly Contract[] = [customers, products, transactions, complaints, callCenterInteractions];

export { callCenterInteractions, complaints, customers, products, transactions };
export * from "./types";
