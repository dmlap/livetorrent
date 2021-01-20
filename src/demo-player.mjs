/* eslint-env browser */
/* global m3u8Parser */

/*
   Demo Player: a (very simple) video player that uses LiveTorrent to
   load a live HLS stream. In real life, you probably want to
   integrate LiveTorrent with a more full-featured player like like
   VideoJS or hls.js.
*/

import '../../node_modules/m3u8-parser/dist/m3u8-parser.js'
import LiveTorrent from './index.js'

/**
 * Utility method for debugging.
 */
function hexdump (arrayBuffer) {
  const result = []
  const stride = 16
  for (let i = 0; i < arrayBuffer.byteLength; i += stride) {
    const rowLength = Math.min(arrayBuffer.byteLength - i, stride)
    const bytes = new Uint8Array(arrayBuffer, i, rowLength)

    const row = [i.toString(16).padStart(8, '0') + ':']
    for (let j = 0; j < rowLength - 2; j += 2) {
      row.push(bytes[j].toString(16).padStart(2, '0') + bytes[j + 1].toString(16).padStart(2, '0'))
    }
    if (rowLength % 2 === 0) {
      row.push(bytes[rowLength - 2].toString(16).padStart(2, '0') + bytes[rowLength - 1].toString(16).padStart(2, '0'))
    } else {
      row.push(bytes[rowLength - 1].toString(16).padStart(2, '0') + '  ')
    }
    result.push(row.join(' '))
  }
  return result.join('\n')
}

// --- Utiltity methods for working with Media Source Extensions ---
function attachMediaSource (videoEl) {
  return new Promise((resolve, reject) => {
    const mediaSource = new MediaSource()
    videoEl.src = URL.createObjectURL(mediaSource)
    mediaSource.addEventListener('sourceopen', () => {
      return resolve(mediaSource)
    })
  })
}
function one (emitter, type, listener) {
  function handle (event) {
    emitter.removeEventListener(type, handle)
    return listener(event)
  }
  emitter.addEventListener(type, handle)
}
function append (sourceBuffer, arrayBuffer) {
  return new Promise((resolve, reject) => {
    one(sourceBuffer, 'updateend', resolve)
    one(sourceBuffer, 'error', reject)

    sourceBuffer.appendBuffer(arrayBuffer)
  })
}
async function doWhile (task, test, wait) {
  do {
    await task()
    await new Promise((resolve) => {
      setTimeout(resolve, wait)
    })
  } while (await test())
}

// HLS manifest custom tag parser
function btAttrListParser (line) {
  const value = line.split(':')[1]
  const entries = value.split(',')
  const attrs = {}
  entries.forEach((entry) => {
    let [key, value] = entry.split('=')
    key = key.toLowerCase()
    if (key === 'hash') {
      value = value.slice(1, -1)
    } else if (key === 'length') {
      value = parseInt(value, 10)
    }
    attrs[key] = value
  })
  return attrs
}
const MAP_PARSER = {
  expression: /^#EXT-X-BT-MAP/,
  customType: 'bt',
  dataParser: btAttrListParser
}
const SEGMENT_PARSER = {
  expression: /^#EXT-X-BT/,
  customType: 'bt',
  segment: true,
  dataParser: btAttrListParser
}

export default class DemoPlayer extends EventTarget {
  constructor (video, srcUrl) {
    super()
    this._srcUrl = srcUrl
    this._video = video
    this.liveTorrent = new LiveTorrent(this._srcUrl.split('/').slice(0, -1).join('/'))
    this._fetches = Promise.resolve()
    this._segments = new Set()
    this._targetDuration = 6 / 3

    this._logicalTime = 0

    this._setup()
  }

  _redispatch (event) {
    return this.dispatchEvent(new Event(event.type, { original: event }))
  }

  async _setup () {
    const mediaSource = await attachMediaSource(this._video)
    const sourceBuffer = mediaSource.addSourceBuffer('video/mp4;codecs="mp4a.40.2,avc1.4d401e"')

    mediaSource.addEventListener('sourceopen', this._redispatch.bind(this))
    mediaSource.addEventListener('sourceended', this._redispatch.bind(this))
    mediaSource.addEventListener('sourceclose', this._redispatch.bind(this))

    doWhile(async () => {
      const response = await fetch(`example/live${this._logicalTime}.m3u8`) // this._srcUrl)
      this._logicalTime++

      if (!response.ok) {
        throw new Error(`Status ${response.statusCode} from "${this._srcUrl}": ${response.statusText}`)
      }
      const parser = new m3u8Parser.Parser()
      parser.addParser(MAP_PARSER)
      parser.addParser(SEGMENT_PARSER)
      parser.push(await response.text())
      parser.end()
      this._targetDuration = (parser.manifest.targetDuration / 2)

      // the segment fetches (and appends) must be correctly ordered
      const files = [{
        hash: parser.manifest.custom.bt.hash,
        length: parser.manifest.custom.bt.length,
        uri: parser.manifest.segments[0].map.uri
      }].concat(parser.manifest.segments.map((segment) => {
        return {
          hash: segment.custom.bt.hash,
          length: segment.custom.bt.length,
          uri: segment.uri
        }
      }))
      for (const file of files) {
        if (this._segments.has(file.uri)) {
          // we've already seen this file
          continue
        }
        this._segments.add(file.uri)
        this._fetches = this._fetches.then(async () => {
          const response = await this.liveTorrent.fetch(file.uri)
          if (!response.ok) {
            throw new Error(`Download failed for "${file.uri}"`)
          }
          const data = await response.arrayBuffer()
          console.log(file.uri + '\n' + hexdump(data).slice(0, (12 + 16 + 1) * 5))

          return append(sourceBuffer, data).then(() => {
            console.log(`appended ${data.byteLength} bytes of ${file.uri}`)
            this.dispatchEvent(new Event('progress'))
          })
        })
      }

      this.liveTorrent.update(files)
    }, () => {
      return this._logicalTime < 5
    }, this._targetDuration * 1000)
  }
}
