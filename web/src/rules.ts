/** Human-readable meaning of the rule ids agents see on a handoff card (server/rules.ts is the source of truth). */
export const RULE_TEXT: Record<string, string> = {
  POL_DSP_FRAUD: "Riesgo de fraude: fraud_score ≥ 30 o sin puntaje. Evaluar bloqueo de tarjeta.",
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
  IN_EMPTY: "Mensaje vacío o inválido.",
  IN_SIZE: "Mensaje demasiado largo.",
  IN_RATE: "Límite de mensajes por minuto.",
  IN_AUTH_001: "Credenciales de demo inválidas.",
  IN_AUTH_002: "Token inválido.",
  IN_SESSION_EXPIRED: "Sesión expirada.",
  IN_SESSION_REVOKED: "Sesión cerrada o no activa.",
  IN_ROLE: "Rol no autorizado para esta ruta.",
  IN_THREAD: "threadId distinto a la sesión.",
  BUD_SESSION: "Presupuesto de sesión agotado.",
  BUD_CALLS: "Límite de llamadas LLM por turno.",
  RT_OUT_OF_SCOPE: "Fuera de alcance: se abstiene.",
  POL_SCOPE: "Intención fuera de la política.",
  POL_READ: "Consulta de solo lectura permitida.",
  POL_DSP_OK: "Disputa automática permitida (requiere confirmación).",
  TL_NOT_FOUND: "Registro no encontrado.",
  TL_OWNER: "El registro no pertenece al cliente.",
  TL_EMPTY: "La consulta no devolvió resultados.",
  TL_BAD_INPUT: "Entrada inválida para la herramienta.",
  TL_IDEMPOTENCY_MISMATCH: "Clave de idempotencia con otro contenido.",
  TL_NOT_DISPUTABLE: "Transacción no disputable.",
  TL_ALREADY_DISPUTED: "Transacción ya disputada.",
  TL_NONCE_UNKNOWN: "Confirmación desconocida.",
  TL_NONCE_USED: "Confirmación ya usada.",
  TL_NONCE_EXPIRED: "Confirmación vencida.",
  TL_NONCE_MISMATCH: "Confirmación no corresponde a la acción.",
  RS_PII: "Dato personal en la respuesta.",
  RS_ID: "Id no respaldado por los datos.",
  RS_AMOUNT: "Monto no respaldado por los datos.",
  RS_COMMIT: "Compromiso fuera de plantilla.",
  RS_LANG: "Idioma de respuesta incorrecto.",
  RS_CITE: "Respuesta sin citar transacciones.",
  RSK_SESSION: "Umbral de riesgo de sesión.",
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
