'use strict'

const createCompress = require('compress-brotli')
const { resolve: urlResolve } = require('url')
const normalizeUrl = require('normalize-url')
const { parse } = require('querystring')
const prettyMs = require('pretty-ms')
const assert = require('assert')
const getEtag = require('etag')
const { URL } = require('url')
const Keyv = require('keyv')

const _getKey = req => {
  const url = urlResolve('http://localhost', req.url)
  const { origin } = new URL(url)
  const baseKey = normalizeUrl(url, {
    removeQueryParameters: [/^utm_\w+/i, 'force', 'filter', 'ref']
  })
  return baseKey.replace(origin, '').replace('/?', '')
}

const toSeconds = ms => Math.floor(ms / 1000)

const createSetHeaders = ({ revalidate }) => {
  return ({ res, createdAt, isHit, ttl, hasForce, etag }) => {
    // Specifies the maximum amount of time a resource
    // will be considered fresh in seconds
    const diff = hasForce ? 0 : createdAt + ttl - Date.now()
    const maxAge = toSeconds(diff)

    res.setHeader(
      'Cache-Control',
      `public, must-revalidate, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${
        hasForce ? 0 : toSeconds(revalidate(ttl))
      }`
    )

    res.setHeader('X-Cache-Status', isHit ? 'HIT' : 'MISS')
    res.setHeader('X-Cache-Expired-At', prettyMs(diff))
    res.setHeader('ETag', etag)
  }
}

module.exports = ({
  cache = new Keyv({ namespace: 'ssr' }),
  compress: enableCompression = false,
  getKey = _getKey,
  get,
  send,
  revalidate = ttl => ttl / 24,
  ttl: defaultTtl = 7200000,
  ...compressOpts
} = {}) => {
  assert(get, '.get required')
  assert(send, '.send required')

  const setHeaders = createSetHeaders({
    revalidate: typeof revalidate === 'function' ? revalidate : () => revalidate
  })

  const { serialize, compress, decompress } = createCompress({
    enable: enableCompression,
    ...compressOpts
  })

  return async ({ req, res, ...opts }) => {
    const hasForce = Boolean(
      req.query ? req.query.force : parse(req.url.split('?')[1]).force
    )
    const key = getKey(req)
    const cachedResult = await decompress(await cache.get(key))
    const isHit = !hasForce && cachedResult !== undefined

    const {
      etag: cachedEtag,
      ttl = defaultTtl,
      createdAt = Date.now(),
      data,
      ...props
    } = isHit ? cachedResult : await get({ req, res, ...opts })

    const etag = cachedEtag || getEtag(serialize(data))

    setHeaders({
      etag,
      res,
      createdAt,
      isHit,
      ttl,
      hasForce
    })

    if (!isHit) {
      const payload = { etag, createdAt, ttl, data, ...props }
      const value = await compress(payload)
      await cache.set(key, value, ttl)
    }

    send({ data, res, req, ...props })
  }
}

module.exports.getKey = _getKey
