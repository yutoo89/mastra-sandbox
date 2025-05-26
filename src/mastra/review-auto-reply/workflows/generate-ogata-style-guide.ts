import path from 'path';
import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { Step, Workflow } from '@mastra/core/workflows';
import { z } from 'zod';
import Converter from 'csvtojson';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const llm = openai('gpt-4.1');

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
  tone: z.string().nullable().describe('ブランドトーン'),
  pronoun: z.string().nullable().describe('ブランドマナー'),
  paragraph: z.string().nullable().describe('返信文の構成'),
});

const createSystemInstructions = (): string => {
  return `
口コミと返信文のペアから、返信文の特徴を分析し、LLMが理解しやすい形式でガイドラインを作成してください。
返信文の特徴として、以下の点に注目してください：
- 返信文の長さや構成
- 使用されている表現や言い回し
- 感情表現の特徴
- 具体的な対応方法
- 全体的なトーン
- ブランドとしての一貫性
- お客様への敬意の表現方法

## ガイドラインの出力フォーマット
以下の形式で、明確で構造化されたガイドラインを作成してください。
各セクションには具体的な表現例を含め、箇条書きを活用して読みやすくしてください。
表現例は、できるだけ入力データから引用し、その特徴を説明する形式で記述してください。

## ブランドトーン
### 全体的なトーン
- トーンの特徴1
- トーンの特徴2
...

### 感情表現の特徴
- 特徴1
- 特徴2
...

### ブランドらしさを表現する要素
- 要素1
- 要素2
...

## ブランドマナー
### 基本的なマナー
- マナー1
- マナー2
...

## 返信文の構成
1. 冒頭の挨拶
   - 具体的な表現例
   - ブランドトーンを反映した表現例
2. 本文
   - 具体的な表現例
   - ブランドトーンを反映した表現例
3. 結びの言葉
   - 具体的な表現例
   - ブランドトーンを反映した表現例
`;
};

const createUserPrompt = (reviews: Review[]): string => {
  const pairs = reviews.map(({review_comment, reply}) => ({ review_comment, reply }));
  const pairsJson = JSON.stringify(pairs, null, 2);
  return `
以下の口コミと返信文のペアから、返信文の特徴を分析し、LLMが理解しやすい形式でガイドラインを作成してください。

\`\`\`json
${pairsJson}
\`\`\`
`;
};

const parseReviews = new Step({
  id: 'parse-reviews',
  description: 'CSV を読み込み、必要カラムのみを抽出して JSON 配列を返す',
  outputSchema: z.object({ reviews: z.array(reviewSchema) }),
  execute: async ({ context }) => {
    const csvFileName = context.triggerData?.csvFileName;
    const csvPath = path.resolve(__dirname, '../../data/csv', csvFileName!);
    try {
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
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`CSVファイルが存在しません: ${csvPath} - ${msg}`);
    }
  },
});

const styleGuideAgent = new Agent({
  name: 'Reply Feature Extraction Agent',
  model: llm,
  instructions: createSystemInstructions(),
});

const generateStyleGuide = new Step({
  id: 'generate-style-guide',
  description: '抽出結果と統計情報からマークダウン形式のスタイルガイドを生成',
  outputSchema: extractionSchema,
  execute: async ({ context }) => {
    const { reviews } = context.getStepResult(parseReviews);
    const userPrompt = createUserPrompt(reviews);
    const response = await styleGuideAgent.generate(
      [{ role: 'user', content: userPrompt }],
      { output: extractionSchema }
    );
    console.log('result: \n', response.object);
    return response.object;
  },
});

const formatStyleGuide = new Step({
  id: 'format-style-guide',
  description: '生成されたガイドラインをmarkdown形式の単一のテキストに整形し、ファイルに出力',
  outputSchema: z.object({ filePath: z.string() }),
  execute: async ({ context }) => {
    const { tone, pronoun, paragraph } = context.getStepResult(generateStyleGuide);
    const markdown = [
      '## ブランドトーン',
      tone ?? '',
      '\n## ブランドマナー',
      pronoun ?? '',
      '\n## 返信文の構成',
      paragraph ?? ''
    ].join('\n\n');

    const csvFileName = context.triggerData?.csvFileName;
    const timestamp = Date.now();
    const fileName = `style-guide-${csvFileName}-${timestamp}.md`;
    const filePath = path.resolve(__dirname, '../../data/output/structured', fileName);

    await fs.writeFile(filePath, markdown, 'utf-8');
    console.log(`Style guide written to ${filePath}`);
    return { filePath };
  },
});

const generateOgataStyleGuideWorkflow = new Workflow({
  name: 'generate-ogata-style-guide-workflow',
  triggerSchema: z.object({ csvFileName: z.string() }),
})
  .step(parseReviews)
  .then(generateStyleGuide)
  .then(formatStyleGuide);

generateOgataStyleGuideWorkflow.commit();

export { generateOgataStyleGuideWorkflow };
