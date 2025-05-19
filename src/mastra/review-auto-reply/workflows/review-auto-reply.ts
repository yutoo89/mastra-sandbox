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
// const llm = openai('o3-mini');

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
  phrases: z.string().nullable().describe('頻出フレーズ'),
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
あなたはレビュー返信スタイルガイド作成のエキスパートLLMです。

以下の「過去の返信文リスト」を入力として受け取り、ブランドトーンを表現するためのスタイルガイドを作成してください。
誰が見ても解釈にばらつきがないように、具体的な例を示しながら、ルールや適用基準を説明的にまとめてください。

――――――――
■ 項目

1. 口調・敬語レベル：文章全体の丁寧さやフォーマル度を定義する  
    - 文末表現（です・ます調 vs. だ・である調）  
    - 敬語の種類（尊敬語／謙譲語／丁寧語）  
    - 過度な敬語／二重敬語の回避  
    - 文章のリズム感（短文／長文のバランス）  

2. 一人称・代名詞：自社や相手を指すときの呼称を統一し、親しみやすさと礼節を両立する  
    - 一人称（弊社／当店／自社）の使い分け  
    - 二人称（お客様／お客さま／お得意様）の敬称レベル  
    - 三人称（他のお客さま／スタッフ）の言及の可否

3. 段落構成：返信文の骨組みとなる段落構成パターンを定義する  
    - 各段落の長さ（文字数の目安）
    - 接続詞や改行位置の使い方
    - 段落の種類（感謝・謝罪・再訪促進・その他）と順序

4. 頻出フレーズ：ブランドらしさを担保する定型文・口ぐせ表現を定義する
    - 単調にならないようにシチュエーションごとに複数のバリエーションを用意する
    - 例：
     - 感謝表現（「ご来店ありがとうございます」「ご利用誠にありがとうございます」など）  
     - 再訪促進（「またのご来店をお待ちしております」「次回もぜひ…」など）  
     - 謝罪表現（「ご不便をおかけし申し訳ございません」「深くお詫び申し上げます」など）

5. 署名形式：返信の最後に入れる署名（担当者名・部署名・連絡先）のフォーマットを統一  
    - 名乗り方（フルネーム vs イニシャル）  
    - 部署表記（例：「カスタマーサポート」）  
    - 連絡先の有無・形式（電話番号・メールアドレス）  

6. CTA（Call To Action）：次のアクションを促す文言の形式とタイミング
    - 電話／メール誘導の表現
    - Web予約ページへのリンク案内
    - キャンペーン告知の有無

――――――――  
■ 制約  
- 返信文によってばらつきが大きい項目は \`null\` を返す  
- 誰が読んでも解釈にばらつきがない具体的な表現を使用
- 出力はmarkdown形式の日本語
- 一般的なベストプラクティスではなくブランド独自のトーンを表現する
`;

const summarizerInstructions = `
あなたはレビュー返信スタイルガイド作成のエキスパートLLMです。
各担当者が作成した返信スタイルガイドが提供されます。それらを統合した最終的なスタイルガイドをmarkdown形式で出力してください。

## 条件

- 誰が読んでも解釈にばらつきがない具体的な表現を使用
- 出力はmarkdown形式の日本語
- 一般的なベストプラクティスではなくブランド独自のトーンを表現する
- 文字数の目安と絵文字使用可否、よく使用される絵文字を必ず含める
- 段落構成・頻出フレーズ・CTAは、単調にならないようにシチュエーションごとに複数のバリエーションを用意する
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
  description: '25 件ずつ口コミを処理し、抽出結果をオブジェクトの配列として返す',
  outputSchema: z.object({ aggregated: z.array(extractionSchema) }),
  execute: async ({ context }) => {
    const { reviews } = context.getStepResult(parseReviews);
    const aggregated: z.infer<typeof extractionSchema>[] = [];

    for (let i = 0; i < reviews.length; i += 25) {
      const batch = reviews.slice(i, i + 25);
      const prompt = `以下のレビュー返信文から、返信文に共通して見られる口調や構成などの特徴を抽出してください。\n\n${JSON.stringify(batch, null, 2)}`;
      try {
        const response = await extractionAgent.generate(
          [{ role: 'user', content: prompt }],
          { output: extractionSchema }
        );
        aggregated.push(response.object);
      } catch (e) {
        console.warn(`Batch ${i/25} error:`, e);
      }
    }

    console.log('aggregated', aggregated);
    return { aggregated };
  },
});

/* --------------------------------------------------------------------------
 * 5. スタイルガイド生成 Step
 * -----------------------------------------------------------------------*/
const summarizerAgent = new Agent({
  name: 'Reply Feature Summarizer',
  model: llm,
  instructions: summarizerInstructions,
});
const generateStyleGuide = new Step({
  id: 'generate-style-guide',
  description: '抽出結果と統計情報からマークダウン形式のスタイルガイドを生成',
  outputSchema: z.object({ styleGuide: z.string() }),
  execute: async ({ context }) => {
    const { aggregated } = context.getStepResult(processReviews);
    const stats = context.getStepResult(computeReplyStats);
    // 統計情報のフィールド説明マッピング
    const statLabels: Record<string, string> = {
      medianReplyLength: '1返信あたりの文字数の中央値',
      standardDeviationReplyLength: '1返信あたりの文字数の標準偏差',
      medianEmojiCount: '1返信あたりの絵文字数の中央値',
      standardDeviationEmojiCount: '1返信あたりの絵文字数の標準偏差',
      frequentlyUsedEmojis: '5%以上の返信で使用された絵文字',
      replyLengthConfidenceInterval: '返信文字数の中央値±標準偏差の範囲',
      emojiCountConfidenceInterval: '絵文字数の中央値±標準偏差の範囲',
      emojiUsageRate: '絵文字使用率 (%)',
    };
    // stats を説明付き文字列に整形
    const statsInfo = Object.entries(stats)
      .map(([key, value]) => {
        const label = statLabels[key] || key;
        const valStr = Array.isArray(value) ? value.join('〜') : value;
        return `- ${label}: ${valStr}`;
      })
      .join('\n');

    const prompt = `以下の統計情報とスタイルガイドを基に、ブランド独自のレビュー返信スタイルガイドをMarkdown形式で作成してください。\n` +
                   `## 統計情報:\n${statsInfo}\n` +
                   `## スタイルガイド:\n${JSON.stringify(aggregated, null, 2)}`;

    console.log('prompt', prompt);
    const response = await summarizerAgent.generate(
      [{ role: 'user', content: prompt }],
      { output: z.object({ styleGuide: z.string() }) }
    );
    console.log(response.object.styleGuide);
    return response.object;
  },
});

/* --------------------------------------------------------------------------
 * 6. Workflow 定義
 * -----------------------------------------------------------------------*/
const reviewAutoReplyWorkflow = new Workflow({
  name: 'review-auto-reply-workflow',
  triggerSchema: z.object({ csvPath: z.string() }),
})
  .step(parseReviews)
  .then(computeReplyStats)
  .then(processReviews)
  .then(generateStyleGuide);

reviewAutoReplyWorkflow.commit();

export { reviewAutoReplyWorkflow };
