import { describe, it, expect } from 'vitest'
import { escapeControlChars } from '../escape-control-chars'

describe('escapeControlChars', () => {
  it('转义 ESC (0x1B) 为 ^[ 形式（cat -v 风格）', () => {
    // node-llama-cpp 构建进度条重绘时残留的控制序列：
    //   ESC[2K  清整行   ESC[1A  光标上移   ESC[G  回到行首
    //   ESC[32m 绿色前景  ESC[39m 默认前景
    const input =
      '\x1b[2K\x1b[1A\x1b[2K\x1b[G[node-llama-cpp] \x1b[32m✔\x1b[39m Cloned'
    const output = escapeControlChars(input)
    expect(output).toBe(
      '^[[2K^[[1A^[[2K^[[G[node-llama-cpp] ^[[32m✔^[[39m Cloned',
    )
    expect(output).not.toContain('\x1b')
  })

  it('保留 TAB (0x09)、LF (0x0A)、CR (0x0D)', () => {
    const input = 'before\tafter\nline2\rline3'
    expect(escapeControlChars(input)).toBe('before\tafter\nline2\rline3')
  })

  it('转义其它 C0 控制符为 ^X 形式', () => {
    expect(escapeControlChars('\x00')).toBe('^@')
    expect(escapeControlChars('\x01')).toBe('^A')
    expect(escapeControlChars('\x07')).toBe('^G') // BEL
    expect(escapeControlChars('\x08')).toBe('^H') // BS
    expect(escapeControlChars('\x0B')).toBe('^K') // VT
    expect(escapeControlChars('\x0C')).toBe('^L') // FF
    expect(escapeControlChars('\x0E')).toBe('^N') // SO
    expect(escapeControlChars('\x1F')).toBe('^_') // US
    expect(escapeControlChars('\x7F')).toBe('^?') // DEL
  })

  it('保留可打印 ASCII 与多字节 UTF-8 不变', () => {
    const input = 'Hello, 世界! こんにちは ☃ ✔ ✅'
    expect(escapeControlChars(input)).toBe(input)
  })

  it('空串 / 纯可打印串保持不变', () => {
    expect(escapeControlChars('')).toBe('')
    expect(escapeControlChars('plain text only')).toBe('plain text only')
  })

  it('行号前缀在转义后仍可被人类识别（核心场景）', () => {
    // 模拟 _formatOutput 输出的单行：`  N  <line text>`
    // 若 line text 开头是 ESC 序列，原版会让行号被清屏；转义后行号保留。
    const original = ' 432  \x1b[2K\x1b[1A\x1b[2K\x1b[G[hello]'
    const escaped = escapeControlChars(original)
    expect(escaped.startsWith(' 432  ')).toBe(true)
    expect(escaped).toBe(' 432  ^[[2K^[[1A^[[2K^[[G[hello]')
  })
})
