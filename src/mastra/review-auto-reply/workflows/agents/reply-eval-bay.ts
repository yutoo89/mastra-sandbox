// npx tsx src/mastra/review-auto-reply/workflows/agents/reply-eval.ts
import fs from 'fs';
import path from 'path';
import csvParser from 'csv-parser';
import pLimit from 'p-limit';
import { InstructionComplianceMetric } from "../evals/InstructionComplianceMetric";
import { openai } from '@ai-sdk/openai';
import { fileURLToPath } from 'url';

// ES モジュール向けに __filename/__dirname を定義
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type Guideline = { title: string; instruction: string };

enum StatKey {
  AVERAGE = 'average',
  STDDEV = 'stddev',
}

// ガイドライン定義
const guidelines: Guideline[] = [
  {
    title: '口調・敬語レベル',
    instruction:
      '文末表現は「です・ます調」を使用し、全体的に丁寧でフォーマルな印象を与えます。\n' +
      '敬語は丁寧語を中心に使用し、必要に応じて謙譲語を加えます。\n' +
      '過度な敬語や二重敬語は避け、自然な敬語表現を心がけます。\n' +
      '文章のリズム感は、短文と長文をバランスよく組み合わせ、読みやすさを重視します。'
  },
  {
    title: '一人称・代名詞',
    instruction:
      '一人称は「当ホテル」「オリエンタルホテル東京ベイ」「私共」を使用し、親しみやすさと礼節を両立します。\n' +
      '二人称は「お客様」を使用し、敬意を表します。\n' +
      '三人称については、他のお客様やスタッフに言及する際は、具体的な状況に応じて適切に使用しますが、基本的には控えます。'
  },
  {
    title: '段落構成',
    instruction:
      '各段落は2〜4文程度を目安にし、読みやすさを意識します。\n' +
      '接続詞や改行位置は、文の流れを自然にするために適宜使用します。\n' +
      '段落の種類と順序は、感謝→謝罪（必要な場合）→再訪促進→その他の順で構成します。'
  },
  {
    title: '頻出フレーズ',
    instruction:
      '感謝表現：「この度は、数あるホテルの中からオリエンタルホテル東京ベイをお選びいただきまして、誠にありがとうございました。」\n' +
      '再訪促進：「またのお越しを、スタッフ一同心よりお待ち申し上げております。」\n' +
      '謝罪表現：「お客様のご期待に沿えず申し訳ございませんでした。」\n' +
      '改善の意図：「今後もお客様が快適に過ごせるホテルであるようご指摘を糧につとめてまいります。」'
  },
  {
    title: '署名形式',
    instruction:
      '署名は「オリエンタルホテル東京ベイ　スタッフ一同」とし、統一感を持たせます。\n' +
      '担当者名や部署名は特に記載しません。'
  },
  {
    title: 'CTA（Call To Action）',
    instruction:
      '次のアクションを促す文言は、再訪促進の文脈で自然に組み込みます。\n' +
      '電話やメールの具体的な誘導は行わず、再訪を促す表現に留めます。'
  },
];

// CSVを読み込むユーティリティ
async function readCsv(filePath: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const results: any[] = [];
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (err) => reject(err));
  });
}

async function evaluateFile(fileName: string, llmMetric: InstructionComplianceMetric) {
  const csvPath = path.resolve(__dirname, '../../../../../data/csv', fileName);
  const rows = await readCsv(csvPath);

  // スコア集計用オブジェクト
  const fileScores: Record<string, number[]> = {};
  guidelines.forEach((g) => (fileScores[g.title] = []));

  // 並列実行（同時最大10）
  const limit = pLimit(10);

  for (const g of guidelines) {
    const tasks = rows.map((row) => {
      const replyText: string = row.reply;
      return limit(async () => {
        const result = await llmMetric.measure(g.instruction, replyText);
        return result.score;
      });
    });
    fileScores[g.title] = await Promise.all(tasks);
  }

  // 統計量計算（平均と標準偏差）
  const stats: Record<string, Record<StatKey, number>> = {};
  Object.entries(fileScores).forEach(([title, scores]) => {
    const count = scores.length;
    const sum = scores.reduce((a, b) => a + b, 0);
    const average = sum / count;
    const variance = scores.reduce((a, b) => a + Math.pow(b - average, 2), 0) / count;
    const stddev = Math.sqrt(variance);
    stats[title] = { average, stddev };
  });
  return stats;
}

async function main() {
  const fileNames = [
    'AI返信検証用データ - オリエンタルホテル 京都六条_test.csv',
  ];

  const llm = openai('gpt-4o-mini');
  const metric = new InstructionComplianceMetric(llm);

  // 全ファイルを評価
  const allStats: Record<string, Record<string, Record<StatKey, number>>> = {};
  for (const file of fileNames) {
    console.log(`Evaluating ${file}...`);
    allStats[file] = await evaluateFile(file, metric);
  }

  // CSV出力
  const headers = ['file', ...guidelines.map((g) => g.title)];
  const lines = [headers.join(',')];

  for (const file of fileNames) {
    const stats = allStats[file];
    const row = [
      file,
      ...guidelines.map((g) => {
        const { average, stddev } = stats[g.title];
        return `${average.toFixed(3)}±${stddev.toFixed(3)}`;
      }),
    ];
    lines.push(row.join(','));
  }

  const outPath = path.resolve(__dirname, 'evaluation_stats.csv');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
  console.log(`CSV saved to ${outPath}`);
}

main().catch((err) => {
  console.error('Error during evaluation:', err);
  process.exit(1);
});
