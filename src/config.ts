import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: Number(process.env.PORT) || 3000,
  apiKey: process.env.BLUBASE_API_KEY || '',
  llm: {
    apiKey: process.env.AGENT_LLM_API_KEY || '',
    baseUrl: (process.env.AGENT_LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: process.env.AGENT_LLM_MODEL || 'gpt-4o-mini'
  },
  preload: {
    pocketbase: {
      url: process.env.POCKETBASE_URL || '',
      email: process.env.POCKETBASE_EMAIL || '',
      password: process.env.POCKETBASE_PASSWORD || '',
      token: process.env.POCKETBASE_TOKEN || ''
    },
    silobase: {
      url: process.env.SILOBASE_URL || '',
      email: process.env.SILOBASE_EMAIL || '',
      password: process.env.SILOBASE_PASSWORD || '',
      token: process.env.SILOBASE_TOKEN || ''
    },
    custom: {
      url: process.env.CUSTOM_BACKEND_URL || '',
      email: process.env.CUSTOM_BACKEND_EMAIL || '',
      password: process.env.CUSTOM_BACKEND_PASSWORD || '',
      token: process.env.CUSTOM_BACKEND_TOKEN || ''
    }
  }
};
