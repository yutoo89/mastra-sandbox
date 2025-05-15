import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { Step, Workflow } from '@mastra/core/workflows';
import { z } from 'zod';
import Converter from 'csvtojson';
import * as fs from 'fs/promises';

/* --------------------------------------------------------------------------
 * 1. 共有リソース
 * -----------------------------------------------------------------------*/
const llm = openai('gpt-4o-mini');

/** Review レコード */
const reviewSchema = z.object({
  brand_name: z.string().nullable(),
  store_name: z.string().nullable(),
  review_title: z.string().nullable(),
  review_comment: z.string().nullable(),
  reply: z.string().nullable(),
});

type Review = z.infer<typeof reviewSchema>;

/** 抽出対象フィールドの共通スキーマ (Agent 出力) */
const extractionSchema = z.object({
  tone: z.string().nullable(), // 口調・敬語レベル
  pronoun: z.string().nullable(), // 一人称・代名詞
  length: z.string().nullable(), // 文長・総語数
  paragraph: z.string().nullable(), // 段落構成
  phrases: z.string().nullable(), // 必須句
  signature: z.string().nullable(), // 署名
  emojis: z.string().nullable(), // 絵文字・記号
  cta: z.string().nullable(), // CTA
});

/* --------------------------------------------------------------------------
 * 2. CSV → JSON 変換 Step
 * -----------------------------------------------------------------------*/
const parseReviews = new Step({
  id: 'parse-reviews',
  description: 'CSV を読み込み、必要カラムのみを抽出して JSON 配列を返す',
  outputSchema: z.object({ reviews: z.array(reviewSchema) }),
  execute: async ({ context }) => {
    const csvPath = context.triggerData?.csvPath || '../../../../data/csv/AI返信検証用データ - オリエンタルホテル 京都六条.csv';
    
    try {
      // ファイルが存在するか確認
      await fs.access(csvPath);
      const raw = await Converter({ flatKeys: true }).fromFile(csvPath);

      const reviews: Review[] = raw.map((r: any) => ({
        brand_name: r.brand_name ?? null,
        store_name: r.store_name ?? null,
        review_title: r.review_title ?? null,
        review_comment: r.review_comment ?? null,
        reply: r.reply ?? null,
      }));

      return { reviews };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`CSVファイルが存在しません: ${csvPath} - ${errorMessage}`);
    }
  },
});

/* --------------------------------------------------------------------------
 * 3. reply メトリクス計算 Step
 * -----------------------------------------------------------------------*/
const computeReplyStats = new Step({
  id: 'compute-reply-stats',
  description: 'reply 文字数中央値・絵文字中央値・頻出絵文字を計算',
  outputSchema: z.object({
    medianReplyLength: z.number(),
    medianEmojiCount: z.number(),
    commonEmojis: z.array(z.string()),
  }),
  execute: async ({ context }) => {
    const { reviews } = context.getStepResult(parseReviews);

    const emojiRegex = /[\p{Extended_Pictographic}]/gu;

    const lengths: number[] = [];
    const emojiCounts: Map<string, number> = new Map();
    const perReplyEmojiCnt: number[] = [];

    for (const { reply } of reviews) {
      if (!reply) continue;
      lengths.push(reply.length);

      const emojis = reply.match(emojiRegex) ?? [];
      perReplyEmojiCnt.push(emojis.length);

      for (const e of emojis) {
        emojiCounts.set(e, (emojiCounts.get(e) ?? 0) + 1);
      }
    }

    const median = (arr: number[]) => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    };

    const medianReplyLength = median(lengths);
    const medianEmojiCount = median(perReplyEmojiCnt);

    const commonEmojis = [...emojiCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([emoji]) => emoji);

    return { medianReplyLength, medianEmojiCount, commonEmojis };
  },
});

/* --------------------------------------------------------------------------
 * 4. 口コミ 25 件ずつ Agent 抽出 Step
 * -----------------------------------------------------------------------*/
const extractionAgent = new Agent({
  name: 'Reply Feature Extraction Agent',
  model: llm,
  instructions: `あなたは日本語の口コミ返信分析エキスパートです。与えられた口コミデータから、返信に共通する特徴を抽出し、JSON で出力してください。JSON スキーマ: ${extractionSchema.toString()}\n\n制約:\n- 入力は最大 25 件。\n- 出力は日本語で、各フィールドは null 許可。\n- 値は配列ではなく単一文字列として要約しないこと (後続で集約)。\n`,
});

const processReviews = new Step({
  id: 'process-reviews',
  description: '25 件ずつ口コミを処理し、各フィールド値を配列化',
  outputSchema: z.object({
    aggregated: z.object({
      tone: z.array(z.string().nullable()),
      pronoun: z.array(z.string().nullable()),
      length: z.array(z.string().nullable()),
      paragraph: z.array(z.string().nullable()),
      phrases: z.array(z.string().nullable()),
      signature: z.array(z.string().nullable()),
      emojis: z.array(z.string().nullable()),
      cta: z.array(z.string().nullable()),
    }),
  }),
  execute: async ({ context }) => {
    const { reviews } = context.getStepResult(parseReviews);

    const aggregated = {
      tone: [] as (string | null)[],
      pronoun: [] as (string | null)[],
      length: [] as (string | null)[],
      paragraph: [] as (string | null)[],
      phrases: [] as (string | null)[],
      signature: [] as (string | null)[],
      emojis: [] as (string | null)[],
      cta: [] as (string | null)[],
    };

    for (let i = 0; i < reviews.length; i += 25) {
      const batch = reviews.slice(i, i + 25);
      const prompt = `以下の口コミ JSON 配列 (length: ${batch.length}) から、返信の特徴を抽出してください。\n\n${JSON.stringify(batch, null, 2)}`;

      const response = await extractionAgent.generate([{ role: 'user', content: prompt }]);

      const parsed = extractionSchema.safeParse(JSON.parse(response.text));
      if (!parsed.success) {
        console.warn(`Batch ${i / 25} parse failed`);
        continue;
      }

      const data = parsed.data;
      aggregated.tone.push(data.tone);
      aggregated.pronoun.push(data.pronoun);
      aggregated.length.push(data.length);
      aggregated.paragraph.push(data.paragraph);
      aggregated.phrases.push(data.phrases);
      aggregated.signature.push(data.signature);
      aggregated.emojis.push(data.emojis);
      aggregated.cta.push(data.cta);
    }

    return { aggregated };
  },
});

/* --------------------------------------------------------------------------
 * 5. 共通特徴の要約 Step
 * -----------------------------------------------------------------------*/
const summarizerAgent = new Agent({
  name: 'Reply Feature Summarizer',
  model: llm,
  instructions: `以下の配列から共通する特徴を抽出し、単一の簡潔な日本語文字列にまとめてください。`,
});

const summarizeAggregates = new Step({
  id: 'summarize-aggregates',
  description: '配列を単一文字列に要約',
  outputSchema: z.record(z.string(), z.string()),
  execute: async ({ context }) => {
    const { aggregated } = context.getStepResult(processReviews);

    const summary: Record<string, string> = {};

    for (const [key, arr] of Object.entries(aggregated)) {
      const joined = arr.filter(Boolean).join('\n');
      const prompt = `${key} の配列:\n${joined}\n\n共通項を 1–2 文で要約してください。`;
      const resp = await summarizerAgent.generate([{ role: 'user', content: prompt }]);
      summary[key] = resp.text.trim();
    }

    return summary;
  },
});

/* --------------------------------------------------------------------------
 * 6. JSON ファイル保存 Step
 * -----------------------------------------------------------------------*/
const saveGuidelines = new Step({
  id: 'save-guidelines',
  description: '要約結果を JSON ファイルに保存',
  execute: async ({ context }) => {
    const summary = context.getStepResult(summarizeAggregates);
    const stats = context.getStepResult(computeReplyStats);

    const outObject = {
      reply_stats: stats,
      reply_guidelines: summary,
    };

    await fs.mkdir('output', { recursive: true });
    await fs.writeFile('output/reply_guidelines.json', JSON.stringify(outObject, null, 2), 'utf-8');

    return { savedPath: 'output/reply_guidelines.json' };
  },
});

/* --------------------------------------------------------------------------
 * 7. Workflow 定義
 * -----------------------------------------------------------------------*/
const reviewAutoReplyWorkflow = new Workflow({
  name: 'review-auto-reply-workflow',
  triggerSchema: z.object({ csvPath: z.string() }),
})
  .step(parseReviews)
  .then(computeReplyStats)
  .then(processReviews)
  .then(summarizeAggregates)
  .then(saveGuidelines);

reviewAutoReplyWorkflow.commit();

export { reviewAutoReplyWorkflow };
