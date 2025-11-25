/**
 * Handles OpenAI API errors, particularly ByteString conversion errors
 */

export function handleOpenAIError(error: any, context: string): Error {
    if (error instanceof Error) {
        // Handle common OpenAI client initialization errors
        if (error.message.includes('API key must be a string')) {
            return new Error(`Invalid API key format for ${context}. API key must be a valid string.`)
        }

        if (error.message.includes('ByteString')) {
            return new Error(`Invalid API key format for ${context}. API key contains invalid characters.`)
        }

        return error
    }

    return new Error(`Unknown error occurred while initializing ${context} client`)
}