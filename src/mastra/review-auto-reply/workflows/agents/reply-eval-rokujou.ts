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

// 評価対象のカラム名リスト
const targetColumns = [
  'reply_human',
  'reply_ai_gpt_4o_mini',
  'reply_with_style_guide',
  'reply_with_style_guide_step',
];

// CSVを読み込むユーティリティ
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

// ファイル内の各カラム・ガイドラインごとに評価し、統計量を算出
async function evaluateFile(
  fileName: string,
  columns: string[],
  llmMetric: InstructionComplianceMetric
) {
  const csvPath = path.resolve(__dirname, '../../../../../data/csv', fileName);
  const rows = await readCsv(csvPath);

  // スコア集計用オブジェクト: column -> guidelineTitle -> scores[]
  const fileScores: Record<string, Record<string, number[]>> = {};
  columns.forEach(col => {
    fileScores[col] = {};
    guidelines.forEach(g => {
      fileScores[col][g.title] = [];
    });
  });

  // 並列実行（同時最大10）
  const limit = pLimit(10);

  // カラム x ガイドライン で評価タスクを実行
  for (const col of columns) {
    for (const g of guidelines) {
      const tasks = rows.map(row => limit(async () => {
        const text = row[col] ?? '';
        try {
          const result = await llmMetric.measure(g.instruction, text);
          return result.score;
        } catch (err) {
          console.error(`Error evaluating ${fileName} [${col} - ${g.title}]:`, err);
          // 失敗した場合はスコアを返さずにスキップ
          return null;
        }
      }));

      const rawScores = await Promise.all(tasks);
      // null を除外
      fileScores[col][g.title] = rawScores.filter((s): s is number => s !== null);
    }
  }

  // 統計量計算（平均と標準偏差）column -> guideline -> {average, stddev}
  const stats: Record<string, Record<string, Record<StatKey, number>>> = {};
  Object.entries(fileScores).forEach(([col, byGuideline]) => {
    stats[col] = {};
    Object.entries(byGuideline).forEach(([title, scores]) => {
      const count = scores.length;
      const sum = scores.reduce((a, b) => a + b, 0);
      const average = count > 0 ? sum / count : NaN;
      const variance = count > 0
        ? scores.reduce((a, b) => a + Math.pow(b - average, 2), 0) / count
        : NaN;
      const stddev = Math.sqrt(variance);
      stats[col][title] = { average, stddev };
    });
  });

  return stats;
}

async function main() {
  const fileName = 'オリエンタルホテル京都六条.csv';

  const llm = openai('gpt-4o-mini');
  const metric = new InstructionComplianceMetric(llm);

  console.log(`Evaluating ${fileName}...`);
  const allStats = await evaluateFile(fileName, targetColumns, metric);

  // CSV出力: column, guideline, average, stddev
  const headers = ['column', 'guideline', 'average', 'stddev'];
  const lines = [headers.join(',')];

  Object.entries(allStats).forEach(([col, byGuideline]) => {
    Object.entries(byGuideline).forEach(([title, { average, stddev }]) => {
      lines.push([col, title, average.toFixed(3), stddev.toFixed(3)].join(','));
    });
  });

  const outPath = path.resolve(__dirname, 'evaluation_stats.csv');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
  console.log(`CSV saved to ${outPath}`);
}

main().catch((err) => {
  console.error('Error during evaluation:', err);
  process.exit(1);
});
