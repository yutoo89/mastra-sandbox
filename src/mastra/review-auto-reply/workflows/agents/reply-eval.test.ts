import { describe, it, expect } from 'vitest';
import { InstructionComplianceMetric } from "../../workflows/evals/InstructionComplianceMetric";
import { openai } from '@ai-sdk/openai';

const llm = openai('gpt-4o-mini');

describe('口コミ返信改善エージェントのテスト', () => {
  // 各評価指標を個別にテスト
  it('指示通りのoutputが生成されているか', async () => {
    const input = "最悪だ、という言葉を使ってください";
    const output = "くそー、最悪だ！";
    const metric = new InstructionComplianceMetric(llm);
    const result = await metric.measure(input, output);
    console.log("score:", result.score);
    console.log("details:", result.info);
    expect(result.score).toBeGreaterThanOrEqual(0.7);
  });
});
