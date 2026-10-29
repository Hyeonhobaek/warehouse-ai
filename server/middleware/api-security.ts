import { defineEventHandler, getRequestURL } from 'h3'
import { preventCaching } from '../utils/request-security'

export default defineEventHandler((event) => {
  if (getRequestURL(event).pathname.startsWith('/api/')) preventCaching(event)
})
