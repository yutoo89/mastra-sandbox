// npx tsx src/mastra/review-auto-reply/workflows/agents/reply-eval.ts
import fs from 'fs';
import path from 'path';
import csvParser from 'csv-parser';
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
  MIN = 'min',
  MAX = 'max',
  COUNT = 'count'
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

async function main() {
  // OpenAI LLMとメトリックインスタンス
  const llm = openai('gpt-4o-mini');
  const metric = new InstructionComplianceMetric(llm);

  // CSVファイルパス
  const fileName = 'AI返信検証用データ - オリエンタルホテル 京都六条_test.csv';
  const csvPath = path.resolve(__dirname, '../../../../../data/csv', fileName);
  const rows = await readCsv(csvPath);

  // スコア集計用オブジェクト
  const scores: Record<string, number[]> = {};
  guidelines.forEach((g) => (scores[g.title] = []));

  // 各行・各ガイドラインで評価
  for (const row of rows) {
    const replyText: string = row.reply;
    for (const g of guidelines) {
      const result = await metric.measure(g.instruction, replyText);
      scores[g.title].push(result.score);
      console.log(`${g.title} - reply: ${replyText.substring(0, 30)}... => ${result.score}`);
    }
  }

  // 統計量計算
  const stats: Record<string, Record<StatKey, number>> = {};
  Object.entries(scores).forEach(([title, arr]) => {
    const count = arr.length;
    const sum = arr.reduce((a, b) => a + b, 0);
    const average = sum / count;
    const variance = arr.reduce((a, b) => a + Math.pow(b - average, 2), 0) / count;
    const stddev = Math.sqrt(variance);
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    stats[title] = { average, stddev, min, max, count };
  });

  // ファイル出力
  const outPathJson = path.resolve(__dirname, 'evaluation_stats.json');
  fs.writeFileSync(outPathJson, JSON.stringify(stats, null, 2), 'utf-8');
  console.log(`Statistics saved to ${outPathJson}`);
}

main().catch((err) => {
  console.error('Error during evaluation:', err);
  process.exit(1);
});
