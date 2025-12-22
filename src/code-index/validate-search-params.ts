import { SEARCH_CONFIG } from './constants/search-config'

// ========== Limit验证 ==========
export function validateLimit(limit: any): number {
  const n = Number(limit)
  
  // 处理非数字、无穷大、负数和0
  if (!Number.isFinite(n) || n <= 0) {
    return SEARCH_CONFIG.DEFAULT_LIMIT
  }
  
  // 截断小数，确保正整数
  const intLimit = Math.trunc(n)
  
  // 修复：(0,1)小数截断后为0，需回退默认
  if (intLimit <= 0) {
    return SEARCH_CONFIG.DEFAULT_LIMIT
  }
  
  // 限制最大值
  return Math.min(intLimit, SEARCH_CONFIG.MAX_LIMIT)
}

// ========== MinScore验证 ==========
export function validateMinScore(score: any): number {
  // 特别处理null/undefined，避免Number(null)=0的陷阱
  if (score === null || score === undefined) {
    return SEARCH_CONFIG.DEFAULT_MIN_SCORE
  }
  
  const n = Number(score)
  
  // 处理非数字、无穷大
  if (!Number.isFinite(n)) {
    return SEARCH_CONFIG.DEFAULT_MIN_SCORE
  }
  
  // 限制在[0,1]范围内
  const clampedScore = Math.max(SEARCH_CONFIG.MIN_MIN_SCORE, Math.min(SEARCH_CONFIG.MAX_MIN_SCORE, n))
  
  return clampedScore
}
