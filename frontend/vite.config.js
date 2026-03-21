import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  if (mode === 'development') {
    const env = loadEnv(mode, '..', '')
    if (!env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY in ../.env')
  }
  return {
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
      },
    },
  }
})
