import type { RouteLabel } from "./types";

/** One-line definitions shared by the zero-shot router prompt and the paraphrase generator (spec 3.1). */
export const LABEL_DESCRIPTIONS: Record<RouteLabel, string> = {
  check_balance: "asks for the balance, available credit or amount owed on their own accounts, cards or loans",
  list_transactions: "asks to see or filter their own transactions (by date, merchant, amount, type)",
  explain_charge: "asks what one specific charge or transaction is, or why it is pending, declined or reversed",
  dispute_charge:
    "says a charge is unrecognized, duplicated or has the wrong amount and wants to dispute or report it",
  request_human: "explicitly asks to talk to a human agent, advisor, supervisor or the bank's staff",
  out_of_scope:
    "anything else: loans and credit products, app or login problems, branches, opening or cancelling products, lost or stolen cards, transfers and payments, refunds on demand, investments, general questions",
  greeting: "only a greeting, thanks or a closing, with no banking request",
};
