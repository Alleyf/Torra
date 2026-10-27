import { protocol } from 'electron'
import {
  TORRA_UI_FRAME_SCHEME,
  torraUiFrameResponse,
} from '../../shared/ui-frame'

export function registerTorraUiScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: TORRA_UI_FRAME_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ])
}

export function installTorraUiProtocol(): void {
  protocol.handle(TORRA_UI_FRAME_SCHEME, (request) => {
    if (request.method !== 'GET') {
      return new Response('Method not allowed', {
        status: 405,
        headers: {
          Allow: 'GET',
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
        },
      })
    }
    return torraUiFrameResponse(request.url)
  })
}
