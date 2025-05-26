import { Metric, type MetricResult } from '@mastra/core/eval';
import type { LanguageModelV1, LanguageModelV1CallOptions } from '@ai-sdk/provider';
import type { JSONSchema7 } from 'json-schema';
import 'dotenv/config';

export class InstructionComplianceMetric extends Metric {
  private model: LanguageModelV1;

  /**
   * LLM生成結果のJSONスキーマ定義（0〜10の十段階評価）
   */
  private static responseSchema: JSONSchema7 = {
    type: 'object',
    properties: {
      score: { type: 'number', minimum: 0, maximum: 10 },
      reasons: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: ['score', 'reasons'],
    additionalProperties: false
  };

  constructor(model: LanguageModelV1) {
    super();
    this.model = model;
  }

  /**
   * 指示と評価対象テキストからプロンプトを生成
   */
  private buildPrompt(instruction: string, targetText: string) {
    const separator = '===SEPARATOR===';
    return [
      {
        role: 'system' as const,
        content:
          '以下の指示に対する評価対象テキストの遵守度を、0（まったく指示に従っていない）から10（完全に指示を順守）までの十段階で評価し、理由も含めてJSON形式で出力してください。' +
          '出力するJSONは以下の形式に従い、キーは必ず "score"（数値）と "reasons"（文字列の配列）としてください。'
      },
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text:
              `${separator}\n` +
              `指示:\n${instruction}\n` +
              `${separator}\n` +
              `評価対象テキスト:\n${targetText}\n` +
              `${separator}`
          }
        ]
      }
    ];
  }

  /**
   * 指示(input)に対して、評価対象テキスト(target)がどれだけ遵守しているかを評価し、
   * 0.0〜1.0のスコアと理由(reasons[])を返す
   */
  async measure(input: string, output: string): Promise<MetricResult> {
    // プロンプト生成
    const prompt = this.buildPrompt(input, output);

    // 呼び出しオプション
    const options: LanguageModelV1CallOptions = {
      inputFormat: 'messages',
      mode: {
        type: 'object-json',
        schema: InstructionComplianceMetric.responseSchema,
        name: 'instruction_compliance',
        description: '指示遵守度を0-10で示すスコアと理由'
      },
      prompt,
      maxTokens: 200
    };

    // LLM生成
    const res = await this.model.doGenerate(options);
    const text = res.text ?? '';
    let parsed: { score: number; reasons: string[] };

    try {
      parsed = JSON.parse(text);
      // スキーマチェック
      if (
        typeof parsed.score !== 'number' ||
        parsed.score < 0 || parsed.score > 10 ||
        !Array.isArray(parsed.reasons) ||
        !parsed.reasons.every((r) => typeof r === 'string')
      ) {
        throw new Error('Response does not conform to schema');
      }
    } catch (err: any) {
      // フォールバック: スコア0
      return {
        score: 0,
        info: { raw: text, error: err.message }
      };
    }

    // 0-10の評価を0-1に正規化
    const normalizedScore = parsed.score / 10;

    return {
      score: normalizedScore,
      info: { reasons: parsed.reasons }
    };
  }
}
