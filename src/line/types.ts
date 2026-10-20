import { z } from 'zod';

// Webhook の本文。使う項目だけを検査し、ほかの項目は通す（LINE 側の項目追加で壊れないように）
const source = z.object({ type: z.string(), userId: z.string().optional() }).passthrough();
const base = {
  webhookEventId: z.string().min(1).max(64),
  timestamp: z.number(),
  source,
  deliveryContext: z.object({ isRedelivery: z.boolean() }).passthrough().optional(),
  mode: z.string().optional(),
};

export const lineEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...base,
      type: z.literal('message'),
      replyToken: z.string().optional(),
      message: z.object({ type: z.string(), id: z.string().optional(), text: z.string().max(5000).optional() }).passthrough(),
    })
    .passthrough(),
  z
    .object({
      ...base,
      type: z.literal('postback'),
      replyToken: z.string().optional(),
      postback: z.object({ data: z.string().max(300), params: z.record(z.string(), z.string()).optional() }).passthrough(),
    })
    .passthrough(),
  z.object({ ...base, type: z.literal('follow'), replyToken: z.string().optional() }).passthrough(),
  z.object({ ...base, type: z.literal('unfollow') }).passthrough(),
]);

export const webhookBodySchema = z.object({
  destination: z.string().optional(),
  // 対応していない種類のイベントは、ここで落とさずに後で読み飛ばす
  events: z.array(z.object({ type: z.string() }).passthrough()).max(100),
});

export type LineEvent = z.infer<typeof lineEventSchema>;

export type QuickReplyItem = {
  type: 'action';
  imageUrl?: string;
  action: { type: 'message'; label: string; text: string } | { type: 'postback'; label: string; data: string; displayText?: string };
};

export type LineMessage =
  | { type: 'text'; text: string; quickReply?: { items: QuickReplyItem[] } }
  | { type: 'flex'; altText: string; contents: FlexContainer; quickReply?: { items: QuickReplyItem[] } };

export type FlexContainer =
  { type: 'bubble'; [k: string]: unknown } | { type: 'carousel'; contents: Array<{ type: 'bubble'; [k: string]: unknown }> };
