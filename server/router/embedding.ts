import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Embedder } from "../llm/embedder";
import { SpendCapError } from "../llm/metered";
import { LABEL_DESCRIPTIONS } from "./labels";
import { type LogRegModel, predictProba } from "./linear";
import type { RouteLabel, Router } from "./types";

const ModelSchema = Type.Object(
  {
    labels: Type.Array(Type.String(), { minItems: 2 }),
    dim: Type.Integer({ minimum: 1 }),
    weights: Type.Array(Type.Array(Type.Number())),
    bias: Type.Array(Type.Number()),
    temperature: Type.Number({ exclusiveMinimum: 0 }),
  },
  { additionalProperties: true },
);

/** Validates a trained model file: known labels, consistent shapes. */
export function parseLogRegModel(json: unknown): LogRegModel {
  if (!Value.Check(ModelSchema, json)) throw new Error("router model file does not match the expected schema");
  const m = json as LogRegModel;
  const known = Object.keys(LABEL_DESCRIPTIONS);
  if (!m.labels.every((l) => known.includes(l))) throw new Error("router model has unknown labels");
  if (m.weights.length !== m.labels.length || m.bias.length !== m.labels.length) throw new Error("router model shape mismatch");
  if (!m.weights.every((w) => w.length === m.dim)) throw new Error("router model weight width mismatch");
  return m;
}

/**
 * Embeddings + multinomial logistic regression router (spec 6, router 2). Confidence is the temperature-scaled
 * probability of the predicted class. Provider failures return confidence 0 (clarify); the spend cap propagates.
 */
export function createEmbeddingRouter(embedder: Embedder, model: LogRegModel, version: string): Router {
  if (embedder.dim !== model.dim) throw new Error(`embedder dim ${embedder.dim} does not match model dim ${model.dim}`);
  const name = `embed-lr@${version}`;
  return {
    name,
    async route(text) {
      try {
        const { vectors } = await embedder.embed([text], AbortSignal.timeout(5_000));
        const p = predictProba(model, vectors[0]!);
        const k = p.indexOf(Math.max(...p));
        return { label: model.labels[k] as RouteLabel, confidence: p[k]!, router: name };
      } catch (e) {
        if (e instanceof SpendCapError) throw e;
        return { label: "out_of_scope", confidence: 0, router: name };
      }
    },
  };
}
