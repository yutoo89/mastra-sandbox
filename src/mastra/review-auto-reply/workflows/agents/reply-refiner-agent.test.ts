import { describe, it, expect } from 'vitest';
import { evaluate } from "@mastra/evals";
import { ToneConsistencyMetric } from "@mastra/evals/nlp";
import { PromptAlignmentMetric } from "@mastra/evals/llm";
import { replyRefinerAgent } from './reply-refiner-agent';
import { openai } from '@ai-sdk/openai';

const llm = openai('gpt-4o-mini');

describe('口コミ返信改善エージェントのテスト', () => {
  // 各評価指標を個別にテスト
  it('トーン一貫性の評価', async () => {
    const metric = new ToneConsistencyMetric();
    const input = "この度は弊店をご利用いただきありがとうございました。お料理が美味しかったとのお言葉、大変嬉しく思います。またのご来店を心よりお待ちしております。";
    const result = await evaluate(replyRefinerAgent, input, metric);

    // スコアが0.7以上であることを確認（高い一貫性）
    expect(result.score).toBeGreaterThanOrEqual(0.7);
  });

  it('プロンプト指示の遵守評価', async () => {
    const instructionList = [
      '投稿者、経営者、従業員など人名を記載しないこと',
      '「〜店より」のような署名を記載しないこと',
      '返信文は端的で読みやすい形式にすること',
      '適切な改行を入れること',
      '指定の言語で返信を作成すること'
    ];

    const metric = new PromptAlignmentMetric(llm, {
      instructions: instructionList
    });

    const input = `
口コミ: 料理が美味しかったです。また来たいと思います。
ブランド: テスト食堂
店舗: 渋谷店
`;
    
    const result = await evaluate(replyRefinerAgent, input, metric);

    // スコアが0.8以上であることを確認（高い指示遵守率）
    expect(result.score).toBeGreaterThanOrEqual(0.8);
  });

  // エージェント全体の評価
  it('エージェント全体の評価', async () => {
    const input = `
口コミ: 料理が美味しかったです。スタッフの対応も良かったです。また来たいと思います。
ブランド: テスト食堂
店舗: 渋谷店
`;
    
    const response = await replyRefinerAgent.generate(input);
    
    // 返信が存在することを確認
    expect(response.text).toBeTruthy();
    
    // 返信に署名がないことを確認
    expect(response.text).not.toContain('店より');
    
    // 返信に適切な改行が含まれていることを確認
    const lineBreaks = (response.text.match(/\n/g) || []).length;
    expect(lineBreaks).toBeGreaterThan(0);
  });
}); 