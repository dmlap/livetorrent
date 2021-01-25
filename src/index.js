/* global WebTorrent, Response */

/*
  LiveTorrent: live stream over BitTorrent. Use
  `LiveTorrent.prototype.fetch` as a drop-in replacement for the
  [Fetch API] in the video player or application of your choice.

  [Fetch Api]: https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API
*/

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
    const updateIx = files.findIndex((file) => {
      return !this._knownHashes.has(file.hash)
    })
    const parsedTorrent = buildParsedTorrent(
      this._baseUrl, files.slice(updateIx)
    )
    const additions = parsedTorrent.files
    if (additions.length === 0) {
      return
    }
    let offset = torrent.pieceLength * (torrent.pieces.size - 1) + torrent.lastPieceLength
    for (const addition of additions) {
      // update the file offsets to append the additions to the end of
      // the torrent
      addition.offset = offset
      offset += addition.length
      // append the content and padding files
      torrent.files.push(new this._File(torrent, addition))
    }
    for (let i = updateIx; i < files.length; i++) {
      // register the padded hash so it isn't added again
      this._knownHashes.add(files[i].hash)
      // add the new hashes to the torrent
      torrent._hashes.set(torrent._hashes.size, files[i].hash)
    }

    // update rarity map
    torrent._rarityMap.recalculate()

    // update the chunk store
    // this assumes the chunk store is `memory-chunk-store` (the
    // default in a browser)
    // at minimum, internal file information would have to be updated
    // to use the default for node.js, FSChunkStore
    const lastFile = additions.slice(-1)[0]
    // `torrent._store.length` is read-only (in Safari, at least)
    // because `_store` is a Function. Even though it is treated in
    // the constructor as a byte count, it appears safe to ignore
    // updating it.
    torrent._store.lastChunkLength = Math.min(lastFile.length, PIECE_LENGTH)
    torrent._store.lastChunkIndex =
      Math.ceil((lastFile.offset + lastFile.length) / PIECE_LENGTH) - 1

    // add new pieces
    for (const piece of parsedTorrent.pieces) {
      torrent.pieces.set(torrent.pieces.size, new this._Piece(PIECE_LENGTH))
    }

    // update metadata on wires
    torrent.wires.forEach((wire) => {
      // If we didn't have the metadata at the time ut_metadata was initialized for this
      // wire, we still want to make it available to the peer in case they request it.
      if (wire.ut_metadata) wire.ut_metadata.setMetadata(torrent.metadata)

      if (wire.type === 'webSeed') {
        for (const index of torrent.pieces.keys()) {
          wire.peerPieces.set(index, true)
        }
      }
    })

    // now that the torrent state is updated, trigger interest in the
    // new files
    for (let i = torrent.files.length - additions.length; i < torrent.files.length; i++) {
      // add new files to selection list
      if (!torrent.so || torrent.so.includes(i)) {
        torrent.files[i].select()
      } else {
        torrent.files[i].deselect()
      }
      // update reservations
      torrent._reservations.set(i, [])
    }
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
