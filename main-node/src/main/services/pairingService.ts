import { config } from '../config'

export interface PairingPayload {
  location_id: string
  cloud_api_key: string
  cloud_base_url: string
  leader_host: string
  leader_port: number
  expires_at: string
}

export const pairingService = {
  generateCode(leaderHost: string): string {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 minutes expiration
    const payload: PairingPayload = {
      location_id: config.locationId,
      cloud_api_key: config.cloudApiKey,
      cloud_base_url: config.cloudBaseUrl,
      leader_host: leaderHost,
      leader_port: config.localApiPort,
      expires_at: expiresAt,
    }
    const jsonStr = JSON.stringify(payload)
    return Buffer.from(jsonStr).toString('base64')
  },

  decodeCode(code: string): PairingPayload {
    try {
      const decodedStr = Buffer.from(code, 'base64').toString('utf-8')
      const payload = JSON.parse(decodedStr) as PairingPayload
      if (!payload.location_id || !payload.cloud_api_key || !payload.leader_host) {
        throw new Error('Invalid pairing code payload structure')
      }
      const now = new Date()
      const expires = new Date(payload.expires_at)
      if (expires < now) {
        throw new Error('Pairing code has expired')
      }
      return payload
    } catch (err: any) {
      throw new Error(`Failed to decode pairing code: ${err.message}`)
    }
  }
}
