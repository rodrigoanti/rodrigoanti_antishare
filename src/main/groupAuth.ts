import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto'

/** Header carrying `<deviceId>.<timestamp>.<hmac>`; the password itself never travels. */
export const GROUP_AUTH_HEADER = 'x-group-auth'
/** Signed requests older/newer than this are rejected (clock skew + replay window). */
const MAX_SKEW_MS = 5 * 60_000

/** 32-byte group key (hex) from the password; salted with the group id so equal passwords differ. */
export function deriveGroupKey(groupId: string, password: string): string {
  return scryptSync(password, `antishare-group:${groupId}`, 32).toString('hex')
}

export function newGroupId(): string {
  return randomBytes(9).toString('hex')
}

function mac(key: string, method: string, pathAndQuery: string, ts: string): string {
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`${method.toUpperCase()}\n${pathAndQuery}\n${ts}`)
    .digest('hex')
}

export function signGroupRequest(
  key: string,
  deviceId: string,
  method: string,
  pathAndQuery: string
): Record<string, string> {
  const ts = String(Date.now())
  return { 'X-Group-Auth': `${deviceId}.${ts}.${mac(key, method, pathAndQuery, ts)}` }
}

/** Device id of a request signed with `key`, or null when the signature does not match. */
export function verifyGroupRequest(
  header: string | string[] | undefined,
  key: string,
  method: string,
  pathAndQuery: string
): string | null {
  if (typeof header !== 'string') return null
  const [deviceId, ts, sig] = header.split('.')
  if (!deviceId || !ts || !sig || !/^[0-9a-f]{64}$/.test(sig)) return null
  const at = Number(ts)
  if (!Number.isFinite(at) || Math.abs(Date.now() - at) > MAX_SKEW_MS) return null
  const want = Buffer.from(mac(key, method, pathAndQuery, ts), 'hex')
  return timingSafeEqual(Buffer.from(sig, 'hex'), want) ? deviceId : null
}
