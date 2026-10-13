const MAX_FRAME = 3 * 1024 * 1024
const PATH = '/api/client-modules/device-media'

/** Fixed same-origin route, bounded whole-frame decoding, no hardware effects or reconnect replay. */
export function createMediaPlayer({
  origin,
  rowId,
  sessionId,
  deviceId,
  configRevision,
  bindingRevision,
  ticket,
  valid,
  canvas,
  state,
  error = () => {},
  socket = (url) => new WebSocket(url),
  decode = (blob) => createImageBitmap(blob),
}) {
  let stopped = false
  let peer
  let timer
  let frameTimer
  let metadata = null
  let newest = null
  let decoding = false
  let authorized = false
  let renewing = false
  let rowRevision
  let leaseUntil = 0
  let stage = 'videoTicketError'
  const live = () => !stopped && valid()
  const close = () => {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    clearTimeout(frameTimer)
    newest = null
    metadata = null
    if (peer) {
      peer.onopen = peer.onmessage = peer.onerror = peer.onclose = null
      peer.close()
    }
    canvas.width = canvas.height = 0
  }
  const fail = () => {
    if (!stopped) {
      close()
      error(stage)
      state('videoError')
    }
  }
  const mint = async (attempt = 0) => {
    let value
    try {
      value = await ticket({ configRevision, bindingRevision })
    } catch (cause) {
      // Retry only read-only ticket failures inside the existing lease. Invalid
      // grants and server socket revocation remain terminal; no effects replay.
      if (!live() || !renewing || attempt >= 2 || leaseUntil - performance.now() <= 1000) throw cause
      await new Promise((resolve) => setTimeout(resolve, 1000))
      if (!live() || performance.now() >= leaseUntil) throw cause
      return mint(attempt + 1)
    }
    if (!live()) throw new Error('Media owner changed')
    if (
      !value ||
      typeof value.ticket !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.ticket) ||
      value.expiresInMs !== 30000 ||
      value.deviceId !== deviceId ||
      value.configRevision !== configRevision ||
      value.bindingRevision !== bindingRevision ||
      typeof value.rowRevision !== 'string' ||
      !value.rowRevision ||
      (rowRevision && rowRevision !== value.rowRevision)
    )
      throw new Error('Invalid media ticket')
    rowRevision = value.rowRevision
    return value.ticket
  }
  const renew = () => {
    if (!live() || renewing || !authorized) return fail()
    renewing = true
    authorized = false
    stage = 'videoRenewalError'
    // Renewal can wait while the current server-granted lease remains valid.
    // A slow read-only ticket request must not discard an otherwise live stream.
    timer = setTimeout(fail, Math.max(1, leaseUntil - performance.now()))
    void mint()
      .then((value) => {
        if (!live() || peer.readyState !== 1) return fail()
        peer.send(JSON.stringify({ type: 'renew', ticket: value }))
      })
      .catch(fail)
  }
  const paint = async () => {
    if (decoding || !newest || !live()) return
    decoding = true
    const frame = newest
    newest = null
    let bitmap
    try {
      bitmap = await decode(new Blob([frame.bytes], { type: 'image/jpeg' }))
      if (!live()) return
      if (bitmap.width !== frame.meta.width || bitmap.height !== frame.meta.height)
        throw new Error('Decoded dimensions changed')
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas unavailable')
      // Resizing clears the backing buffer; keep it when the stream dimensions are unchanged.
      if (canvas.width !== bitmap.width) canvas.width = bitmap.width
      if (canvas.height !== bitmap.height) canvas.height = bitmap.height
      context.drawImage(bitmap, 0, 0)
      state('videoLive')
    } catch {
      stage = 'videoDecodeError'
      fail()
    } finally {
      bitmap?.close()
      decoding = false
      if (live() && newest) void paint()
    }
  }
  const receive = (event) => {
    if (!live()) return close()
    try {
      if (typeof event.data === 'string') {
        if (event.data.length > 1024 || metadata) throw new Error('Invalid metadata')
        const value = JSON.parse(event.data)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid message')
        if (value.type === 'authorized') {
          if (
            authorized ||
            value.leaseMs !== 60000 ||
            Object.keys(value).some((key) => !['type', 'leaseMs'].includes(key))
          )
            throw new Error('Invalid lease')
          clearTimeout(timer)
          authorized = true
          renewing = false
          stage = 'videoFrameError'
          leaseUntil = performance.now() + value.leaseMs
          timer = setTimeout(renew, 30000)
          if (!frameTimer) frameTimer = setTimeout(fail, 5000)
          return
        }
        if (
          (!authorized && !renewing) ||
          value.type !== 'frame' ||
          Object.keys(value).some(
            (key) => !['type', 'id', 'width', 'height', 'byteLength', 'timeBasis', 'ageMs'].includes(key),
          ) ||
          typeof value.id !== 'string' ||
          !value.id ||
          value.id.length > 256 ||
          !Number.isSafeInteger(value.width) ||
          value.width < 1 ||
          value.width > 4096 ||
          !Number.isSafeInteger(value.height) ||
          value.height < 1 ||
          value.height > 4096 ||
          value.width * value.height > 16000000 ||
          !Number.isSafeInteger(value.byteLength) ||
          value.byteLength < 4 ||
          value.byteLength > MAX_FRAME ||
          value.timeBasis !== 'bridge_receive' ||
          !Number.isFinite(value.ageMs) ||
          value.ageMs < 0
        )
          throw new Error('Invalid frame')
        metadata = value
      } else {
        if (
          !(event.data instanceof ArrayBuffer) ||
          !metadata ||
          event.data.byteLength !== metadata.byteLength
        )
          throw new Error('Unpaired frame')
        const bytes = new Uint8Array(event.data)
        if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)
          throw new Error('Invalid JPEG')
        newest = { bytes: event.data, meta: metadata }
        metadata = null
        clearTimeout(frameTimer)
        frameTimer = setTimeout(fail, 5000)
        void paint()
      }
    } catch {
      stage = 'videoFrameFormatError'
      fail()
    }
  }
  state('videoWaiting')
  const start = async () => {
    try {
      timer = setTimeout(fail, 15000)
      const url = new URL(origin)
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
        throw new Error('Invalid media origin')
      const value = await mint()
      if (!live()) return close()
      clearTimeout(timer)
      stage = 'videoChannelError'
      timer = setTimeout(fail, 15000)
      url.pathname = PATH
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      peer = socket(url.href)
      peer.binaryType = 'arraybuffer'
      peer.onopen = () => {
        if (!live()) return close()
        peer.send(JSON.stringify({ type: 'auth', rowId, sessionId, ticket: value }))
      }
      peer.onmessage = receive
      peer.onerror = peer.onclose = () => {
        stage = renewing ? 'videoRenewalError' : 'videoChannelError'
        fail()
      }
    } catch {
      fail()
    }
  }
  void start()
  return close
}
