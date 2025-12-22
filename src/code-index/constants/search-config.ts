export const SEARCH_CONFIG = {
  // Limit配置
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 50,
  MIN_LIMIT: 1,
  
  // MinScore配置
  DEFAULT_MIN_SCORE: 0.4,
  MIN_MIN_SCORE: 0,
  MAX_MIN_SCORE: 1
} as const

// 导出类型
export type SearchLimits = {
  DEFAULT_LIMIT: number
  MAX_LIMIT: number
  MIN_LIMIT: number
}

export type SearchMinScore = {
  DEFAULT_MIN_SCORE: number
  MIN_MIN_SCORE: number
  MAX_MIN_SCORE: number
}
