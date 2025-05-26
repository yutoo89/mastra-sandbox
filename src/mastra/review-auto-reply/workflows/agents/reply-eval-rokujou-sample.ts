// 実行方法
// npx tsx src/mastra/review-auto-reply/workflows/agents/reply-eval-rokujou-sample.ts
import fs from 'fs';
import path from 'path';
import csvParser from 'csv-parser';
import pLimit from 'p-limit';
import { GuidelinesComplianceMetric, type Guideline, type MultiResult } from '../evals/GuidelinesComplianceMetric';
import { openai } from '@ai-sdk/openai';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
];

// 評価対象の列を3つに変更
const targetColumns = [
  'good_reply',
  'normal_reply',
  'bad_reply',
];

type ScoreMap = Record<string, Record<string, number[]>>;

async function readCsv(filePath: string): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    const results: Record<string, string>[] = [];
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (err) => reject(err));
  });
}

async function evaluateFile(fileName: string) {
  // --- CSV 読み込み & LLM メトリクス初期化 （省略） ---
  const csvPath = path.resolve(__dirname, '../../../../../data/csv', fileName);
  const rows = await readCsv(csvPath);
  const llm = openai('gpt-4o-mini');
  const metric = new GuidelinesComplianceMetric(llm);

  // --- スコア集計 ---
  const scores: ScoreMap = {};
  for (const col of targetColumns) {
    scores[col] = {};
    guidelines.forEach(g => { scores[col][g.title] = []; });

    const limit = pLimit(5);
    // 進捗を出力
    let count = 0;
    await Promise.all(
      rows.map(row => limit(async () => {
        count++;
        console.log(`${count}/${rows.length}`);
        const text = row[col] ?? '';
        try {
          const res = await metric.measureAll(guidelines, text);
          const info = res.info as MultiResult;
          info.results.forEach(r => {
            if (scores[col][r.title] && typeof r.score === 'number') {
              // 0–10 → 0–1 に正規化
              scores[col][r.title].push(r.score / 10);
            }
          });
        } catch (e) {
          console.error(`Error evaluating ${col}:`, e);
        }
      }))
    );
  }

  // --- 平均と標準偏差を計算 ---
  const stats: Record<string, Record<string, { average: number; stddev: number }>> = {};
  for (const col of targetColumns) {
    stats[col] = {};
    for (const g of guidelines) {
      const arr = scores[col][g.title];
      const n = arr.length;
      const sum = arr.reduce((a, b) => a + b, 0);
      const avg = n > 0 ? sum / n : NaN;
      const variance = n > 0
        ? arr.reduce((a, b) => a + (b - avg) ** 2, 0) / n
        : NaN;
      stats[col][g.title] = { average: avg, stddev: Math.sqrt(variance) };
    }
  }

  // --- CSV 出力 ---
  const outCsvPath = path.resolve(__dirname, 'evaluation_stats_sample');
  const headers = ['targetColumn', ...guidelines.map(g => g.title)];
  const lines: string[] = [];

  // ヘッダー行
  lines.push(headers.join(','));

  // 各 targetColumn ごとの結果行
  for (const col of targetColumns) {
    const row = [
      col,
      ...guidelines.map(g => {
        const { average, stddev } = stats[col][g.title];
        const avgStr = Number.isFinite(average) ? average.toFixed(3) : 'NaN';
        const sdStr  = Number.isFinite(stddev)  ? stddev.toFixed(3)  : 'NaN';
        return `${avgStr}±${sdStr}`;
      }),
    ];
    lines.push(row.join(','));
  }

  fs.writeFileSync(outCsvPath, lines.join('\n'), 'utf-8');
}

async function main() {
  try {
    await evaluateFile('オリエンタルホテル京都六条_sample.csv');
    console.log('Evaluation complete. Stats and details saved.');
  } catch (err) {
    console.error('Fatal error:', err);
  }
}

main();
