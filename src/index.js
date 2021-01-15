/* global WebTorrent, Response */

const PIECE_LENGTH = Math.pow(2, 18)

export default class LiveTorrent {
  constructor () {
    this._webtorrent = new WebTorrent()
    this._ready = new Promise((resolve, reject) => {
      this._webtorrent.on('ready', resolve)
      this._webtorrent.on('error', reject)
      this._webtorrent.on('close', reject)
    })

    // FIXME prevent multiple updates to the webtorrent client while
    // figuring out how to bend it into shape
    this._done = false
  }

  update (baseUrl, files) {
    if (this._done) {
      return
    }

    const torrent = {
      // empty file SHA-1 hash
      infoHash: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
      comment: 'Live Torrent',
      urlList: [baseUrl],
      pieceLength: PIECE_LENGTH,
      lastPieceLength: PIECE_LENGTH,
      pieces: [],
      files: [],
      info: {
        name: baseUrl.split('/').slice(-1)[0]
      }
    }
    let offset = 0
    for (const file of files) {
      torrent.files.push({
        length: file.length,
        path: file.uri,
        name: file.uri,
        offset
      })
      offset += file.length
      const padLength = PIECE_LENGTH - (file.length % PIECE_LENGTH)
      if (padLength !== 0) {
        torrent.files.push({
          attr: 'p',
          length: padLength,
          path: '.pad/' + padLength,
          name: '' + padLength,
          offset
        })
        offset += padLength
      }
      torrent.pieces.push(file.hash)
    }
    torrent.info.files = torrent.files
    torrent.info['piece length'] = torrent.pieceLength
    torrent.info.pieces = new Uint8Array(torrent.pieces.join('').match(/[\da-f]{2}/gi).map((pair) => {
      return parseInt(pair, 16)
    }))

    this._webtorrent.add(torrent)
    this._done = true
  }

  async fetch (url, init) {
    await this._ready

    const file = this._webtorrent.torrents[0].files.find((file) => {
      return file.path === url
    })

    if (!file) {
      return Promise.resolve(new Response(null, {
        status: 404
      }))
    }
    return new Promise((resolve, reject) => {
      file.getBlob((error, blob) => {
        if (error) {
          return reject(error)
        }
        resolve(new Response(blob, { status: 200 }))
      })
    })
  }
}
