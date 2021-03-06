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

const debug = false

export default class DemoPlayer extends EventTarget {
  constructor (video, srcUrl) {
    super()
    this._srcUrl = srcUrl
    this._video = video
    this.liveTorrent = new LiveTorrent(this._srcUrl.split('/').slice(0, -1).join('/'))
    this._fetches = Promise.resolve()
    this._segments = new Set()
    this._targetDuration = 6 / 3

    this._setup()
  }

  _redispatch (event) {
    return this.dispatchEvent(new Event(event.type, { original: event }))
  }

  async _setup () {
    this._video.addEventListener('progress', () => {
      const video = this._video
      const bufferLength = video.buffered.length
      if (bufferLength > 0 &&
          video.currentTime < video.buffered.start(bufferLength - 1)) {
        // seek to the last buffered range so gaps in media don't
        // stall the player forever
        console.log(`setting start time to ${this._video.buffered.start(bufferLength - 1)}`)
        video.currentTime = video.buffered.start(bufferLength - 1)
      }
    })

    const mediaSource = await attachMediaSource(this._video)
    const sourceBuffer = mediaSource.addSourceBuffer('video/mp4;codecs="mp4a.40.2,avc1.4d401e"')

    mediaSource.addEventListener('sourceopen', this._redispatch.bind(this))
    mediaSource.addEventListener('sourceended', this._redispatch.bind(this))
    mediaSource.addEventListener('sourceclose', this._redispatch.bind(this))

    doWhile(async () => {
      const response = await fetch(this._srcUrl)

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
        uri: parser.manifest.segments[0].map.uri,

        variant: 0, // optional, defaults to 0
        segment: 0
      }].concat(parser.manifest.segments.map((segment, index) => {
        return {
          hash: segment.custom.bt.hash,
          length: segment.custom.bt.length,
          uri: segment.uri,

          segment: parser.manifest.mediaSequence + index + 1
        }
      }))

      await this.liveTorrent.update(files)

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
          debug && console.log(
            file.uri + '\n%c' +
              hexdump(data).split('\n').slice(0, 3).join('\n'),
            'font-family: monospace'
          )

          return append(sourceBuffer, data).then(() => {
            debug && console.log(`Appended ${data.byteLength} bytes of ${file.uri}`)
            this.dispatchEvent(new Event('progress'))
          })
        })
      }
    }, () => {
      return true
    }, this._targetDuration * 1000)
  }
}
