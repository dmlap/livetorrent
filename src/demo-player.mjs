/* global fetch, MediaSource, m3u8Parser */
import '../../node_modules/m3u8-parser/dist/m3u8-parser.js'
import LiveTorrent from './index.js'

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
let alot = 10
async function forever (task, wait) {
  while (alot--) {
    await task()
    await new Promise((resolve) => {
      setTimeout(resolve, wait)
    })
  }
}

// HLS manifest custom tag parser
function btAttrListParser (line) {
  const [tag, value] = line.split(':')
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

export default class DemoPlayer {
  constructor (video, srcUrl) {
    this._srcUrl = srcUrl
    this._video = video
    this._livetorrent = new LiveTorrent()
    this._fetches = Promise.resolve()
    this._segments = new Set()
    this._parser = new m3u8Parser.Parser()
    this._parser.addParser(MAP_PARSER)
    this._parser.addParser(SEGMENT_PARSER)

    this._setup()
  }

  async _setup () {
    const mediaSource = await attachMediaSource(this._video)
    const sourceBuffer = mediaSource.addSourceBuffer('video/mp4;codecs="mp4a.40.2,avc1.4d401e"')

    forever(async () => {
      const response = await fetch(this._srcUrl)
      if (!response.ok) {
        throw new Error(`Status ${response.statusCode} from "${this._srcUrl}": ${response.statusText}`)
      }
      this._parser.push(await response.text())
      this._parser.end()

      // order is important so that the appends happen in the right
      // sequence
      const files = [{
        hash: this._parser.manifest.custom.bt.hash,
        length: this._parser.manifest.custom.bt.length,
        uri: this._parser.manifest.segments[0].map.uri
      }].concat(this._parser.manifest.segments.map((segment) => {
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
          const response = await this._livetorrent.fetch(file.uri)
          if (!response.ok) {
            throw new Error(`Download failed for "${file.uri}"`)
          }
          const data = await response.arrayBuffer()

          console.log(`appending ${file.uri}, ${data.byteLength} bytes`)
          return append(sourceBuffer, data)
        })
      }

      const baseUrl = this._srcUrl.split('/').slice(0, -1).join('/')
      this._livetorrent.update(baseUrl, files)
    }, 500)
  }
}
