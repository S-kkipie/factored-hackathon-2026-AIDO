export type Lang = "es" | "pt";

export interface Copy {
  brand: string;
  brandTagline: string;
  loginTitle: string;
  loginLead: string;
  loginSubtitle: string;
  heroPoints: string[];
  heroPreviewQuestion: string;
  heroPreviewAnswer: string;
  demoNote: string;
  agentConsole: string;
  persona: string;
  language: string;
  pin: string;
  pinHint: string;
  enter: string;
  loginFailed: string;
  sessionExpired: string;
  placeholder: string;
  send: string;
  thinking: string;
  confirmTitle: string;
  confirm: string;
  cancel: string;
  expiresAt: string;
  caseCreated: string;
  handoffQueued: string;
  handedOff: string;
  backToAssistant: string;
  logout: string;
  viewTrace: string;
  agent: string;
  you: string;
  assistant: string;
  turnFailed: string;
  confidence: string;
  rules: string;
  empty: string;
}

export const T: Record<Lang, Copy> = {
  es: {
    brand: "LATAM Bank",
    brandTagline: "Banca digital",
    loginTitle: "Atención al cliente",
    loginLead: "Elige un cliente de demostración. Cada uno activa un camino distinto de la política.",
    loginSubtitle: "Atención al cliente asistida por IA: saldos, movimientos y disputas, a cualquier hora.",
    heroPoints: ["Saldos y movimientos al instante", "Disputas en minutos, siempre con tu confirmación", "Un agente humano cuando lo necesites"],
    heroPreviewQuestion: "No reconozco un cargo de 45 dólares en Super Ahorro",
    heroPreviewAnswer: "Encontré el movimiento del 10 de junio. Confirma con el botón para registrar la disputa.",
    demoNote: "Entorno de demostración con datos sintéticos.",
    agentConsole: "Soy agente",
    persona: "Cliente de demostración",
    language: "Idioma",
    pin: "PIN",
    pinHint: "PIN de demostración: 2468",
    enter: "Entrar",
    loginFailed: "No pudimos iniciar sesión. Revisa el PIN.",
    sessionExpired: "Tu sesión expiró. Vuelve a entrar.",
    placeholder: "Escribe tu consulta…",
    send: "Enviar",
    thinking: "Pensando…",
    confirmTitle: "Confirma la disputa",
    confirm: "Confirmar",
    cancel: "Cancelar",
    expiresAt: "Vence a las",
    caseCreated: "Caso registrado",
    handoffQueued: "Derivado a un agente",
    handedOff: "Te está atendiendo un agente humano. Tus mensajes le llegan directamente.",
    backToAssistant: "El agente cerró el caso. El asistente vuelve a atenderte.",
    logout: "Salir",
    viewTrace: "Ver traza",
    agent: "Agente",
    you: "Tú",
    assistant: "Asistente",
    turnFailed: "No pudimos completar este turno. Intenta de nuevo.",
    confidence: "confianza",
    rules: "reglas",
    empty: "Pregunta por tu saldo, tus movimientos o un cargo que no reconoces.",
  },
  pt: {
    brand: "LATAM Bank",
    brandTagline: "Banco digital",
    loginTitle: "Atendimento ao cliente",
    loginLead: "Escolha um cliente de demonstração. Cada um ativa um caminho diferente da política.",
    loginSubtitle: "Atendimento ao cliente com IA: saldo, extrato e contestações, a qualquer hora.",
    heroPoints: ["Saldo e extrato na hora", "Contestações em minutos, sempre com sua confirmação", "Um atendente humano quando você precisar"],
    heroPreviewQuestion: "Não reconheço uma cobrança de 45 dólares no Super Ahorro",
    heroPreviewAnswer: "Encontrei a movimentação de 10 de junho. Confirme no botão para registrar a contestação.",
    demoNote: "Ambiente de demonstração com dados sintéticos.",
    agentConsole: "Sou atendente",
    persona: "Cliente de demonstração",
    language: "Idioma",
    pin: "PIN",
    pinHint: "PIN de demonstração: 2468",
    enter: "Entrar",
    loginFailed: "Não conseguimos entrar. Confira o PIN.",
    sessionExpired: "Sua sessão expirou. Entre novamente.",
    placeholder: "Escreva sua dúvida…",
    send: "Enviar",
    thinking: "Pensando…",
    confirmTitle: "Confirme a contestação",
    confirm: "Confirmar",
    cancel: "Cancelar",
    expiresAt: "Expira às",
    caseCreated: "Caso registrado",
    handoffQueued: "Transferido para um atendente",
    handedOff: "Um atendente humano está cuidando do seu caso. Suas mensagens chegam diretamente a ele.",
    backToAssistant: "O atendente encerrou o caso. O assistente volta a atender você.",
    logout: "Sair",
    viewTrace: "Ver rastreio",
    agent: "Atendente",
    you: "Você",
    assistant: "Assistente",
    turnFailed: "Não conseguimos concluir este turno. Tente novamente.",
    confidence: "confiança",
    rules: "regras",
    empty: "Pergunte sobre seu saldo, suas transações ou uma cobrança que você não reconhece.",
  },
};

/** Demo personas (pipeline/curate.ts) with the policy path each one exercises. */
export const PERSONAS: Record<string, Record<Lang, { name: string; hint: string }>> = {
  normal: {
    es: { name: "Cliente estándar", hint: "Sin alertas: consultas, explicación de cargos y disputa automática." },
    pt: { name: "Cliente padrão", hint: "Sem alertas: consultas, explicação de cobranças e contestação automática." },
  },
  high_amount: {
    es: { name: "Monto alto", hint: "Cargos sobre 250 USD: la disputa pasa a un agente humano." },
    pt: { name: "Valor alto", hint: "Cobranças acima de 250 USD: a contestação vai para um atendente." },
  },
  fraud_suspect: {
    es: { name: "Sospecha de fraude", hint: "fraud_score ≥ 30: escalamiento por posible fraude." },
    pt: { name: "Suspeita de fraude", hint: "fraud_score ≥ 30: escalonamento por possível fraude." },
  },
  repeat_complainer: {
    es: { name: "Reclamante frecuente", hint: "Historial de reclamos: las disputas van a revisión humana." },
    pt: { name: "Reclamante frequente", hint: "Histórico de reclamações: contestações vão para revisão humana." },
  },
  suspended: {
    es: { name: "Cuenta suspendida", hint: "Estado suspendido: solo atención humana." },
    pt: { name: "Conta suspensa", hint: "Status suspenso: apenas atendimento humano." },
  },
};

export const personaText = (persona: string, lang: Lang) => PERSONAS[persona]?.[lang] ?? { name: persona, hint: "" };

const STEPS: Record<string, Record<Lang, string>> = {
  router: { es: "Entendiendo tu mensaje…", pt: "Entendendo sua mensagem…" },
  extract: { es: "Leyendo los detalles…", pt: "Lendo os detalhes…" },
  resolve: { es: "Buscando la transacción…", pt: "Buscando a transação…" },
  policy: { es: "Revisando la política…", pt: "Verificando a política…" },
  fetch: { es: "Consultando tus datos…", pt: "Consultando seus dados…" },
  respond: { es: "Redactando la respuesta…", pt: "Escrevendo a resposta…" },
  confirm: { es: "Preparando la confirmación…", pt: "Preparando a confirmação…" },
  create_dispute: { es: "Registrando la disputa…", pt: "Registrando a contestação…" },
  verify: { es: "Verificando el caso…", pt: "Verificando o caso…" },
  handoff: { es: "Derivando a un agente…", pt: "Transferindo para um atendente…" },
};

/** Live status line for a graph node (STEP_STARTED); unknown or null steps read as "thinking". */
export const stepLabel = (step: string | null, lang: Lang): string => (step && STEPS[step]?.[lang]) || T[lang].thinking;
