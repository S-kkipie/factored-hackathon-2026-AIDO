/** Human-readable meaning of the rule ids agents see on a handoff card (server/rules.ts is the source of truth). */
export const RULE_TEXT: Record<string, string> = {
  POL_DSP_FRAUD: "Posible fraude (fraud_score ≥ 30). Evaluar bloqueo de tarjeta.",
  POL_STATUS: "Cuenta suspendida o cerrada.",
  POL_DSP_AMOUNT: "Monto mayor a USD 250: requiere revisión humana.",
  POL_REPEAT: "Cliente con reclamos repetidos.",
  POL_DSP_MANY: "Disputa de 3 o más movimientos.",
  POL_DSP_AGE: "Movimiento con más de 90 días.",
  POL_DSP_STATUS: "Movimiento no aprobado (pendiente, rechazado o revertido).",
  POL_DSP_TYPE: "Tipo de movimiento no disputable automáticamente.",
  POL_DSP_DUP: "El movimiento ya tiene una disputa.",
  POL_DSP_NO_TARGET: "No se identificó el movimiento.",
  POL_HUMAN: "El cliente pidió hablar con una persona.",
  POL_RISK: "Riesgo de sesión acumulado alto.",
  PROV_001: "Intento de actuar con datos no confiables (procedencia).",
  IN_INJECTION: "Señal de inyección de instrucciones en el mensaje.",
  RS_CANARY: "La respuesta del modelo filtró el token canario.",
  BUD_TURNS: "Límite de turnos de la conversación.",
  BUD_TOKENS: "Límite de tokens de la conversación.",
  BUD_SPEND: "Tope de gasto diario de IA alcanzado.",
  BUD_TOTAL: "Tope de gasto total de IA alcanzado.",
  BUD_PROVIDER: "El proveedor de IA falló o no está disponible.",
  BUD_BREAKER: "Circuito del proveedor de IA abierto.",
  BUD_SAFE_MODE: "Modo seguro: sin llamadas al modelo.",
  TL_FAIL: "Una herramienta falló tras reintentos.",
  VF_READBACK: "No se pudo verificar el caso creado.",
  SC_INVALID: "El modelo devolvió datos inválidos.",
  RT_LOW_CONFIDENCE: "El asistente no entendió la intención con certeza.",
};

/** Triage order: safety and account-state cases first. */
const HIGH = new Set(["POL_DSP_FRAUD", "POL_STATUS", "PROV_001", "IN_INJECTION", "RS_CANARY", "POL_RISK"]);
const MEDIUM = new Set(["POL_DSP_AMOUNT", "POL_REPEAT", "POL_DSP_MANY", "VF_READBACK", "TL_FAIL"]);

export type Priority = "alta" | "media" | "normal";

export function priorityOf(ruleIds: readonly string[]): Priority {
  if (ruleIds.some((r) => HIGH.has(r))) return "alta";
  if (ruleIds.some((r) => MEDIUM.has(r))) return "media";
  return "normal";
}

export const PRIORITY_RANK: Record<Priority, number> = { alta: 0, media: 1, normal: 2 };
