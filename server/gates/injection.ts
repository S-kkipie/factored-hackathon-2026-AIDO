import { fold } from "../router/keyword";

/**
 * Heuristic prompt-injection signal (ES/PT/EN). It never blocks on its own: a hit adds session risk and is audited
 * as IN_INJECTION; the policy engine escalates once accumulated risk crosses the threshold.
 */
const PATTERNS: RegExp[] = [
  /\b(ignora|olvida|omite|ignore|esqueca|desconsidere|forget|disregard)\b.{0,40}\b(instrucc?\w*|instruc\w*|reglas|regras|prompt|anteriores|previous|above)\b/,
  /\b(system prompt|prompt del sistema|prompt do sistema|developer mode|modo desarrollador|modo desenvolvedor|jailbreak|dan mode)\b/,
  /\b(eres|ahora eres|you are now|agora voce e|actua como|aja como|act as)\b.{0,30}\b(admin\w*|root|desarrollador|desenvolvedor|developer|sistema|system)\b/,
  /\b(revela|muestra|imprime|mostre|revele|print|reveal|show)\b.{0,30}\b(instrucc?\w*|instruc\w*|prompt|secreto|segredo|secret|canary|token)\b/,
  /<\/?(system|assistant|tool|instructions?)>|\[\/?(inst|system)\]|```\s*system/,
  /\b(cliente|customer|client)\s*(id)?\s*[:=]?\s*cli-[a-z0-9]{6,}/,
];

export const injectionSignal = (text: string): boolean => {
  const t = fold(text);
  return PATTERNS.some((p) => p.test(t));
};
