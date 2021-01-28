/* eslint-env browser */
/* global WebTorrent, Response */

/*
  LiveTorrent: live stream over BitTorrent. Use
  `LiveTorrent.prototype.fetch` as a drop-in replacement for the
  [Fetch API] in the video player or application of your choice.

  [Fetch Api]: https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API
*/

import PieceId from './piece-id.mjs'

const PIECE_LENGTH = Math.pow(2, 18)

function bufferToHex (arrayBuffer) {
  return [...new Uint8Array(arrayBuffer)].map((byte) => {
    return byte.toString(16).padStart(2, '0')
  }).join('')
}

const ZERO_BYTE_SHA = 'da39a3ee5e6b4b0d3255bfef95601890afd80709'
function buildParsedTorrent (baseUrl, files, infoHash) {
  infoHash = infoHash || ZERO_BYTE_SHA
  const torrent = {
    infoHash,
    announce: ['wss://tracker.btorrent.xyz/', 'wss://tracker.openwebtorrent.com'],
    comment: `LiveTorrent from "${baseUrl}"`,
    urlList: [],
    pieceLength: PIECE_LENGTH,
    lastPieceLength: PIECE_LENGTH,
    pieces: [],
    files: [],
    info: {
      name: baseUrl.split('/').slice(-1)[0]
    }
  }
  for (const file of files) {
    torrent.files.push({
      length: file.length,
      path: file.uri,
      name: file.uri,
      offset: 0
    })
    const padLength = PIECE_LENGTH - (file.length % PIECE_LENGTH)
    if (padLength !== 0) {
      torrent.files.push({
        attr: 'p',
        length: padLength,
        path: '.pad/' + padLength,
        name: '' + padLength,
        offset: padLength
      })
    }
    torrent.pieces.push(file.hash)
  }
  torrent.info.files = torrent.files
  torrent.info['piece length'] = torrent.pieceLength
  const hexBytes = torrent.pieces.join('').match(/[\da-f]{2}/gi) || []
  torrent.info.pieces = new Uint8Array(hexBytes.map((pair) => {
    return parseInt(pair, 16)
  }))
  return torrent
}

export default class LiveTorrent {
  constructor (baseUrl) {
    this._baseUrl = baseUrl
    this._webtorrent = new WebTorrent()

    this._knownHashes = new Set()
    this._torrent = null
    this._File = null
    this._Piece = null
    this._ready = new Promise((resolve, reject) => {
      this._webtorrent.on('torrent', (torrent) => {
        if (this._torrent) return

        this._torrent = torrent
        this._File = Object.getPrototypeOf(torrent.files[0]).constructor
        this._Piece = Object.getPrototypeOf(torrent.pieces.get(0)).constructor

        // clear out the phony file data
        torrent.files.splice(0, 2)
        torrent.pieces.delete(0)
        torrent.bitfield.delete(0)
        torrent._hashes.delete(0)
        torrent._reservations.delete(0)
        torrent.deselect(0, 0)

        torrent.addWebSeed(this._baseUrl)
        resolve()
      })
      this._webtorrent.on('error', reject)
      this._webtorrent.on('close', reject)
    })
  }

  /**
   * Setup a torrent that will be used for streaming.
   */
  async _createTorrent (files) {
    const infoHash = await (crypto.subtle.digest(
      'SHA-1', new TextEncoder().encode(this._baseUrl)
    ).then(bufferToHex))
    const parsedTorrent = buildParsedTorrent(this._baseUrl, [{
      name: 'phony',
      length: 1,
      uri: 'phony',
      hash: ''
    }], infoHash)

    this._webtorrent.add(parsedTorrent)
    await this._updateTorrent(files)
  }

  /**
   * Update torrent and web seeds with any files that aren't already
   * tracked by the torrent.
   */
  async _updateTorrent (files) {
    await this._ready

    // process & update metadata
    // TODO skipping this because it mutates the torrent object. It
    // would be good hygiene to update magnetURI and torrentFile
    // this._processParsedTorrent(parsedTorrent)
    // this.metadata = this.torrentFile

    const torrent = this._torrent
    const additions = new Map()
    files.forEach((file) => {
      const id = PieceId.toNumber(file.variant || 0, file.segment, 0)
      if (torrent.pieces.has(id)) {
        return
      }

      additions.set(id, file)

      // add content and padding files
      const padLength = PIECE_LENGTH - (file.length % PIECE_LENGTH)
      torrent.files.push(new this._File(torrent, {
        length: file.length,
        path: file.uri,
        name: file.uri,
        offset: id * PIECE_LENGTH
      }))
      if (padLength !== 0) {
        torrent.files.push(new this._File(torrent, {
          attr: 'p',
          length: padLength,
          path: '.pad/' + padLength,
          name: '' + padLength,
          offset: id * PIECE_LENGTH + file.length
        }))
      }
      // add hash
      torrent._hashes.set(id, file.hash)
      // add pieces and update reservations
      // use `ceil` because the pad file takes up the remainder of the
      // piece when necessary
      const pieceCount = Math.ceil(file.length / PIECE_LENGTH)
      for (let i = 0; i < pieceCount; i++) {
        torrent.pieces.set(id + i, new this._Piece(PIECE_LENGTH))
        torrent._reservations.set(id + i, [])
      }
    })
    if (additions.size === 0) {
      return
    }

    // update rarity map
    torrent._rarityMap.recalculate()

    // update the chunk store
    // this assumes the chunk store is `memory-chunk-store` (the
    // default in a browser)
    // at minimum, internal file information would have to be updated
    // to use the default for node.js, FSChunkStore
    // `torrent._store.length` is read-only (in Safari, at least)
    // because `_store` is a Function. Even though it is treated in
    // the constructor as a byte count, it appears safe to ignore
    // updating it.
    torrent._store.lastChunkLength = PIECE_LENGTH
    torrent._store.lastChunkIndex = PIECE_LENGTH - 1

    // update metadata on wires
    torrent.wires.forEach((wire) => {
      // If we didn't have the metadata at the time ut_metadata was initialized for this
      // wire, we still want to make it available to the peer in case they request it.
      if (wire.ut_metadata) wire.ut_metadata.setMetadata(torrent.metadata)

      if (wire.type === 'webSeed') {
        torrent.pieces.forEach((piece, id) => {
          wire.peerPieces.set(id, true)
        })
      }
    })

    // now that the torrent state is updated, trigger interest in the
    // new files
    additions.forEach((file, id) => {
      torrent.select(id, id)
    })
  }

  // ------------------
  // Torrent Management
  // ------------------

  async update (files) {
    if (!this._torrent) {
      return await this._createTorrent(files)
    } else {
      return await this._updateTorrent(files)
    }
  }

  async fetch (url, init) {
    await this._ready

    const file = this._torrent.files.find((file) => {
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

  // ----------
  // Statistics
  // ----------

  received () {
    return (this._torrent && this._torrent.received) || 0
  }

  downloaded () {
    return (this._torrent && this._torrent.downloaded) || 0
  }

  uploaded () {
    return (this._torrent && this._torrent.uploaded) || 0
  }

  downloadSpeed () {
    return (this._torrent && this._torrent.downloadSpeed) || 0
  }

  uploadSpeed () {
    return (this._torrent && this._torrent.uploadSpeed) || 0
  }

  ratio () {
    return (this._torrent && this._torrent.ratio) || 0
  }

  numPeers () {
    return (this._torrent && this._torrent.numPeers) || 0
  }
}
