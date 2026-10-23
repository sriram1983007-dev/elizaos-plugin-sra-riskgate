/**
 * The ElizaOS Google connector stores 768-number embeddings but asks Gemini for its default size
 * (3072), so memory search breaks. This tiny plugin asks Gemini for exactly 768 and takes priority.
 */
import { GoogleGenAI } from "@google/genai";
import { ModelType, type IAgentRuntime, type Plugin } from "@elizaos/core";

const DIM = 768;

export const geminiEmbedding768: Plugin = {
  name: "gemini-embedding-768",
  description: "Gemini embeddings at 768 dimensions",
  priority: 10,
  models: {
    [ModelType.TEXT_EMBEDDING]: async (runtime: IAgentRuntime, params: any) => {
      if (params === null) { const v = Array(DIM).fill(0); v[0] = 0.1; return v; }   // ElizaOS's size probe
      const text = typeof params === "string" ? params : params?.text ?? "";
      if (!text.trim()) { const v = Array(DIM).fill(0); v[0] = 0.3; return v; }
      const ai = new GoogleGenAI({ apiKey: String(runtime.getSetting("GOOGLE_GENERATIVE_AI_API_KEY")) });
      const res = await ai.models.embedContent({
        model: String(runtime.getSetting("GOOGLE_EMBEDDING_MODEL")),
        contents: text,
        config: { outputDimensionality: DIM },
      });
      const values = res.embeddings?.[0]?.values ?? [];
      if (values.length !== DIM) throw new Error(`Gemini returned ${values.length} numbers, expected ${DIM}`);
      return values;
    },
  },
};
