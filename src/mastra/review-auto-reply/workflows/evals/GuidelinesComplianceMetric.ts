import { Metric, type MetricResult } from '@mastra/core/eval';
import type { LanguageModelV1, LanguageModelV1CallOptions } from '@ai-sdk/provider';
import type { JSONSchema7 } from 'json-schema';
import 'dotenv/config';

export type Guideline = { title: string; instruction: string };
export interface GuidelineResult { title: string; score: number; reasons: string[] }
export interface MultiResult { results: GuidelineResult[] }

export class GuidelinesComplianceMetric extends Metric {
  private model: LanguageModelV1;

  /**
   * 0〜10 の十段階評価を返すスキーマ。複数ガイドライン分の結果をまとめる。
   */
  private static responseSchema: JSONSchema7 = {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            score: { type: 'number', minimum: 0, maximum: 10 },
            reasons: { type: 'array', items: { type: 'string' } }
          },
          required: ['title', 'score', 'reasons'],
          additionalProperties: false
        }
      }
    },
    required: ['results'],
    additionalProperties: false
  };

  constructor(model: LanguageModelV1) {
    super();
    this.model = model;
  }

  /**
   * 単一指示の評価 (抽象メンバ measure の実装)
   */
  async measure(input: string, output: string): Promise<MetricResult> {
    const guideline: Guideline = { title: input, instruction: input };
    const res = await this.measureAll([guideline], output);
    const info = res.info as MultiResult;
    const first = info.results?.[0];
    if (first) {
      return { score: first.score / 10, info: { reasons: first.reasons } };
    }
    return { score: 0, info: {} };
  }

  /**
   * LLM プロンプトを構築: 全ガイドラインをまとめて評価依頼
   */
  private buildPrompt(guidelines: Guideline[], targetText: string) {
    const sep = '===SEPARATOR===\n';
    const list = guidelines.map((g, i) => `${i + 1}. ${g.title}: ${g.instruction}`).join('\n');
    return [
      {
        role: 'system' as const,
        content:
          '以下の複数の指示に対して、評価対象テキストの遵守度をそれぞれ0(まったく遵守していない)～10(完全に遵守)の十段階で評価し、理由も含めてJSON形式で出力してください。' +
          ' 出力は {"results":[{"title":string,"score":number,"reasons":[string]}]} の形式に従ってください。' +
          ' 必ず指示リストのすべての項目について評価し、resultsに含めてください。' + 
          ' 出力するJSONは厳密に {"results": [...]} の形式で、それ以外の説明文は含めないでください。' +
          ' 各項目のtitleは、指示リストの項目名と完全に一致させてください。' +
          ' scoreは0〜10の整数で、reasonsには評価の理由を複数含めてください。'
      },
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text:
              sep +
              '指示リスト:\n' + list + '\n' + sep +
              '評価対象テキスト:\n' + targetText + '\n' + sep
          }
        ]
      }
    ];
  }

  /**
   * 一度の LLM 呼び出しで全ガイドラインを評価
   */
  async measureAll(guidelines: Guideline[], targetText: string): Promise<MetricResult> {
    
    if (targetText.length < 10) {
      console.warn(`WARNING: Text is too short (${targetText.length} chars), may result in poor evaluation`);
    }
    
    const prompt = this.buildPrompt(guidelines, targetText);
    const options: LanguageModelV1CallOptions = {
      inputFormat: 'messages',
      mode: {
        type: 'object-json',
        schema: GuidelinesComplianceMetric.responseSchema,
        name: 'multi_guideline_compliance',
        description: '複数ガイドラインの遵守度をまとめて返す'
      },
      prompt,
      maxTokens: 1000, // 増加
      temperature: 0.1 // 低温にして決定的な応答に
    };

    try {
      const res = await this.model.doGenerate(options);
      
      if (!res.text) {
        console.error('ERROR: Empty response from LLM');
        // 空の応答の場合、ガイドラインごとにデフォルトスコアを設定
        return { 
          score: NaN, 
          info: { 
            results: guidelines.map(g => ({
              title: g.title,
              score: 5, // デフォルトスコアを5（中間）に設定
              reasons: ['LLM returned empty response']
            }))
          } 
        };
      }
      
      try {
        const parsed = JSON.parse(res.text) as MultiResult;
        
        // 結果が空の場合はデフォルト値を設定
        if (!parsed.results || !Array.isArray(parsed.results) || parsed.results.length === 0) {
          console.error('ERROR: No results in LLM response, falling back to default scores');
          return { 
            score: NaN, 
            info: { 
              results: guidelines.map(g => ({
                title: g.title,
                score: 5, // デフォルトスコアを5（中間）に設定
                reasons: ['Parsed response had empty results']
              }))
            } 
          };
        }
        
        
        // ガイドラインの数とresultsの数が一致しない場合、不足分を追加
        if (parsed.results.length < guidelines.length) {
          console.warn(`WARNING: LLM returned fewer results (${parsed.results.length}) than guidelines (${guidelines.length})`);
          
          // 不足しているガイドラインを特定
          const existingTitles = new Set(parsed.results.map(r => r.title));
          guidelines.forEach(g => {
            if (!existingTitles.has(g.title)) {
              console.warn(`Adding missing guideline: ${g.title}`);
              parsed.results.push({
                title: g.title,
                score: 5, // デフォルトスコアを5（中間）に設定
                reasons: ['This guideline was missing from LLM response']
              });
            }
          });
        }
        
        return { score: NaN, info: parsed };
      } catch (parseError) {
        console.error('ERROR: Failed to parse LLM response:', parseError, 'Response text:', res.text);
        // JSONパースエラーの場合、ガイドラインごとにデフォルトスコアを設定
        return { 
          score: NaN, 
          info: { 
            results: guidelines.map(g => ({
              title: g.title,
              score: 5, // デフォルトスコアを5（中間）に設定
              reasons: ['Failed to parse LLM response']
            }))
          } 
        };
      }
    } catch (err: any) {
      console.error('ERROR: LLM call failed:', err.message || err);
      // LLM呼び出しエラーの場合、ガイドラインごとにデフォルトスコアを設定
      return { 
        score: NaN, 
        info: { 
          results: guidelines.map(g => ({
            title: g.title,
            score: 5, // デフォルトスコアを5（中間）に設定
            reasons: ['LLM call failed: ' + (err.message || 'Unknown error')]
          }))
        } 
      };
    }
  }
}
