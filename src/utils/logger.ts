/**
 * Logger
 * Simple console wrapper with log levels and formatting
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LoggerOptions {
  /** Logger name (shown in log prefix) */
  name?: string
  /** Minimum log level */
  level?: LogLevel
  /** Show timestamps */
  timestamps?: boolean
  /** Use colors (auto-detected if not specified) */
  colors?: boolean
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
}

const COLOR_CODES: Record<LogLevel | 'reset', string> = {
  debug: '\x1b[36m', // Cyan
  info: '\x1b[32m',  // Green
  warn: '\x1b[33m',  // Yellow
  error: '\x1b[31m', // Red
  reset: '\x1b[0m'   // Reset
}

export class Logger {
  private name: string
  private level: LogLevel
  private timestamps: boolean
  private colors: boolean

  constructor(options: LoggerOptions = {}) {
    this.name = options.name || ''
    this.level = options.level || 'info'
    this.timestamps = options.timestamps !== false
    this.colors = options.colors ?? (typeof process !== 'undefined' && process.stdout?.isTTY === true)
  }

  /**
   * Log debug message
   */
  debug(message: string, ...args: any[]): void {
    this.log('debug', message, ...args)
  }

  /**
   * Log info message
   */
  info(message: string, ...args: any[]): void {
    this.log('info', message, ...args)
  }

  /**
   * Log warning message
   */
  warn(message: string, ...args: any[]): void {
    this.log('warn', message, ...args)
  }

  /**
   * Log error message
   */
  error(message: string, ...args: any[]): void {
    this.log('error', message, ...args)
  }

  /**
   * Internal log method
   */
  private log(level: LogLevel, message: string, ...args: any[]): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) {
      return
    }

    const parts: string[] = []

    if (this.timestamps) {
      parts.push(`[${new Date().toISOString()}]`)
    }

    parts.push(level.toUpperCase().padEnd(5))

    if (this.name) {
      parts.push(`[${this.name}]`)
    }

    parts.push(message)

    let logMessage = parts.join(' ')

    if (this.colors) {
      logMessage = `${COLOR_CODES[level]}${logMessage}${COLOR_CODES.reset}`
    }

    switch (level) {
      case 'debug':
        console.debug(logMessage, ...args)
        break
      case 'info':
        console.info(logMessage, ...args)
        break
      case 'warn':
        console.warn(logMessage, ...args)
        break
      case 'error':
        console.error(logMessage, ...args)
        break
    }
  }

  /**
   * Set the logging level
   */
  setLevel(level: LogLevel): void {
    this.level = level
  }

  /**
   * Get the current logging level
   */
  getLevel(): LogLevel {
    return this.level
  }

  /**
   * Create a child logger with a different name
   */
  child(name: string): Logger {
    const childName = this.name ? `${this.name}:${name}` : name
    return new Logger({
      name: childName,
      level: this.level,
      timestamps: this.timestamps,
      colors: this.colors
    })
  }
}

/**
 * Create a logger instance
 */
export function createLogger(options?: LoggerOptions): Logger {
  return new Logger(options)
}

/**
 * Create a logger instance with a name
 */
export function createNamedLogger(name: string, level?: LogLevel): Logger {
  return new Logger({ name, level })
}

/**
 * Global logger instance (singleton)
 */
let globalLogger: Logger | null = null

export function getGlobalLogger(): Logger {
  if (!globalLogger) {
    globalLogger = new Logger({ name: 'App' })
  }
  return globalLogger
}

export function setGlobalLogger(logger: Logger): void {
  globalLogger = logger
}
