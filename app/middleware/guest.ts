export default defineNuxtRouteMiddleware(async () => {
  const auth = useAuth()
  try {
    await auth.refreshSession()
  }
  catch {
    // Keep the sign-in page usable when the upstream service is unavailable.
    return
  }
  if (auth.user.value) return navigateTo('/', { replace: true })
})
