import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  bearerFromHeader,
  isLocalAuthConfigured,
  roleAllowed,
  verifyStaffToken,
  type AuthSuccess,
} from '../../services/localAuthService'

declare module 'fastify' {
  interface FastifyRequest {
    staff?: AuthSuccess
  }
}

/**
 * Build a Fastify preHandler that requires a valid staff "shift" JWT and,
 * optionally, one of a set of roles.
 *
 * Rollout safety: if the device has not yet been provisioned with staff-auth
 * material (legacy node, secret not fetched), the gate logs once and allows the
 * request so existing deployments keep working until they pick up the secret.
 * Once the secret is present, the token is strictly enforced.
 */
export function requireStaffAuth(allowedRoles?: readonly string[]) {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!isLocalAuthConfigured()) {
      if (!warnedOnce) {
        console.warn(
          '[Auth] Staff token verification is OFF — device has no jwt_secret yet. ' +
            'Re-open the Setup Wizard or wait for the boot sync to fetch it.',
        )
        warnedOnce = true
      }
      return
    }

    const token = bearerFromHeader(req.headers['authorization'])
    if (!token) {
      reply.status(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'Missing staff bearer token' },
      })
      return
    }

    const result = verifyStaffToken(token)
    if (!result.valid) {
      // 401 for expired/invalid so the client knows to refresh (online);
      // a fresh login or /auth/staff-token/ call mints a new token.
      reply.status(401).send({
        error: { code: 'UNAUTHENTICATED', message: result.reason },
      })
      return
    }

    if (allowedRoles && !roleAllowed(result.role, allowedRoles)) {
      reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: `Role "${result.role}" is not permitted to perform this action`,
        },
      })
      return
    }

    req.staff = result
  }
}

let warnedOnce = false
