// npx tsx src/mastra/review-auto-reply/workflows/agents/reply-eval.ts
// ガイドラインの各項目ごとに評価するので遅い
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
    title: 'トーンと敬語',
    instruction:
      '口調: 丁寧でフォーマルな「です・ます調」を使用します。\n' +
      '敬語: 丁寧語を中心に、必要に応じて尊敬語や謙譲語を適切に使い分けます。過度な敬語や二重敬語は避け、自然な敬語表現を心がけます。\n' +
      '文章の長さ: 短文と長文をバランスよく組み合わせ、読みやすさを重視します。'
  },
  {
    title: '代名詞の使用',
    instruction:
      '一人称: 「当ホテル」や「オリエンタルホテル京都六条」を使用します。\n' +
      '二人称: 「お客様」を使用し、敬意を表します。\n' +
      '三人称: 他のお客様やスタッフに言及する際も丁寧な表現を心がけます。'
  },
  {
    title: '段落構成',
    instruction:
      '基本構成: 感謝、謝罪、改善策、再訪促進の順序で構成します。\n' +
      '段落の長さ: 各段落は100〜150文字程度を目安にし、接続詞や改行を適切に使用して読みやすさを確保します。'
  },
  {
    title: '頻出フレーズ',
    instruction:
      '感謝表現: 「この度はご宿泊いただき、誠にありがとうございます。」\n' +
      '謝罪表現: 「ご不便をおかけし申し訳ございません。」\n' +
      '再訪促進: 「またのご来館を心よりお待ち申し上げております。」'
  },
  {
    title: '署名',
    instruction:
      '形式: 「オリエンタルホテル京都六条」とし、担当者名や部署名は記載しません。連絡先も記載しません。'
  },
  {
    title: 'CTA（Call To Action）',
    instruction:
      '再訪促進: 次回のご利用を促す表現を文末に配置し、自然な形での再訪を促します。電話やメールでの直接的な誘導は行いません。'
  },
  {
    title: '絵文字の使用',
    instruction: '使用可否: 絵文字は使用しません.'
  },
  {
    title: '文字数の目安',
    instruction: '文字数: 返信は125〜357文字を目安にします.'
  }
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
