import fetch from 'cross-fetch'
import seghash from './seghash.mjs'
import { URL } from 'url'
import fs from 'fs'
import path from 'path'

function uriFromMapTag (tag) {
  const match = (/^#EXT-X-MAP:(.*)$/).exec(tag)
  if (!match || !match[1]) {
    return
  }
  for (const attr of match[1].split(',')) {
    const [name, value] = attr.split('=')
    if (name.toLowerCase() === 'uri') {
      return value.slice(1, -1)
    }
  }
}

export default class BTM3U8 {
  constructor (hasher, base, local = true) {
    this._hasher = hasher || this._seghash
    this._base = base || process.cwd()
    if (local) {
      this.fetchSegment = this._fetchLocal
    } else {
      this.fetchSegment = this._fetchRemote
    }
  }

  async _seghash (line, segmentUrl, tag = '#EXT-X-BT') {
    const byteStream = await this.fetchSegment(segmentUrl)
    const { hash, length } = await seghash(byteStream)
    return [
      line,
      `${tag}:HASH="${hash}",LENGTH=${length}`
    ]
  }

  async * _line (stream) {
    const decoder = new TextDecoder()
    let line = ''
    for await (const bytes of stream) {
      let data = decoder.decode(bytes).replace(/\r/g, '')
      for (
        let newlineIx = data.indexOf('\n');
        newlineIx >= 0;
        newlineIx = data.indexOf('\n')
      ) {
        yield line + data.slice(0, newlineIx)
        line = ''
        data = data.slice(newlineIx + 1)
      }
      line += data
    }
    if (line.length > 0) {
      yield line
    }
  }

  async * _lookahead (lines) {
    const iterator = lines[Symbol.asyncIterator]()
    let next = await iterator.next()
    if (next.done) {
      // no lines to process
      return
    }
    yield [undefined, next.value]

    let current
    while (!next.done) {
      current = next
      next = await iterator.next()
      yield [current.value, next.value]
    }
  }

  async * transform (m3u8Stream) {
    const lines = this._line(m3u8Stream)
    for await (const [current, next] of this._lookahead(lines)) {
      if (next) {
        if (next[0] !== '#') {
          // next is a segment URL
          for (const hashed of await this._hasher(current, next)) {
            yield hashed
          }
          continue
        }
        const mapUrl = uriFromMapTag(next)
        if (mapUrl) {
          // next is a MAP segment tag
          for (const hashed of await this._hasher(current, mapUrl, '#EXT-X-BT-MAP')) {
            yield hashed
          }
          continue
        }
      }
      if (current) {
        yield current
      }
    }
  }

  async _fetchLocal (segmentPath) {
    return fs.createReadStream(path.resolve(this._base, segmentPath))
  }

  async _fetchRemote (url) {
    const requestUrl = new URL(url, this._base).href
    const response = await fetch(requestUrl)
    if (!response.ok) {
      throw new Error(`Failed fetching segment at"${requestUrl}"`)
    }
    return await response.body()
  }

  async fetchSegment () {
    throw new Error('fetchSegment stub')
  }
}
