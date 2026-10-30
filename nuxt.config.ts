export default defineNuxtConfig({
  compatibilityDate: '2026-10-29',
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  devtools: { enabled: false },
  typescript: { strict: true },
  // This application uses a server-only Supabase client. Nothing goes in public.
  runtimeConfig: {
    supabaseUrl: '',
    supabasePublishableKey: '',
  },
  colorMode: { preference: 'light', fallback: 'light' },
  ui: { fonts: false },
  icon: { serverBundle: { collections: ['lucide'] } },
  app: {
    head: {
      htmlAttrs: { lang: 'ko' },
      title: 'Warehouse AI | 원료 재고관리',
      meta: [{ name: 'description', content: '제약 원료·자재 재고관리를 위한 Warehouse AI 관리자 시스템' }],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
  routeRules: {
    '/': { headers: { 'cache-control': 'private, no-store' } },
    '/login': { headers: { 'cache-control': 'private, no-store' } },
    '/materials': { headers: { 'cache-control': 'private, no-store' } },
    '/materials/**': { headers: { 'cache-control': 'private, no-store' } },
    '/inventory': { headers: { 'cache-control': 'private, no-store' } },
    '/warehouses': { headers: { 'cache-control': 'private, no-store' } },
    '/api/**': { headers: { 'cache-control': 'private, no-store' } },
  },
})
