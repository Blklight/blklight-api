import { describe, it, expect } from 'vitest';
import { executeCode, transpileTS } from '../../src/utils/sandbox';
import { ValidationError } from '../../src/utils/errors';

describe('sandbox', () => {
  describe('executeCode', () => {
    it('executeCode simple console.log returns output string', async () => {
      const result = await executeCode('console.log("hello world")', 'javascript');
      expect(result).toBe('hello world');
    });

    it('executeCode TypeScript code transpiles and returns output', async () => {
      const result = await executeCode('const x: number = 1 + 2; console.log(x)', 'typescript');
      expect(result).toBe('3');
    });

    it('executeCode infinite loop throws ValidationError (timeout)', async () => {
      await expect(
        executeCode('while(true) {}', 'javascript', 1000)
      ).rejects.toThrow(ValidationError);
    });

    it('executeCode runtime error throws ValidationError with message', async () => {
      await expect(
        executeCode('throw new Error("test error")', 'javascript')
      ).rejects.toThrow(ValidationError);
    });

    it('executeCode unsupported language throws ValidationError', async () => {
      await expect(
        executeCode('console.log("test")', 'python' as 'javascript')
      ).rejects.toThrow(ValidationError);
    });

    it('executeCode does not have access to require', async () => {
      await expect(
        executeCode('require("fs")', 'javascript')
      ).rejects.toThrow(ValidationError);
    });

    it('executeCode does not have access to process', async () => {
      await expect(
        executeCode('process.exit(1)', 'javascript')
      ).rejects.toThrow(ValidationError);
    });

    it('cannot reach the host through the injected console (node:vm escape)', async () => {
      await expect(
        executeCode("console.log(typeof console.log.constructor('return process')())", 'javascript')
      ).rejects.toThrow(/'process' is not defined/);
      await expect(
        executeCode("console.log(typeof require, typeof globalThis.process)", 'javascript')
      ).resolves.toBe('undefined undefined');
    });

    it('formats logged values like the previous runner', async () => {
      await expect(
        executeCode('console.log(1, "a", null, undefined, { b: [2] })', 'javascript')
      ).resolves.toBe('1 a null undefined {"b":[2]}');
    });

    it('stops promise loops and memory bombs', async () => {
      await expect(
        executeCode('(async () => { for (;;) await null; })()', 'javascript', 500)
      ).rejects.toThrow(/timed out/);
      await expect(
        executeCode('const a = []; for (;;) a.push("x".repeat(1024));', 'javascript', 2000)
      ).rejects.toThrow(ValidationError);
    });

    it('does not block the event loop while running', async () => {
      let ticks = 0;
      const timer = setInterval(() => { ticks += 1; }, 50);
      await expect(executeCode('while(true) {}', 'javascript', 600)).rejects.toThrow(/timed out/);
      clearInterval(timer);
      expect(ticks).toBeGreaterThan(5);
    });
  });

  describe('transpileTS', () => {
    it('transpileTS converts TypeScript to JavaScript', () => {
      const js = transpileTS('const x: number = 5;');
      expect(js).toContain('x = 5');
    });

    it('transpileTS throws ValidationError on syntax error', () => {
      expect(() => transpileTS('const x: = 5')).toThrow(ValidationError);
    });
  });
});
