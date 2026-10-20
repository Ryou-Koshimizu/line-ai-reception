import Anthropic from '@anthropic-ai/sdk';

export type ContentBlock = Anthropic.Beta.BetaContentBlock;
export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type ToolDef = Anthropic.Beta.BetaTool;
export type SystemBlock = Anthropic.Beta.BetaTextBlockParam;

export interface ModelRequest {
  system: SystemBlock[];
  tools: ToolDef[];
  messages: MessageParam[];
}
export interface ModelResponse {
  content: ContentBlock[];
  stop_reason: string | null;
}

/** AI の差し替え口。本番は Claude、試験は筋書きどおりに返す偽物を入れる */
export interface ChatModel {
  readonly id: string;
  create(req: ModelRequest): Promise<ModelResponse>;
}

export function claudeModel(opts: { apiKey: string; model: string; baseURL?: string }): ChatModel {
  const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 2, timeout: 60_000 });
  return {
    id: opts.model,
    async create(req) {
      const res = await client.beta.messages.create({
        model: opts.model,
        max_tokens: 2048,
        system: req.system,
        tools: req.tools,
        messages: req.messages,
        // 受付の会話は短く速く。考える深さは低めにする
        output_config: { effort: 'low' },
        // 安全のための拒否が起きたとき、サーバー側の既定の代わりのモデルで続ける
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      return { content: res.content, stop_reason: res.stop_reason };
    },
  };
}
