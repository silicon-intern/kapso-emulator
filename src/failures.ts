import type { Store } from "@emulators/core";

/**
 * Failure injection: declarative rules a test (or a person) sets through
 * POST /_kapso/simulate/failures to make the emulator refuse things the way
 * real Meta and Kapso do. Rules live in the store like every other piece of
 * state, so /_kapso/simulate/reset clears them while a state_file restores
 * them.
 */

const FAILURES_KEY = "kapso.failures";

/** Refuse message sends on the Meta proxy with a Graph-shaped error. */
export interface SendFailureRule {
  /** Only fail sends to this phone (digits compared); unset fails every send. */
  to?: string;
  /** How many matching sends to fail before the rule clears itself; unset means until cleared. */
  times?: number;
  /** Overrides for the Graph error; defaults to 131026 "Message undeliverable". */
  error?: {
    code?: number;
    message?: string;
    http_status?: number;
  };
}

/** Make template review reject instead of instantly approving. */
export interface TemplateReviewRule {
  status: "REJECTED";
  /** Meta-style rejected_reason, e.g. INVALID_FORMAT or ABUSIVE_CONTENT. */
  reason?: string;
}

/** Fail specific recipients during broadcast fan-out. */
export interface BroadcastFailureRule {
  /** Recipient phones (digits compared) whose blast fails instead of delivering. */
  phones: string[];
  error_message?: string;
}

export interface FailureRules {
  send?: SendFailureRule;
  template_review?: TemplateReviewRule;
  broadcast?: BroadcastFailureRule;
}

const DEFAULT_SEND_ERROR = {
  code: 131026,
  message: "Message undeliverable",
  http_status: 400,
} as const;

export const DEFAULT_TEMPLATE_REJECTION_REASON = "INVALID_FORMAT";
export const DEFAULT_BROADCAST_ERROR_MESSAGE = "Message undeliverable";

export function getFailureRules(store: Store): FailureRules {
  return store.getData<FailureRules>(FAILURES_KEY) ?? {};
}

export function setFailureRules(store: Store, rules: FailureRules): FailureRules {
  store.setData(FAILURES_KEY, rules);
  return rules;
}

export function clearFailureRules(store: Store): void {
  store.setData(FAILURES_KEY, {});
}

function digits(phone: string): string {
  if (typeof phone !== "string") return "";
  return phone.replace(/\D/g, "");
}

export interface GraphSendError {
  http_status: number;
  body: {
    error: {
      message: string;
      type: string;
      code: number;
      error_data: { messaging_product: string; details: string };
      fbtrace_id: string;
    };
  };
}

/**
 * If a send-failure rule matches this recipient, consume one occurrence
 * (counting down `times`, clearing the rule at zero) and return the Graph
 * error to respond with; otherwise return null.
 */
export function consumeSendFailure(store: Store, to: string): GraphSendError | null {
  const rules = getFailureRules(store);
  const rule = rules.send;
  if (!rule) return null;
  if (rule.to && digits(rule.to) !== digits(to)) return null;
  if (rule.times !== undefined) {
    if (rule.times <= 1) {
      setFailureRules(store, { ...rules, send: undefined });
    } else {
      setFailureRules(store, { ...rules, send: { ...rule, times: rule.times - 1 } });
    }
  }
  const code = rule.error?.code ?? DEFAULT_SEND_ERROR.code;
  const message = rule.error?.message ?? DEFAULT_SEND_ERROR.message;
  return {
    http_status: rule.error?.http_status ?? DEFAULT_SEND_ERROR.http_status,
    body: {
      error: {
        message: `(#${code}) ${message}`,
        type: "OAuthException",
        code,
        error_data: { messaging_product: "whatsapp", details: message },
        fbtrace_id: "kapso-emulator",
      },
    },
  };
}

/** The active template review outcome: REJECTED with a reason, or null to approve. */
export function templateRejection(store: Store): { reason: string } | null {
  const rule = getFailureRules(store).template_review;
  if (!rule) return null;
  return { reason: rule.reason ?? DEFAULT_TEMPLATE_REJECTION_REASON };
}

/** Broadcast fan-out failure set: digit-normalized phones plus the error message. */
export function broadcastFailures(
  store: Store,
): { phones: Set<string>; error_message: string } | null {
  const rule = getFailureRules(store).broadcast;
  if (!rule || rule.phones.length === 0) return null;
  return {
    phones: new Set(rule.phones.map(digits)),
    error_message: rule.error_message ?? DEFAULT_BROADCAST_ERROR_MESSAGE,
  };
}
