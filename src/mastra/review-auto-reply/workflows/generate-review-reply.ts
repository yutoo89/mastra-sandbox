import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { Step, Workflow } from '@mastra/core/workflows';
import { z } from 'zod';
import Converter from 'csvtojson';
import * as fs from 'fs/promises';
import * as path from 'path';

/* --------------------------------------------------------------------------
 * 1. 共有リソース
 * -----------------------------------------------------------------------*/
const llm = openai('gpt-4o-mini');
// const llm = openai('o3-mini');

/** Review レコード */
const reviewSchema = z.object({
  brand_name: z.string().nullable(),
  store_name: z.string().nullable(),
  review_title: z.string().nullable(),
  review_comment: z.string().nullable(),
  locale: z.string().nullable().default('日本語'),
  rating: z.number().nullable().default(0),
  reply: z.string().nullable(),
});
type Review = z.infer<typeof reviewSchema>;

const systemPrompt = `お客様の口コミに対する返信文を作成してください。
口コミの内容や感情を適切に理解し、お客様満足度が向上するような返信文を考慮します。
返信文には適切な改行を入れてください。

# 禁止事項

- 投稿者、経営者、従業員を含め人名を記載することは禁止
- 「〜店より」のような署名を記載することは禁止

# Output Format

- 返信文は端的で、読みやすい形式にしてください。
- 返信は指定の言語で作成してください。
`;

const userExamplePrompt = `
言語:
日本語

評価(1〜5):
5

口コミ:
うまい。
`;

const assistantPrompt = `
この度はお越しいただきありがとうございます。お食事を楽しんでいただけたようで大変嬉しく思います。またのご来店を心よりお待ち申し上げております。
`;

const refineSystemPrompt = `
口コミの返信文をスタイルガイドに従って改善してください。
返信対象の口コミ、口コミが寄せられたブランドおよび店舗名を提供するので、必要に応じて使用してください。
改善後の返信文のみ出力し、余計なテキストや記号は含めないこと。
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
        locale: r.locale ?? '日本語',
        rating: Number(r.rating) || 0,
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
 * 3. 返信生成 Agent 設定
 * -----------------------------------------------------------------------*/
const replyGeneratorAgent = new Agent({
  name: 'Review Reply Generator',
  model: llm,
  instructions: systemPrompt,
});

const replyRefinerAgent = new Agent({
  name: 'Review Reply Refiner',
  model: llm,
  instructions: refineSystemPrompt,
});

/* --------------------------------------------------------------------------
 * 4. レビュー返信生成 Step
 * -----------------------------------------------------------------------*/
const generateReplies = new Step({
  id: 'generate-replies',
  description: 'レビューに対する返信を生成する',
  outputSchema: z.object({ reviews: z.array(reviewSchema.extend({ refined_reply: z.string() })) }),
  execute: async ({ context }) => {
    const { reviews } = context.getStepResult(parseReviews);
    const styleGuide = context.triggerData?.styleGuide;
    const updatedReviews = [];
    
    for (const review of reviews) {
      // 1. スタイルガイドなしで返信文を生成
      const rawUserPrompt = `
言語:
${review.locale || '日本語'}

評価(1〜5):
${review.rating || 0}

口コミ:
${review.review_comment || ''}
`;

      const rawReplyResponse = await replyGeneratorAgent.generate([
        { role: 'user', content: userExamplePrompt },
        { role: 'assistant', content: assistantPrompt },
        { role: 'user', content: rawUserPrompt }
      ]);
      
      const rawReply = rawReplyResponse.text.trim();
      
      // 2. 生成された返信文をスタイルガイドに従ってリファイン
      const refinePrompt = `
スタイルガイドに従って返信文を改善してください。

ブランド名:
${review.brand_name || ''}

店名:
${review.store_name || ''}

お客様の口コミ:
${review.review_comment || ''}

改善前の返信文:
${rawReply}

********** 以下スタイルガイド **********
${styleGuide}
`;

      const refinedReplyResponse = await replyRefinerAgent.generate([
        { role: 'user', content: refinePrompt }
      ]);
      
      const refinedReply = refinedReplyResponse.text.trim();
      
      updatedReviews.push({
        ...review,
        refined_reply: refinedReply
      });
    }
    
    return { reviews: updatedReviews };
  },
});

/* --------------------------------------------------------------------------
 * 5. CSVファイル書き出し Step
 * -----------------------------------------------------------------------*/
const writeOutputCsv = new Step({
  id: 'write-output-csv',
  description: '生成した返信を含むCSVファイルを出力する',
  outputSchema: z.object({ outputPath: z.string() }),
  execute: async ({ context }) => {
    const { reviews } = context.getStepResult(generateReplies);
    const csvPath = context.triggerData?.csvPath as string;
    
    // 元のCSVファイルのディレクトリとファイル名（拡張子なし）を取得
    const parsedPath = path.parse(csvPath);
    const outputPath = path.join(
      parsedPath.dir, 
      `${parsedPath.name}_with_styled.csv`
    );
    
    // ヘッダーを作成し、各行のデータを連結
    const headers = Object.keys(reviews[0] || {}).join(',');
    const rows = reviews.map(review => {
      return Object.values(review).map(val => {
        if (val === null) return '';
        // 文字列に含まれるカンマはダブルクォートでエスケープ
        return typeof val === 'string' ? `"${val.replace(/"/g, '""')}"` : val;
      }).join(',');
    });
    
    const csvContent = [headers, ...rows].join('\n');
    
    await fs.writeFile(outputPath, csvContent, 'utf8');
    
    return { outputPath };
  },
});

/* --------------------------------------------------------------------------
 * 6. Workflow 定義
 * -----------------------------------------------------------------------*/
const generateReviewReplyWorkflow = new Workflow({
  name: 'generate-review-reply-workflow',
  triggerSchema: z.object({ 
    csvPath: z.string(),
    styleGuide: z.string() 
  }),
})
  .step(parseReviews)
  .then(generateReplies)
  .then(writeOutputCsv);

generateReviewReplyWorkflow.commit();

export { generateReviewReplyWorkflow };
