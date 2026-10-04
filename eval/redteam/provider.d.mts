export default class AidoProvider {
  constructor(options?: { config?: Record<string, unknown> });
  id(): string;
  callApi(
    prompt: string,
    context?: { vars?: Record<string, unknown> },
  ): Promise<{
    output?: string;
    error?: string;
    metadata: { sessionId: string; outcome: string | null; ruleIds: string[]; disputes: number | null; handoffs: number | null };
  }>;
}
