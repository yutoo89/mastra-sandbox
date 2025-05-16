import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { Step, Workflow } from '@mastra/core/workflows';
import { z } from 'zod';
import Converter from 'csvtojson';
import emojiRegex from 'emoji-regex';
import * as fs from 'fs/promises';

/* --------------------------------------------------------------------------
 * 1. 共有リソース
 * -----------------------------------------------------------------------*/
const llm = openai('gpt-4o');

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
  tone: z.string().nullable().describe('口調・敬語レベル'),
  pronoun: z.string().nullable().describe('一人称・代名詞'),
  paragraph: z.string().nullable().describe('段落構成'),
  phrases: z.array(z.string()).describe('頻出フレーズ'),
  signature: z.string().nullable().describe('署名'),
  cta: z.string().nullable().describe('CTA'),
});

// extractionSchemaに統計情報を追加したスタイルガイドスキーマ
const styleGuideSchema = extractionSchema.extend({
  medianReplyLength: z.number().nullable().describe('1返信あたりの文字数の中央値'),
  standardDeviationReplyLength: z.number().nullable().describe('1返信あたりの文字数の標準偏差'),
  medianEmojiCount: z.number().nullable().describe('1返信あたりの絵文字数の中央値'),
  standardDeviationEmojiCount: z.number().nullable().describe('1返信あたりの絵文字数の標準偏差'),
  frequentlyUsedEmojis: z.array(z.string()).nullable().describe('5%以上の返信で使用された絵文字'),
  replyLengthConfidenceInterval: z.tuple([z.number(), z.number()]).nullable().describe('返信文字数の中央値±標準偏差の範囲'),
  emojiCountConfidenceInterval: z.tuple([z.number(), z.number()]).nullable().describe('絵文字数の中央値±標準偏差の範囲'),
  emojiUsageRate: z.number().nullable().describe('絵文字使用率 (%)'),
});

const extractionInstructions = `
あなたはレビュー返信スタイルガイド作成のエキスパートです。

レビューに対する過去の返信文が提供されます。
返信文に共通して見られる口調や構成などの特徴を抽出し、ブランドトーンを表現するためのスタイルガイドを作成してください。

項目:
- 口調・敬語レベル
- 一人称・代名詞
- 段落構成
  - 「感謝→ポジ要素→謝辞→改善策→再訪招待」など
- 頻出フレーズ
  - 「ご来店ありがとうございます」「またのご利用を…」など
- 署名形式
- CTA
  - 電話番号・メールへの誘導文など

制約:
- 返信文によってばらつきが大きい項目は'null'を返す
- 誰が読んでも解釈にばらつきがないように具体的なスタイルを定義する
- 各項目は日本語で返す
`;

/* --------------------------------------------------------------------------
 * 2. CSV → JSON 変換 Step
 * -----------------------------------------------------------------------*/
const parseReviews = new Step({
  id: 'parse-reviews',
  description: 'CSV を読み込み、必要カラムのみを抽出して JSON 配列を返す',
  outputSchema: z.object({ reviews: z.array(reviewSchema) }),
  execute: async ({ context }) => {
    const csvPath = context.triggerData?.csvPath;
    try {
      await fs.access(csvPath!);
      const raw = await Converter({ flatKeys: true }).fromFile(csvPath!);
      const reviews: Review[] = raw.map((r: any) => ({
        brand_name: r.brand_name ?? null,
        store_name: r.store_name ?? null,
        review_title: r.review_title ?? null,
        review_comment: r.review_comment ?? null,
        reply: r.reply ?? null,
      }));
      return { reviews };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`CSVファイルが存在しません: ${csvPath} - ${msg}`);
    }
  },
});

/* --------------------------------------------------------------------------
 * 3. reply メトリクス計算 Step
 * -----------------------------------------------------------------------*/
const computeReplyStats = new Step({
  id: 'compute-reply-stats',
  description: 'reply の統計情報（中央値・標準偏差・頻出絵文字・絵文字使用率）を計算',
  outputSchema: z.object({
    medianReplyLength: z.number(),
    standardDeviationReplyLength: z.number(),
    medianEmojiCount: z.number(),
    standardDeviationEmojiCount: z.number(),
    frequentlyUsedEmojis: z.array(z.string()),
    replyLengthConfidenceInterval: z.tuple([z.number(), z.number()]),
    emojiCountConfidenceInterval: z.tuple([z.number(), z.number()]),
    emojiUsageRate: z.number(),
  }),
  execute: async ({ context }) => {
    const { reviews } = context.getStepResult(parseReviews);
    // emoji-regex を使用して絵文字を正確にマッチ
    const emojiPattern = emojiRegex();

    const lengths: number[] = [];
    const emojiCounts: number[] = [];
    const emojiReplyMap: Map<string, Set<number>> = new Map();

    reviews.forEach(({ reply }, idx) => {
      if (!reply) return;
      // 文字単位で長さを計算
      const charCount = Array.from(reply).length;
      lengths.push(charCount);

      // 絵文字抽出
      const matches = [...reply.matchAll(emojiPattern)];
      const emojis = matches.map(m => m[0]);
      emojiCounts.push(emojis.length);

      // 各絵文字が登場した返信インデックスを記録
      new Set(emojis).forEach(e => {
        if (!emojiReplyMap.has(e)) emojiReplyMap.set(e, new Set());
        emojiReplyMap.get(e)!.add(idx);
      });
    });

    // 中央値計算
    const median = (arr: number[]): number => {
      if (!arr.length) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    };

    // 標準偏差計算
    const stdDev = (arr: number[]): number => {
      if (!arr.length) return 0;
      const mean = arr.reduce((sum, x) => sum + x, 0) / arr.length;
      const variance = arr.reduce((sum, x) => sum + (x - mean) ** 2, 0) / arr.length;
      return Math.sqrt(variance);
    };

    const medianReplyLength = median(lengths);
    const standardDeviationReplyLength = stdDev(lengths);
    const medianEmojiCount = median(emojiCounts);
    const standardDeviationEmojiCount = stdDev(emojiCounts);

    // 5%以上の返信で使われた絵文字を抽出
    const totalReplies = reviews.filter(r => r.reply).length;
    const repliesWithEmoji = reviews.filter(r => r.reply && [...r.reply.matchAll(emojiPattern)].length > 0).length;
    const emojiUsageRate = totalReplies > 0 ? (repliesWithEmoji / totalReplies) * 100 : 0;

    const frequentlyUsedEmojis = [...emojiReplyMap.entries()]
      .filter(([, idxSet]) => idxSet.size / (totalReplies || 1) >= 0.05)
      .map(([emoji]) => emoji);

    const replyCI: [number, number] = [
      Math.max(0, medianReplyLength - standardDeviationReplyLength),
      medianReplyLength + standardDeviationReplyLength,
    ];
    const emojiCI: [number, number] = [
      Math.max(0, medianEmojiCount - standardDeviationEmojiCount),
      medianEmojiCount + standardDeviationEmojiCount,
    ];

    const result = {
      medianReplyLength,
      standardDeviationReplyLength,
      medianEmojiCount,
      standardDeviationEmojiCount,
      frequentlyUsedEmojis,
      replyLengthConfidenceInterval: replyCI,
      emojiCountConfidenceInterval: emojiCI,
      emojiUsageRate,
    };
    console.log('computeReplyStats', result);
    return result;
  },
});


/* --------------------------------------------------------------------------
 * 4. 口コミ 25 件ずつ Agent 抽出 Step
 * -----------------------------------------------------------------------*/
const extractionAgent = new Agent({
  name: 'Reply Feature Extraction Agent',
  model: llm,
  instructions: extractionInstructions,
});

const processReviews = new Step({
  id: 'process-reviews',
  description: '25 件ずつ口コミを処理し、各フィールド値を配列化',
  outputSchema: z.object({
    aggregated: z.object({
      tone: z.array(z.string().nullable()),
      pronoun: z.array(z.string().nullable()),
      paragraph: z.array(z.string().nullable()),
      phrases: z.array(z.array(z.string())).nullable(),
      signature: z.array(z.string().nullable()),
      emojis: z.array(z.array(z.string()).nullable()),
      cta: z.array(z.string().nullable()),
    }),
  }),
  execute: async ({ context }) => {
    const { reviews } = context.getStepResult(parseReviews);
    const aggregated: any = {
      tone: [], pronoun: [], paragraph: [], phrases: [], signature: [], emojis: [], cta: [],
    };

    for (let i = 0; i < reviews.length; i += 25) {
      const batch = reviews.slice(i, i + 25);
      const prompt = `以下のレビュー返信文から、返信文に共通して見られる口調や構成などの特徴を抽出してください。\n\n${JSON.stringify(batch, null, 2)}`;
      try {
        const response = await extractionAgent.generate(
          [{ role: 'user', content: prompt }],
          { output: extractionSchema }
        );
        const data = response.object;
        aggregated.tone.push(data.tone);
        aggregated.pronoun.push(data.pronoun);
        aggregated.paragraph.push(data.paragraph);
        aggregated.phrases.push(data.phrases);
        aggregated.signature.push(data.signature);
        aggregated.cta.push(data.cta);
      } catch (e) {
        console.warn(`Batch ${i/25} error:`, e);
      }
    }

    console.log('aggregated', aggregated);
    return { aggregated };
  },
});

/* --------------------------------------------------------------------------
 * 5. 共通特徴の要約 Step
 * -----------------------------------------------------------------------*/
const summarizerAgent = new Agent({
  name: 'Reply Feature Summarizer',
  model: llm,
  instructions: `
あなたはレビュー返信スタイルガイド作成のエキスパートです。

レビュー返信を通じてブランドトーンを表現するためのスタイルガイドを作成してください。
複数の返信担当者が定義したスタイルガイドが提供されます。それらを統合・整理して完全なスタイルガイドを作成してください。

項目:
- 口調・敬語レベル
- 一人称・代名詞
- 段落構成
  - 「感謝→ポジ要素→謝辞→改善策→再訪招待」など
- 頻出フレーズ
  - 「ご来店ありがとうございます」「またのご利用を…」など
- 署名形式
- CTA
  - 電話番号・メールへの誘導文など

制約:
- 担当者ごとに異なるスタイルを定義している場合は多いものを採用する
- 重複するスタイルは統合する
- 誰が読んでも解釈にばらつきがないように具体的なスタイルを定義する
- 各項目は日本語で返す
`,
});

const summarizeAggregates = new Step({
  id: 'summarize-aggregates',
  description: '配列を単一ガイドに要約',
  outputSchema: extractionSchema,
  execute: async ({ context }) => {
    const { aggregated } = context.getStepResult(processReviews);
    const prompt = `以下の抽出結果をもとに、ブランドトーンを表現するスタイルガイドを具体的にまとめてください。\n\n${JSON.stringify(aggregated, null, 2)}`;
    try {
      const response = await summarizerAgent.generate(
      [{ role: 'user', content: prompt }],
      { output: extractionSchema }
      );
      console.log('summarizeAggregates', response.object);
      return response.object;
    } catch (e) {
      console.error('summarizeAggregates error', e);
      throw e;
    }
  },
});

/* --------------------------------------------------------------------------
 * 6. スタイルガイド出力 Step
 * -----------------------------------------------------------------------*/
const outputStyleGuide = new Step({
  id: 'output-style-guide',
  description: '要約結果と統計情報をコンソールログ出力',
  outputSchema: styleGuideSchema,
  execute: async ({ context }) => {
    const summary = context.getStepResult(summarizeAggregates);
    const stats = context.getStepResult(computeReplyStats);

    const labels: Record<string, string> = {
      tone: '口調・敬語レベル',
      pronoun: '一人称・代名詞',
      paragraph: '段落構成',
      phrases: '頻出フレーズ',
      signature: '署名形式',
      cta: 'CTA',
      frequentlyUsedEmojis: '頻出絵文字',
      replyLengthConfidenceInterval: '返信文字数',
    };

    const lines: string[] = [];
    Object.entries(summary).forEach(([key, value]) => {
      if (value == null) return;
      const label = labels[key] || key;
      if (key === 'phrases' && Array.isArray(value) && value.length) {
        lines.push(`- ${label}:`);
        value.forEach(phrase => lines.push(`  - \`${phrase}\``));
      } else if (Array.isArray(value)) {
        lines.push(`- ${label}: ${value.join('、')}`);
      } else if (typeof value === 'string') {
        lines.push(`- ${label}: ${value}`);
      }
    });
    if (stats.frequentlyUsedEmojis.length) {
      lines.push(`- ${labels.frequentlyUsedEmojis}: ${stats.frequentlyUsedEmojis.join('、')}`);
    }
    const [rMin, rMax] = stats.replyLengthConfidenceInterval;
    if (!(rMin === 0 && rMax === 0)) {
      lines.push(`- ${labels.replyLengthConfidenceInterval}: ${Math.round(rMin)}文字〜${Math.round(rMax)}文字`);
    }
    // emojiUsageRateが0の場合は`- 絵文字: 使用しない`と表示
    if (stats.emojiUsageRate === 0) {
      lines.push(`- 絵文字: 使用しない`);
    } else {
      lines.push(`- 絵文字使用頻度: ${stats.emojiUsageRate}% ※ 1回以上絵文字が使用された返信の割合`);
    }

    console.log('=== スタイルガイド ===');
    lines.forEach(line => console.log(line));
    return { ...summary, ...stats };
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
  .then(outputStyleGuide);

reviewAutoReplyWorkflow.commit();

export { reviewAutoReplyWorkflow };
