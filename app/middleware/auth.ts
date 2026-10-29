export default defineNuxtRouteMiddleware(async () => {
  const auth = useAuth()
  try {
    await auth.refreshSession()
  }
  catch {
    return navigateTo('/login', { replace: true })
  }
  if (!auth.user.value) return navigateTo('/login', { replace: true })
})
