import { describe, it, expect } from 'vitest';
import { add, multiply } from './utils';

describe('数学関数のテスト', () => {
  describe('add関数', () => {
    it('正の数を足し算できる', () => {
      expect(add(1, 2)).toBe(3);
    });

    it('負の数を足し算できる', () => {
      expect(add(-1, -2)).toBe(-3);
    });

    it('0を足し算できる', () => {
      expect(add(5, 0)).toBe(5);
    });
  });

  describe('multiply関数', () => {
    it('正の数を掛け算できる', () => {
      expect(multiply(2, 3)).toBe(6);
    });

    it('負の数を掛け算できる', () => {
      expect(multiply(-2, 3)).toBe(-6);
    });

    it('0を掛け算できる', () => {
      expect(multiply(5, 0)).toBe(0);
    });
  });
}); 